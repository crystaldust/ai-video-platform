// 生成任务页的数据：已确认的确认单摘要、选中那张的任务按角色 × 视图 / 关键帧按集 / 视频按集分组、单个任务的详情；
// 全貌付费卡片的进度。只读查询，库函数之上的薄组装。图片和视频本身走素材接口（media-route.ts），这里只给素材 id。
import type { DatabaseSync } from 'node:sqlite';
import { VIEW_ORDER, type CharacterView } from '../../generate/prompts.ts';
import { spentOf } from '../../generate/runner.ts';
import { TASK_STATUSES, type TaskStatus } from '../../generate/state-machine.ts';
import { listOf } from '../../executor/recipe-kit.ts';
import type { Project } from '../../project.ts';
import { candidateOfTask } from '../../repo/candidates.ts';
import { listPaidGates, type PaidGateRow } from '../../repo/paid-gates.ts';
import { getTask, listTasks, taskEvents, type PaidNode, type TaskEventRow, type TaskRow } from '../../repo/tasks.ts';
import { previewGeneration } from '../../generate/planner.ts';
import type { PriceSources } from '../../pricing/prices.ts';
import type { GenerationFailure, JobInfo } from '../jobs.ts';
import { HttpError } from '../http.ts';
import { docOf, episodesIn } from './common.ts';

export interface TaskCard {
  readonly id: number;
  readonly node: PaidNode | null;
  readonly label: string | null;
  readonly episodeKey: string | null;
  readonly status: TaskStatus;
  readonly costEstimate: number | null;
  readonly costActual: number | null;
  readonly error: string | null;
  readonly mediaId: number | null;
  readonly mime: string | null;
  readonly gateId: number | null;
  readonly attemptOf: number | null;
  /** 关键帧、视频段在分镜里的位置（S2-1 = 第 2 段第 1 切）和画面说明；角色视图为 null */
  readonly code: string | null;
  readonly caption: string | null;
}

/** 视图格子：这张确认单的任务；没有就看以前有没有出过（被去重跳过、沿用的那张）。 */
export interface ViewCell {
  readonly view: CharacterView;
  readonly task: TaskCard | null;
  readonly reuseOf: TaskCard | null;
}

export interface GateSummary {
  readonly id: number;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly selection: unknown;
  readonly cap: number | null;
  readonly spent: number;
  readonly total: number;
  readonly counts: Readonly<Record<TaskStatus, number>>;
  readonly running: boolean;
  /** 为什么没出图：最近一次生成失败的原因，或者（一条任务都没建时）现在计划会报的错；正常为 null */
  readonly error: string | null;
  /** 一条任务都没建、能计划出来时开跑会建几条：> 0 是「待开始」，0 是同样的输入都生成过了；其余为 null */
  readonly toCreate: number | null;
}

export interface TasksView {
  readonly gates: readonly GateSummary[];
  readonly gate: GateSummary | null;
  readonly characters: readonly { readonly id: string; readonly name: string; readonly views: readonly ViewCell[] }[];
  readonly keyframes: readonly { readonly episode: string; readonly ep: number | null; readonly rows: readonly TaskCard[] }[];
  readonly videos: readonly { readonly episode: string; readonly ep: number | null; readonly rows: readonly TaskCard[] }[];
}

export interface TaskDetail extends TaskCard {
  readonly provider: string;
  readonly model: string;
  readonly providerTaskId: string | null;
  readonly size: string | null;
  readonly prompt: string | null;
  readonly negativePrompt: string | null;
  /** 实际发出去的提示词和计划的不一样 */
  readonly planDiffers: boolean;
  /** 参考图（依赖）：已入库的那条任务 */
  readonly refs: readonly { readonly key: string; readonly task: TaskCard | null }[];
  readonly events: readonly TaskEventRow[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GenerationProgress {
  readonly gateId: number;
  readonly running: boolean;
  /** 同 GateSummary.error */
  readonly error: string | null;
  /** 同 GateSummary.toCreate */
  readonly toCreate: number | null;
  /** 这张确认单勾了的付费节点（勾了整个节点，或者至少一集） */
  readonly selected: readonly PaidNode[];
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly spent: number;
  readonly cap: number | null;
  readonly byNode: readonly { readonly node: PaidNode; readonly total: number; readonly done: number; readonly failed: number }[];
}

/** 失败一类：失败、被拒、结果未知（要人看） */
const FAILED: ReadonlySet<TaskStatus> = new Set(['failed', 'rejected', 'unknown']);
const PAID: readonly PaidNode[] = ['image:character-refs', 'image:keyframe', 'video:segment'];

type Place = { readonly code: string; readonly caption: string };

/** 分镜里每切、每段的位置与画面说明（切取 frame，段取开场站位 blocking），按 id 查。 */
function storyboardPlaces(db: DatabaseSync): Map<string, Place> {
  const places = new Map<string, Place>();
  for (const ep of episodesIn(docOf(db, 'storyboard'))) {
    listOf(ep, 'segments').forEach((seg, i) => {
      const cuts = listOf(seg, 'cuts');
      places.set(String(seg['id']), { code: `S${i + 1}`, caption: String(seg['blocking'] ?? cuts[0]?.['frame'] ?? '') });
      cuts.forEach((cut, j) => places.set(String(cut['id']), { code: `S${i + 1}-${j + 1}`, caption: String(cut['frame'] ?? '') }));
    });
  }
  return places;
}

function card(db: DatabaseSync, t: TaskRow, places?: ReadonlyMap<string, Place>): TaskCard {
  const place = t.node !== 'image:character-refs' && t.label ? (places ?? storyboardPlaces(db)).get(t.label) : undefined;
  const cand = candidateOfTask(db, t.id);
  const media = cand ? (db.prepare('SELECT mime FROM media_file WHERE id = ?').get(cand.mediaFileId) as { mime: string } | undefined) : undefined;
  return {
    id: t.id,
    node: t.node,
    label: t.label,
    episodeKey: t.episodeKey,
    status: t.status,
    costEstimate: t.costEstimate,
    costActual: t.costActual,
    error: t.error,
    mediaId: cand && media ? cand.mediaFileId : null,
    mime: media?.mime ?? null,
    gateId: t.paidGateId,
    attemptOf: t.attemptOf,
    code: place?.code ?? null,
    caption: place?.caption ?? null,
  };
}

const counts = (tasks: readonly TaskRow[]): Record<TaskStatus, number> => Object.fromEntries(TASK_STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length])) as Record<TaskStatus, number>;

/** 同一节点 + 标签有多条（重新生成）时取最新的。 */
function latestByLabel(tasks: readonly TaskRow[]): TaskRow[] {
  const map = new Map<string, TaskRow>();
  for (const t of tasks) map.set(`${t.node}|${t.label}`, t);
  return [...map.values()];
}

/** 生成任务页、全貌要的运行时信息：在跑的后台任务、最近一次生成失败、价格（预览计划用）。 */
export interface GenContext {
  readonly job: JobInfo | null;
  readonly failure: GenerationFailure | null;
  readonly prices: PriceSources;
}

const isRunning = (gate: PaidGateRow, job: JobInfo | null): boolean => job !== null && job.kind === 'generate' && job.gateId === gate.id;

/**
 * 这张确认单的计划状态：
 * - error：为什么没出图（记下的失败优先；一条任务都没建、也没在跑时，预览一遍计划看会不会报错）；
 * - toCreate：一条任务都没建、能计划出来时，开跑会建几条（> 0 是「待开始」，0 是同样的输入都生成过了）；其余为 null。
 * 记下的失败过后又全部出完了（命令行跑完、恢复补完），不再提旧的错。
 */
function planState(db: DatabaseSync, gate: PaidGateRow, ctx: GenContext, taskCount: number): { error: string | null; toCreate: number | null } {
  if (isRunning(gate, ctx.job)) return { error: null, toCreate: null };
  const allDone = taskCount > 0 && listTasks(db, { paidGateId: gate.id }).every((t) => t.status === 'collected');
  if (allDone) return { error: null, toCreate: null };
  if (ctx.failure?.gateId === gate.id) return { error: ctx.failure.message, toCreate: null };
  if (taskCount > 0) return { error: null, toCreate: null };
  try {
    return { error: null, toCreate: previewGeneration(db, gate, ctx.prices).create };
  } catch (e) {
    return { error: (e as Error).message, toCreate: null };
  }
}

function summary(db: DatabaseSync, gate: PaidGateRow, ctx: GenContext, withError: boolean): GateSummary {
  const tasks = listTasks(db, { paidGateId: gate.id });
  return {
    id: gate.id,
    createdAt: gate.createdAt,
    decidedAt: gate.decidedAt,
    selection: gate.selection,
    cap: gate.budgetCap,
    spent: spentOf(tasks),
    total: latestByLabel(tasks).length,
    counts: counts(latestByLabel(tasks)),
    running: isRunning(gate, ctx.job),
    ...(withError ? planState(db, gate, ctx, tasks.length) : { error: null, toCreate: null }),
  };
}

/** 最近一条已入库的同节点 + 标签任务（任何确认单）。 */
function lastCollected(db: DatabaseSync, node: PaidNode, label: string): TaskRow | null {
  return listTasks(db, { status: ['collected'], node }).filter((t) => t.label === label).at(-1) ?? null;
}

function byEpisode(db: DatabaseSync, tasks: readonly TaskRow[], node: PaidNode, epNo: ReadonlyMap<string, number>, places: ReadonlyMap<string, Place>) {
  const rows = latestByLabel(tasks.filter((t) => t.node === node));
  const eps = [...new Set(rows.map((t) => t.episodeKey ?? ''))];
  return eps.map((episode) => ({ episode, ep: epNo.get(episode) ?? null, rows: rows.filter((t) => (t.episodeKey ?? '') === episode).map((t) => card(db, t, places)) }));
}

export function tasksView(project: Project, ctx: GenContext, gateId?: number): TasksView {
  const { db } = project;
  const confirmed = listPaidGates(db).filter((g) => g.status === 'confirmed').reverse();
  if (gateId !== undefined && !confirmed.some((g) => g.id === gateId)) throw new HttpError(404, `没有这张已确认的确认单：${gateId}`);
  const selectedId = gateId ?? confirmed[0]?.id;
  // 只有选中的那张算计划状态（为什么没出图、待开始要建几条）：要预览计划，别的确认单不必算
  const gates = confirmed.map((g) => summary(db, g, ctx, g.id === selectedId));
  const gate = gates.find((g) => g.id === selectedId) ?? null;
  if (!gate) return { gates, gate: null, characters: [], keyframes: [], videos: [] };
  const tasks = listTasks(db, { paidGateId: gate.id });
  const refs = tasks.filter((t) => t.node === 'image:character-refs');
  const outline = docOf(db, 'outline');
  // 这张确认单勾了角色参考图才列角色；没建任务的视图看以前出过的（被跳过、沿用）
  const sel = confirmed.find((g) => g.id === gate.id)!.selection;
  const pickedRefs = refs.length > 0 || (Boolean(sel) && typeof sel === 'object' && (sel as Record<string, unknown>)['image:character-refs'] === true);
  const characters = pickedRefs
    ? listOf(outline, 'characters')
        .filter((c) => c['tier'] !== 'functional')
        .map((c) => {
          const id = String(c['id']);
          const views = VIEW_ORDER.map((view): ViewCell => {
            const label = `${id}:${view}`;
            const own = refs.filter((t) => t.label === label).at(-1) ?? null;
            const reuse = own ? null : lastCollected(db, 'image:character-refs', label);
            return { view, task: own ? card(db, own) : null, reuseOf: reuse ? card(db, reuse) : null };
          });
          return { id, name: String(c['name']), views };
        })
    : [];
  const epNo = new Map(episodesIn(outline).map((e) => [String(e['id']), Number(e['ep'])]));
  const places = storyboardPlaces(db);
  return { gates, gate, characters, keyframes: byEpisode(db, tasks, 'image:keyframe', epNo, places), videos: byEpisode(db, tasks, 'video:segment', epNo, places) };
}

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const fieldOf = (x: unknown, name: string): unknown => (x && typeof x === 'object' ? (x as Record<string, unknown>)[name] : undefined);

export function taskDetail(project: Project, taskId: number): TaskDetail {
  const { db } = project;
  const t = getTask(db, taskId);
  if (!t) throw new HttpError(404, `没有这个任务：${taskId}`);
  const plannedPrompt = str(fieldOf(t.plannedInput, 'prompt'));
  const actualPrompt = str(fieldOf(t.actualInput, 'prompt'));
  const deps = fieldOf(t.plannedInput, 'deps');
  const refs = (Array.isArray(deps) ? deps.filter((d): d is string => typeof d === 'string') : []).map((key) => {
    const [node, label] = key.split('|') as [PaidNode, string];
    const dep = lastCollected(db, node, label);
    return { key, task: dep ? card(db, dep) : null };
  });
  return {
    ...card(db, t),
    provider: t.provider,
    model: t.model,
    providerTaskId: t.providerTaskId,
    size: str(fieldOf(t.plannedInput, 'size')),
    prompt: actualPrompt ?? plannedPrompt,
    negativePrompt: str(fieldOf(t.plannedInput, 'negativePrompt')),
    planDiffers: actualPrompt !== null && plannedPrompt !== null && actualPrompt !== plannedPrompt,
    refs,
    events: taskEvents(db, t.id),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** 勾选里选中的付费节点：值是 true 或非空的集列表。 */
function selectedNodes(selection: unknown): PaidNode[] {
  if (!selection || typeof selection !== 'object') return [];
  const sel = selection as Record<string, unknown>;
  return PAID.filter((n) => sel[n] === true || (Array.isArray(sel[n]) && (sel[n] as unknown[]).length > 0));
}

/**
 * 全貌付费卡片：最近一张已确认确认单的进度（包括还没开跑的「待开始」和计划不出来的）。
 * 最近那张一条任务都没有、也没要建的（同样的输入都出过了）时，退回最近一张有任务的。都没有为 null。
 */
export function generationProgress(db: DatabaseSync, ctx: GenContext): GenerationProgress | null {
  const confirmed = listPaidGates(db).filter((g) => g.status === 'confirmed').reverse();
  const latest = confirmed[0];
  if (!latest) return null;
  const latestTasks = listTasks(db, { paidGateId: latest.id }).length;
  const latestState = planState(db, latest, ctx, latestTasks);
  const show = latestTasks > 0 || latestState.error !== null || (latestState.toCreate ?? 0) > 0 || isRunning(latest, ctx.job);
  const gate = show ? latest : confirmed.find((g) => listTasks(db, { paidGateId: g.id }).length > 0);
  if (!gate) return null;
  const all = listTasks(db, { paidGateId: gate.id });
  const tasks = latestByLabel(all);
  const of = (xs: readonly TaskRow[]) => ({ total: xs.length, done: xs.filter((t) => t.status === 'collected').length, failed: xs.filter((t) => FAILED.has(t.status)).length });
  return {
    gateId: gate.id,
    running: isRunning(gate, ctx.job),
    ...(gate === latest ? latestState : { error: null, toCreate: null }),
    selected: selectedNodes(gate.selection),
    ...of(tasks),
    spent: spentOf(all),
    cap: gate.budgetCap,
    byNode: PAID.flatMap((node) => {
      const xs = tasks.filter((t) => t.node === node);
      return xs.length ? [{ node, ...of(xs) }] : [];
    }),
  };
}

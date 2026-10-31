// 编排器：按依赖图分层跑文本阶段，同层并发；某阶段没过只阻断依赖它的下游，其余照跑。
// 没有产物的阶段从头跑，有产物但在「需复核」矩阵里的只重跑受影响的集（在当前版本上改），其余跳过——
// 所以中断后再 go 会从断的地方接着跑。文本层结束后估一次费用，生成付费确认单，停在付费阶段之前。
// 每个阶段的运行记录由 runNode 自己管；这里只记编排汇总，不吞单个运行的错误。
import type { Project } from '../project.ts';
import { STAGES, type Stage } from '../domain/types.ts';
import { estimateProject, type ProjectEstimate } from '../estimate/estimate.ts';
import { RECIPES } from '../executor/recipes.ts';
import { EPISODE_SOURCE, episodeIdsOf, runNode, type ProgressEvent, type RunNodeOptions, type RunOutcome } from '../executor/run-node.ts';
import type { TextModel } from '../model/text-model.ts';
import type { DatabaseSync } from 'node:sqlite';
import { latestArtifact, latestArtifactDoc } from '../repo/artifacts.ts';
import { currentInput } from '../repo/inputs.ts';
import { failInterruptedOrchestrations, finishOrchestration, startOrchestration, type OrchestrationMode, type OrchestrationStatus } from '../repo/orchestrations.ts';
import { createPaidGate, type PaidGateRow } from '../repo/paid-gates.ts';
import { currentMount } from '../repo/skills.ts';
import { layers, STAGE_DEPS } from './deps.ts';
import { pendingCells } from './review-matrix.ts';

export const DEFAULT_CONCURRENCY = 3;

/** 上游变了重跑时附给模型的话（打回时用作者的意见） */
export const STALE_NOTE = '上游有改动：按新的上游修改这一版，没受影响的内容保持不变。';

export type StageStatus = 'passed' | 'needs_human' | 'failed' | 'skipped' | 'blocked';

export interface StageResult {
  readonly stage: Stage;
  readonly status: StageStatus;
  readonly runId?: number;
  /** 只重跑了这几集 */
  readonly episodes?: readonly string[];
  readonly message?: string;
}

export type OrchestrateEvent =
  | { readonly type: 'layer'; readonly stages: readonly Stage[] }
  | { readonly type: 'stage'; readonly result: StageResult }
  | { readonly type: 'run'; readonly event: ProgressEvent }
  | { readonly type: 'paid-gate'; readonly gate: PaidGateRow };

export interface OrchestrateOptions {
  /** 每个阶段用哪个模型（CLI 按预设 / 节点覆盖解析） */
  readonly modelFor: (stage: Stage) => TextModel;
  readonly mode?: OrchestrationMode;
  /** 只跑这一个阶段（不管有没有产物都重跑），不生成付费确认单 */
  readonly only?: Stage;
  readonly concurrency?: number;
  readonly onProgress?: (e: OrchestrateEvent) => void;
  /** 透传给每个 runNode 的选项（重试上限、价格、是否不沿用之前的集） */
  readonly run?: Pick<RunNodeOptions, 'maxAttempts' | 'prices' | 'fresh'>;
  /** 付费确认单的估算；默认 estimateProject（测试里换掉，免得读本机价格配置） */
  readonly estimate?: (db: DatabaseSync) => ProjectEstimate;
}

export interface OrchestrateResult {
  readonly id: number;
  readonly status: Exclude<OrchestrationStatus, 'running'>;
  readonly stages: readonly StageResult[];
  readonly paidGate: PaidGateRow | null;
  /** 估算失败的原因（不影响文本阶段的结果） */
  readonly paidGateError?: string;
}

/** 本进程正在跑的编排（按项目目录分开）：同进程里残留的 running 靠它认出来。 */
const ACTIVE = new Map<string, Set<number>>();
const activeSet = (dir: string): Set<number> => ACTIVE.get(dir) ?? ACTIVE.set(dir, new Set()).get(dir)!;

/** 同时最多跑 limit 个；结果按输入顺序。 */
async function pool<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface Plan {
  readonly stage: Stage;
  /** null = 跳过；'all' = 从头跑整阶段；否则在当前版本上改（episodes 为 null 表示整阶段） */
  readonly action: null | 'all' | { readonly episodes: readonly string[] | null };
  /** 给人看的说明（例如有需复核的集已不在上游里） */
  readonly note?: string;
}

/** 这一阶段这次要做什么：没产物从头跑；有需复核的格子就只改那些；都没有就跳过。--only 一律从头重跑。 */
export function planStage(project: Project, stage: Stage, opts: OrchestrateOptions): Plan {
  const { db } = project;
  if (opts.only) return { stage, action: 'all' };
  if (!latestArtifact(db, stage)) return { stage, action: opts.mode === 'only-stale' ? null : 'all' };
  const cells = pendingCells(db).filter((c) => c.stage === stage);
  if (!cells.length) return { stage, action: null };
  const recipe = RECIPES[currentMount(db, stage)?.recipe ?? ''];
  if (!recipe?.perEpisode || cells.some((c) => c.episode === null)) return { stage, action: { episodes: null } };
  // 上游已经没有的集重跑不了（重跑会一直失败）：不重跑，留在矩阵里由人确认或处理
  const source = EPISODE_SOURCE[stage];
  const known = new Set(source ? episodeIdsOf(latestArtifactDoc(db, source)?.doc) : []);
  const episodes = cells.map((c) => c.episode!).filter((e) => known.has(e));
  const gone = cells.map((c) => c.episode!).filter((e) => !known.has(e));
  if (!episodes.length) return { stage, action: null, note: `需复核的集已不在上游 ${source} 里（${gone.join('、')}），没有重跑：确认后用 review --keep` };
  return { stage, action: { episodes }, ...(gone.length ? { note: `上游 ${source} 里已没有 ${gone.join('、')}，这几集没有重跑` } : {}) };
}

const fromOutcome = (stage: Stage, out: RunOutcome, episodes?: readonly string[] | null): StageResult => ({
  stage,
  status: out.status,
  runId: out.runId,
  ...(episodes ? { episodes } : {}),
  ...(out.message ? { message: out.message } : {}),
});

async function runStage(project: Project, plan: Plan, id: number, opts: OrchestrateOptions): Promise<StageResult> {
  const { stage, action } = plan;
  if (action === null) return { stage, status: 'skipped', message: plan.note ?? '已有产物，没有需复核的地方' };
  const episodes = action === 'all' ? null : action.episodes;
  const base: RunNodeOptions = {
    ...opts.run,
    model: opts.modelFor(stage),
    orchestrationId: id,
    onProgress: (event) => emit(opts, { type: 'run', event }),
    ...(action === 'all' ? {} : { revise: { note: STALE_NOTE } }),
    ...(episodes ? { episodes } : {}),
  };
  const result = fromOutcome(stage, await runNode(project, stage, base), episodes);
  return plan.note ? { ...result, message: [result.message, plan.note].filter(Boolean).join('；') } : result;
}

/** 进度回调自己出错不影响编排。 */
function emit(opts: OrchestrateOptions, e: OrchestrateEvent): void {
  try {
    opts.onProgress?.(e);
  } catch {
    // 忽略
  }
}

/** 一个阶段从计划到运行的任何一步出错（解析模型、没挂载、缺上游、已有运行）都收成 failed：
 * 不能让它冒出去打断同层还在跑的阶段，留下没有编排认领的运行。 */
async function settleStage(project: Project, stage: Stage, id: number, opts: OrchestrateOptions): Promise<StageResult> {
  try {
    return await runStage(project, planStage(project, stage, opts), id, opts);
  } catch (error) {
    return { stage, status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

const OK: ReadonlySet<StageStatus> = new Set(['passed', 'skipped']);

function overall(results: readonly StageResult[]): Exclude<OrchestrationStatus, 'running'> {
  if (results.some((r) => r.status === 'failed')) return 'failed';
  if (results.some((r) => r.status === 'needs_human' || r.status === 'blocked')) return 'blocked';
  return 'done';
}

function paidGate(project: Project, id: number, opts: OrchestrateOptions): { gate: PaidGateRow | null; error?: string } {
  try {
    const estimate = (opts.estimate ?? ((db) => estimateProject(db)))(project.db);
    const gate = createPaidGate(project.db, { orchestrationId: id, estimate });
    emit(opts, { type: 'paid-gate', gate });
    return { gate };
  } catch (error) {
    return { gate: null, error: `估算失败，没有生成付费确认单：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function execute(project: Project, id: number, opts: OrchestrateOptions): Promise<StageResult[]> {
  const results = new Map<Stage, StageResult>();
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  for (const layer of layers(opts.only ? [opts.only] : STAGES)) {
    emit(opts, { type: 'layer', stages: layer });
    const layerResults = await pool(layer, concurrency, async (stage): Promise<StageResult> => {
      const bad = STAGE_DEPS[stage].needs.find((n) => results.has(n) && !OK.has(results.get(n)!.status));
      // 计划在跑到这一层时才算：上游刚重跑完，新的需复核格子要算进来
      const result = bad ? { stage, status: 'blocked' as const, message: `上游 ${bad} 未通过` } : await settleStage(project, stage, id, opts);
      emit(opts, { type: 'stage', result });
      return result;
    });
    for (const r of layerResults) results.set(r.stage, r);
  }
  return [...results.values()];
}

/** 一键跑：分层并发、阻断传播、付费前停下。同一项目同一时刻只能有一条编排在跑。 */
export async function orchestrate(project: Project, opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const { db } = project;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`并发数必须是正整数：${concurrency}`);
  if (!currentInput(db)) throw new Error('还没有项目输入（先用 input 提供梗概或原文与参数）');
  const active = activeSet(project.dir);
  failInterruptedOrchestrations(db, (id) => active.has(id));
  const mode: OrchestrationMode = opts.only ? 'single' : (opts.mode ?? 'all');
  const id = startOrchestration(db, mode);
  active.add(id);
  try {
    const stages = await execute(project, id, { ...opts, mode });
    const gate = opts.only ? { gate: null } : paidGate(project, id, opts);
    const status = overall(stages);
    const unfinished = stages.filter((s) => !OK.has(s.status)).map((s) => s.stage);
    finishOrchestration(db, id, status, { stages, paidGateId: gate.gate?.id ?? null, unfinished, ...(gate.error ? { paidGateError: gate.error } : {}) });
    return { id, status, stages, paidGate: gate.gate, ...(gate.error ? { paidGateError: gate.error } : {}) };
  } catch (error) {
    finishOrchestration(db, id, 'failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    active.delete(id);
  }
}

// 全貌页的数据：阶段卡、运行摘要、付费阶段估算、分集表、待处理项、最近一次编排的运行记录。
// 全部来自 4a 的矩阵、运行记录、编排与估算，不另做判断。
import type { DatabaseSync } from 'node:sqlite';
import { STAGES, type Stage } from '../../domain/types.ts';
import { estimateProject, type ProjectEstimate } from '../../estimate/estimate.ts';
import { listOf } from '../../executor/recipe-kit.ts';
import { STAGE_DEPS } from '../../orchestrate/deps.ts';
import { pendingCells, type MatrixCell } from '../../orchestrate/review-matrix.ts';
import { loadPresets } from '../../presets/presets.ts';
import type { Project } from '../../project.ts';
import { listOrchestrations } from '../../repo/orchestrations.ts';
import { listPaidGates } from '../../repo/paid-gates.ts';
import { unfulfilledRevisions, type UnfulfilledRevision } from '../../repo/revisions.ts';
import type { RunStatus } from '../../repo/runs.ts';
import type { App } from '../app.ts';
import type { JobInfo } from '../jobs.ts';
import { stageGates, type GateResult } from './checkup.ts';
import { docOf, episodesIn, projectHead, STAGE_TITLES, stageCards, textCost, toCny, type ProjectHead, type StageCard } from './common.ts';

export type CellState = 'ok' | 'stale' | 'missing';

export interface EpisodeRow {
  readonly id: string;
  readonly ep: number;
  readonly hook: string;
  readonly synopsis: string;
  readonly script: { readonly state: CellState; readonly scenes: number; readonly lines: number; readonly reason: string | null };
  readonly staging: { readonly state: CellState; readonly scenes: number; readonly reason: string | null };
  readonly storyboard: { readonly state: CellState; readonly segments: number; readonly cuts: number; readonly seconds: number; readonly reason: string | null };
  /** 这一集付费生成（关键帧 + 视频）的估算，人民币；分镜还没有就是 null */
  readonly estimate: { readonly low: number; readonly high: number } | null;
}

/** 哪个上游、哪一集按当前质量门不过——下游怎么修都过不了，得先回去改它。 */
export interface UpstreamBlame {
  readonly stage: Stage;
  readonly episode: string | null;
  readonly ep: number | null;
}

export interface PendingItem {
  /** gate：已有产物，但按当前挂载 skill 的质量门不过（skill 升级后门变严，旧产物不会自己重查） */
  readonly kind: 'stale' | 'needs_human' | 'failed' | 'gate' | 'revision';
  readonly stage: Stage;
  readonly episode: string | null;
  readonly ep: number | null;
  readonly title: string;
  readonly detail: string;
  readonly runId: number | null;
  readonly reasons: MatrixCell['reasons'];
  /** 没过的运行：上游有门不过时指向它 */
  readonly upstream: UpstreamBlame | null;
  /** 这一项背后有没落实的打回意见（转人工 / 失败的运行就是为它跑的，或 kind 为 revision 时就是它自己） */
  readonly revision: PendingRevision | null;
}

/** 打回过、但运行没跑完，意见没有落实。 */
export interface PendingRevision {
  readonly id: number;
  readonly note: string;
  readonly episode: string | null;
  readonly ep: number | null;
}

export interface LogRun {
  readonly id: number;
  readonly stage: Stage;
  readonly status: RunStatus;
  readonly model: string;
  readonly skill: string;
  readonly episodeKey: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly error: string | null;
  readonly attempts: readonly { readonly step: string; readonly n: number; readonly violations: readonly string[]; readonly startedAt: string; readonly endedAt: string | null; readonly inputTokens: number | null }[];
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** 过期原因的一句话：哪个上游变了。 */
const reasonOf = (cell: MatrixCell | undefined): string | null =>
  cell ? `${[...new Set(cell.reasons.map((r) => STAGE_TITLES[r.to.facet]))].join('、')}已变` : null;

function episodeRows(db: DatabaseSync, cells: readonly MatrixCell[], estimate: ProjectEstimate | null): EpisodeRow[] {
  const outline = episodesIn(docOf(db, 'outline'));
  const script = new Map(episodesIn(docOf(db, 'script')).map((e) => [e['id'], e]));
  const board = new Map(episodesIn(docOf(db, 'storyboard')).map((e) => [e['id'], e]));
  const stagingScenes = listOf(docOf(db, 'staging'), 'scenes');
  const cell = (stage: Stage, id: string) => cells.find((c) => c.stage === stage && c.episode === id);
  const state = (has: boolean, stage: Stage, id: string): CellState => (!has ? 'missing' : cell(stage, id) ? 'stale' : 'ok');
  const perEpisode = estimate?.nodes.filter((n) => n.node === 'image:keyframe' || n.node === 'video:segment') ?? [];
  return outline.map((o) => {
    const id = String(o['id']);
    const s = script.get(id);
    const scenes = listOf(s, 'scenes');
    const sceneRefs = new Set(scenes.map((x) => x['id']));
    const staged = stagingScenes.filter((x) => sceneRefs.has(x['sceneRef']));
    const b = board.get(id);
    const segments = listOf(b, 'segments');
    const cuts = segments.flatMap((g) => listOf(g, 'cuts'));
    const costs = perEpisode.map((n) => n.episodes?.find((e) => e.episode === id)?.cost ?? null);
    const priced = costs.length > 0 && costs.every((c) => c !== null);
    return {
      id,
      ep: Number(o['ep']),
      hook: String(o['hook'] ?? ''),
      synopsis: String(o['synopsis'] ?? ''),
      script: { state: state(Boolean(s), 'script', id), scenes: scenes.length, lines: sum(scenes.map((x) => listOf(x, 'flow').filter((f) => f['line']).length)), reason: reasonOf(cell('script', id)) },
      staging: { state: state(staged.length > 0, 'staging', id), scenes: staged.length, reason: reasonOf(cell('staging', id)) },
      storyboard: { state: state(Boolean(b), 'storyboard', id), segments: segments.length, cuts: cuts.length, seconds: sum(cuts.map((c) => (typeof c['seconds'] === 'number' ? c['seconds'] : 0))), reason: reasonOf(cell('storyboard', id)) },
      estimate: priced && estimate ? { low: toCny(sum(costs.map((c) => c!.low)), estimate.fx), high: toCny(sum(costs.map((c) => c!.high)), estimate.fx) } : null,
    };
  });
}

/** 一个阶段的全部上游（含可选的、间接的），按流水线顺序。 */
function upstreamsOf(stage: Stage): Stage[] {
  const found = new Set<Stage>();
  const visit = (s: Stage) => {
    for (const u of [...STAGE_DEPS[s].needs, ...STAGE_DEPS[s].optional]) {
      if (!found.has(u)) {
        found.add(u);
        visit(u);
      }
    }
  };
  visit(stage);
  return STAGES.filter((s) => found.has(s));
}

/**
 * 每一条违规都点到同一集（「第 14 集」）才认出是哪一集；有一条没点集或点到别的集就不猜——
 * 认错了会把别处的问题漏在打回范围外。
 */
export function episodeNamed(failed: readonly string[], epId: ReadonlyMap<number, string>): { episode: string; ep: number } | null {
  const per = failed.map((f) => new Set([...f.matchAll(/第 ?(\d+) ?集/g)].map((m) => Number(m[1]))));
  const eps = new Set(per.flatMap((s) => [...s]));
  if (eps.size !== 1 || per.some((s) => s.size === 0)) return null;
  const ep = [...eps][0]!;
  const episode = epId.get(ep);
  return episode ? { episode, ep } : null;
}

const epPrefix = (ep: number | null): string => (ep ? `第 ${String(ep).padStart(2, '0')} 集 · ` : '');

/**
 * 待你处理：最近一次没过的运行、按当前质量门不过的阶段、需复核的格子。
 * gates 与 cards 一一对应（各阶段对最新产物跑当前 skill 的检查；没有产物或检查跑挂了是 null）。
 */
function pendingItems(db: DatabaseSync, cells: readonly MatrixCell[], cards: readonly StageCard[], gates: readonly (GateResult | null)[], revisions: readonly UnfulfilledRevision[]): PendingItem[] {
  const outline = episodesIn(docOf(db, 'outline'));
  const epNo = new Map(outline.map((e) => [e['id'], Number(e['ep'])]));
  const epId = new Map(outline.map((e) => [Number(e['ep']), String(e['id'])]));
  const failedGates = new Map(cards.flatMap((c, i) => (gates[i]?.failed.length ? [[c.stage, gates[i]!.failed] as const] : [])));
  const blameOf = (stage: Stage): UpstreamBlame | null => {
    const up = upstreamsOf(stage).find((s) => failedGates.has(s));
    if (!up) return null;
    const named = episodeNamed(failedGates.get(up)!, epId);
    return { stage: up, episode: named?.episode ?? null, ep: named?.ep ?? null };
  };
  const revisionOf = (r: UnfulfilledRevision): PendingRevision => ({ id: r.id, note: r.note, episode: r.episodeKey, ep: r.episodeKey ? (epNo.get(r.episodeKey) ?? null) : null });
  const failed = cards.flatMap((c): PendingItem[] => {
    const run = c.lastRun;
    if (!run || (run.status !== 'needs_human' && run.status !== 'failed')) return [];
    const last = db.prepare('SELECT violations FROM node_attempt WHERE run_id = ? ORDER BY id DESC LIMIT 1').get(run.id) as { violations: string } | undefined;
    const violations: string[] = last ? JSON.parse(last.violations) : [];
    const attached = revisions.find((r) => r.stage === c.stage && r.latestRunId === run.id);
    return [{ kind: run.status, stage: c.stage, episode: null, ep: null, title: `${c.title}${run.status === 'needs_human' ? '未通过' : '失败'}`, detail: violations[0] ?? run.error ?? '', runId: run.id, reasons: [], upstream: blameOf(c.stage), revision: attached ? revisionOf(attached) : null }];
  });
  // 打回的运行就是这一阶段最近那次没过的运行：意见附在它那一项上；否则（后来别的运行盖过了它）单独列
  const attachedIds = new Set(failed.flatMap((f) => (f.revision ? [f.revision.id] : [])));
  const revisionItems = revisions.filter((r) => !attachedIds.has(r.id)).map((r): PendingItem => {
    const rev = revisionOf(r);
    const title = STAGE_TITLES[r.stage];
    return { kind: 'revision', stage: r.stage, episode: rev.episode, ep: rev.ep, title: `${epPrefix(rev.ep)}${title}的打回没落实`, detail: r.note, runId: r.latestRunId, reasons: [], upstream: null, revision: rev };
  });
  const listed = new Set(failed.map((f) => f.stage));
  const gateItems = cards.flatMap((c): PendingItem[] => {
    const bad = failedGates.get(c.stage);
    if (!bad || listed.has(c.stage)) return [];
    const named = episodeNamed(bad, epId);
    const more = bad.length > 1 ? `（共 ${bad.length} 项）` : '';
    return [{ kind: 'gate', stage: c.stage, episode: named?.episode ?? null, ep: named?.ep ?? null, title: `${epPrefix(named?.ep ?? null)}${c.title}按当前质量门不过`, detail: `${bad[0]}${more}`, runId: c.lastRun?.id ?? null, reasons: [], upstream: null, revision: null }];
  });
  const stale = cells.map((c): PendingItem => {
    const ep = c.episode ? (epNo.get(c.episode) ?? null) : null;
    return { kind: 'stale', stage: c.stage, episode: c.episode, ep, title: `${epPrefix(ep)}${STAGE_TITLES[c.stage]}需复核`, detail: `${reasonOf(c)}：${c.reasons.length} 处引用还钉着旧版本`, runId: c.lastRun?.id ?? null, reasons: c.reasons, upstream: null, revision: null };
  });
  return [...failed, ...revisionItems, ...gateItems, ...stale];
}

/** 运行记录最多带多少次运行（最近的），免得项目跑久了全貌越来越大 */
const MAX_LOG_RUNS = 200;

/**
 * 项目的运行记录：所有运行与它们的每次尝试，按时间先后（运行中视图的运行记录、正在进行面板）。
 * 不按编排过滤——重跑某个阶段、打回都是追加，之前的记录要留着；打回的运行不属于任何编排，也要在。
 */
function runLog(db: DatabaseSync): LogRun[] {
  const runs = db
    .prepare(
      `SELECT * FROM (SELECT r.id, r.stage, r.status, r.model, r.episode_key, r.started_at, r.ended_at, r.error, s.name, s.version
       FROM node_run r JOIN skill s ON s.id = r.skill_id ORDER BY r.id DESC LIMIT ?) ORDER BY id`,
    )
    .all(MAX_LOG_RUNS) as { id: number; stage: Stage; status: RunStatus; model: string; episode_key: string | null; started_at: string; ended_at: string | null; error: string | null; name: string; version: string }[];
  // 尝试一次查完再按运行分组：运行中每条进度事件都会重拉全貌，不能每次运行各查一遍
  const attemptsOf = new Map<number, { step: string; n: number; violations: string; usage: string | null; started_at: string; ended_at: string | null }[]>();
  if (runs.length) {
    const rows = db
      .prepare('SELECT run_id, step, n, violations, usage, started_at, ended_at FROM node_attempt WHERE run_id >= ? ORDER BY id')
      .all(runs[0]!.id) as { run_id: number; step: string; n: number; violations: string; usage: string | null; started_at: string; ended_at: string | null }[];
    for (const a of rows) attemptsOf.set(a.run_id, [...(attemptsOf.get(a.run_id) ?? []), a]);
  }
  return runs.map((r) => {
    const attempts = attemptsOf.get(r.id) ?? [];
    return {
      id: r.id,
      stage: r.stage,
      status: r.status,
      model: r.model,
      skill: `${r.name}@${r.version}`,
      episodeKey: r.episode_key,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      error: r.error,
      attempts: attempts.map((a) => ({ step: a.step, n: a.n, violations: JSON.parse(a.violations), startedAt: a.started_at, endedAt: a.ended_at, inputTokens: a.usage ? (JSON.parse(a.usage).inputTokens ?? null) : null })),
    };
  });
}

function safeEstimate(app: App, db: DatabaseSync): { estimate: ProjectEstimate | null; error: string | null } {
  try {
    return { estimate: app.config.estimate ? app.config.estimate(db) : estimateProject(db, app.config.presetDirs ? { presetDirs: app.config.presetDirs } : {}), error: null };
  } catch (error) {
    return { estimate: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface Overview {
  readonly project: ProjectHead;
  readonly presets: readonly { readonly name: string; readonly title: string }[];
  readonly job: JobInfo | null;
  readonly orchestration: { readonly id: number; readonly status: string; readonly mode: string; readonly startedAt: string; readonly endedAt: string | null } | null;
  readonly summary: { readonly textPassed: number; readonly textTotal: number; readonly conversationSteps: 0; readonly elapsedMs: number | null; readonly textCost: { readonly usd: number; readonly cny: number | null }; readonly pending: number };
  readonly stages: readonly (StageCard & { readonly gates: GateResult | null })[];
  readonly estimate: ProjectEstimate | null;
  readonly estimateError: string | null;
  readonly episodes: readonly EpisodeRow[];
  readonly pending: readonly PendingItem[];
  readonly gate: { readonly id: number; readonly status: string } | null;
  readonly log: readonly LogRun[];
}

export async function overview(app: App, project: Project, id: string): Promise<Overview> {
  const { db } = project;
  const cells = pendingCells(db);
  const cards = stageCards(db, cells);
  // 质量门要跑 skill 脚本：各阶段并行，单个失败不影响整页
  const gates = await Promise.all(cards.map((c) => stageGates(project, c.stage).catch(() => null)));
  const { estimate, error } = safeEstimate(app, db);
  const orch = listOrchestrations(db).at(-1) ?? null;
  const cost = textCost(db);
  const gate = listPaidGates(db).filter((g) => g.status === 'awaiting_confirmation').at(-1) ?? null;
  const pending = pendingItems(db, cells, cards, gates, unfulfilledRevisions(db));
  const elapsed = orch ? (orch.endedAt ? Date.parse(orch.endedAt) : Date.now()) - Date.parse(orch.startedAt) : null;
  return {
    project: projectHead(project, id),
    presets: loadPresets(app.config.presetDirs).map((p) => ({ name: p.name, title: p.title })),
    job: app.jobs.current(id),
    orchestration: orch ? { id: orch.id, status: orch.status, mode: orch.mode, startedAt: orch.startedAt, endedAt: orch.endedAt } : null,
    summary: {
      textPassed: cards.filter((c) => c.state === 'passed' || c.state === 'stale').length,
      textTotal: STAGES.length,
      conversationSteps: 0,
      elapsedMs: elapsed,
      textCost: { usd: cost.usd, cny: estimate ? toCny(cost.usd, estimate.fx) : null },
      pending: pending.length,
    },
    stages: cards.map((c, i) => ({ ...c, gates: gates[i] ?? null })),
    estimate,
    estimateError: error,
    episodes: episodeRows(db, cells, estimate),
    pending,
    gate: gate ? { id: gate.id, status: gate.status } : null,
    log: runLog(db),
  };
}

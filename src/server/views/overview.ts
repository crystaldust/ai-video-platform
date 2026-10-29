// 全貌页的数据：阶段卡、运行摘要、付费阶段估算、分集表、待处理项、最近一次编排的运行记录。
// 全部来自 4a 的矩阵、运行记录、编排与估算，不另做判断。
import type { DatabaseSync } from 'node:sqlite';
import { STAGES, type Stage } from '../../domain/types.ts';
import { estimateProject, type ProjectEstimate } from '../../estimate/estimate.ts';
import { listOf } from '../../executor/recipe-kit.ts';
import { pendingCells, type MatrixCell } from '../../orchestrate/review-matrix.ts';
import { loadPresets } from '../../presets/presets.ts';
import type { Project } from '../../project.ts';
import { listOrchestrations } from '../../repo/orchestrations.ts';
import { listPaidGates } from '../../repo/paid-gates.ts';
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

export interface PendingItem {
  readonly kind: 'stale' | 'needs_human' | 'failed';
  readonly stage: Stage;
  readonly episode: string | null;
  readonly ep: number | null;
  readonly title: string;
  readonly detail: string;
  readonly runId: number | null;
  readonly reasons: MatrixCell['reasons'];
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

/** 待你处理：需复核的格子，加上最近一次没过的运行。 */
function pendingItems(db: DatabaseSync, cells: readonly MatrixCell[], cards: readonly StageCard[]): PendingItem[] {
  const epNo = new Map(episodesIn(docOf(db, 'outline')).map((e) => [e['id'], Number(e['ep'])]));
  const failed = cards.flatMap((c): PendingItem[] => {
    const run = c.lastRun;
    if (!run || (run.status !== 'needs_human' && run.status !== 'failed')) return [];
    const last = db.prepare('SELECT violations FROM node_attempt WHERE run_id = ? ORDER BY id DESC LIMIT 1').get(run.id) as { violations: string } | undefined;
    const violations: string[] = last ? JSON.parse(last.violations) : [];
    return [{ kind: run.status, stage: c.stage, episode: null, ep: null, title: `${c.title}${run.status === 'needs_human' ? '未通过' : '失败'}`, detail: violations[0] ?? run.error ?? '', runId: run.id, reasons: [] }];
  });
  const stale = cells.map((c): PendingItem => {
    const ep = c.episode ? (epNo.get(c.episode) ?? null) : null;
    return { kind: 'stale', stage: c.stage, episode: c.episode, ep, title: `${ep ? `第 ${String(ep).padStart(2, '0')} 集 · ` : ''}${STAGE_TITLES[c.stage]}需复核`, detail: `${reasonOf(c)}：${c.reasons.length} 处引用还钉着旧版本`, runId: c.lastRun?.id ?? null, reasons: c.reasons };
  });
  return [...failed, ...stale];
}

/** 最近一次编排的各次运行与尝试（运行中视图的运行记录、正在进行面板）。 */
function runLog(db: DatabaseSync, orchestrationId: number | null): LogRun[] {
  if (orchestrationId === null) return [];
  const runs = db
    .prepare('SELECT r.id, r.stage, r.status, r.model, r.episode_key, r.started_at, r.ended_at, r.error, s.name, s.version FROM node_run r JOIN skill s ON s.id = r.skill_id WHERE r.orchestration_id = ? ORDER BY r.id')
    .all(orchestrationId) as { id: number; stage: Stage; status: RunStatus; model: string; episode_key: string | null; started_at: string; ended_at: string | null; error: string | null; name: string; version: string }[];
  return runs.map((r) => {
    const attempts = db.prepare('SELECT step, n, violations, usage, started_at, ended_at FROM node_attempt WHERE run_id = ? ORDER BY id').all(r.id) as { step: string; n: number; violations: string; usage: string | null; started_at: string; ended_at: string | null }[];
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
  const pending = pendingItems(db, cells, cards);
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
    log: runLog(db, orch?.id ?? null),
  };
}

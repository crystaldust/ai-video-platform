// 打回：对一个阶段（或其中一集）附上意见重跑。意见进每一遍的提示词，当前版本作为底稿——是「改这一版」，不是从空白重写。
// 带集的打回只处理这一集，导入时也只对这一集负责：其他集不退役、版本不变。大纲、角色、美术是整份负责的，不能带集。
import type { DatabaseSync } from 'node:sqlite';
import type { Stage } from '../domain/types.ts';
import { RECIPES } from '../executor/recipes.ts';
import { runNode, type RunNodeOptions, type RunOutcome } from '../executor/run-node.ts';
import type { Project } from '../project.ts';
import { latestArtifact, latestArtifactDoc } from '../repo/artifacts.ts';
import { addRevisionRequest, type RevisionRequestRow } from '../repo/revisions.ts';
import { currentMount } from '../repo/skills.ts';
import { pendingCells, type MatrixCell } from './review-matrix.ts';

/** --ep 可以给集 id，也可以给集号；集号按当前大纲认（插集后集号会变，以现在的为准）。 */
export function resolveEpisode(db: DatabaseSync, ref: string): string {
  const outline = latestArtifactDoc(db, 'outline')?.doc as { episodes?: { id?: unknown; ep?: unknown }[] } | undefined;
  const episodes = Array.isArray(outline?.episodes) ? outline.episodes : [];
  const byRef = /^\d+$/.test(ref) ? episodes.find((e) => e.ep === Number(ref)) : episodes.find((e) => e.id === ref);
  if (!byRef || typeof byRef.id !== 'string') throw new Error(`当前大纲里没有第 ${ref} 集`);
  return byRef.id;
}

export interface RejectOptions extends Omit<RunNodeOptions, 'episodes' | 'revise'> {
  /** 集 id 或集号；不给就是整个阶段 */
  readonly episode?: string;
  readonly note: string;
}

export interface RejectResult {
  readonly request: RevisionRequestRow;
  readonly outcome: RunOutcome;
  /** 重跑之后还没复核的格子（下游受影响的部分） */
  readonly pending: readonly MatrixCell[];
}

/** 打回前的检查（界面在开后台任务前先调它，错误能直接回给请求）：意见非空、有产物、带集时配方能按集跑、集认得出。 */
export function checkReject(db: DatabaseSync, stage: Stage, opts: { episode?: string; note: string }): { note: string; episode: string | null; baseId: number } {
  const note = opts.note.trim();
  if (!note) throw new Error('打回要写意见（--note）');
  const base = latestArtifact(db, stage);
  if (!base) throw new Error(`${stage} 还没有产物，没什么可打回的：先 go 或 run`);
  const recipe = RECIPES[currentMount(db, stage)?.recipe ?? ''];
  if (opts.episode !== undefined && !recipe?.perEpisode) throw new Error(`${stage} 是整份负责的，不能只打回其中一集（去掉 --ep）`);
  return { note, episode: opts.episode === undefined ? null : resolveEpisode(db, opts.episode), baseId: base.id };
}

export async function reject(project: Project, stage: Stage, opts: RejectOptions): Promise<RejectResult> {
  const { db } = project;
  const { note, episode, baseId } = checkReject(db, stage, opts);
  const request = addRevisionRequest(db, { stage, episodeKey: episode, note, baseArtifactVersionId: baseId });
  const { episode: _e, note: _n, ...run } = opts;
  const outcome = await runNode(project, stage, { ...run, revise: { note, requestId: request.id }, ...(episode ? { episodes: [episode] } : {}) });
  return { request, outcome, pending: pendingCells(db) };
}

/** 一集的打回结果（一次打回多集时逐集汇总）。 */
export interface EpisodeRejectResult {
  readonly episode: string;
  readonly ep: number | null;
  /** error = 抛错（没开成运行）；skipped = 前面连着两集出同样的错，没再试 */
  readonly status: RunOutcome['status'] | 'error' | 'skipped';
  readonly runId: number | null;
  readonly error: string | null;
}

const epNoOf = (db: DatabaseSync, id: string): number | null => {
  const outline = latestArtifactDoc(db, 'outline')?.doc as { episodes?: { id?: unknown; ep?: unknown }[] } | undefined;
  const e = (outline?.episodes ?? []).find((x) => x.id === id);
  return typeof e?.ep === 'number' ? e.ep : null;
};

/**
 * 一次打回多集前的检查：意见非空、有产物、配方按集跑、每集都认得出；集去重，按集号排。
 * 返回集 id 列表（和集号），界面在开后台任务前先调它。
 */
export function checkRejectMany(db: DatabaseSync, stage: Stage, opts: { episodes: readonly string[]; note: string }): { note: string; episodes: { id: string; ep: number | null }[] } {
  if (!opts.episodes.length) throw new Error('一次打回多集至少选一集');
  const recipe = RECIPES[currentMount(db, stage)?.recipe ?? ''];
  if (!recipe?.perEpisode) throw new Error(`${stage} 是整份负责的，不能按集打回`);
  const { note } = checkReject(db, stage, { note: opts.note });
  const ids = [...new Set(opts.episodes.map((ref) => resolveEpisode(db, ref)))];
  const episodes = ids.map((id) => ({ id, ep: epNoOf(db, id) })).sort((a, b) => (a.ep ?? 0) - (b.ep ?? 0));
  return { note, episodes };
}

/**
 * 同一条意见依次打回几集：每集一条打回记录、一次运行（和单集打回一样），一集失败（模型报错、余额不足、转人工）
 * 记下原因、接着跑下一集，已经跑完的不受影响；连着两集出同样的错就不再试剩下的。
 */
export async function rejectMany(project: Project, stage: Stage, opts: Omit<RejectOptions, 'episode'> & { readonly episodes: readonly string[] }): Promise<{ episodes: EpisodeRejectResult[]; pending: readonly MatrixCell[] }> {
  const { db } = project;
  const { note, episodes } = checkRejectMany(db, stage, opts);
  const { episodes: _e, ...rest } = opts;
  const results: EpisodeRejectResult[] = [];
  for (const [i, e] of episodes.entries()) {
    try {
      const r = await reject(project, stage, { ...rest, note, episode: e.id });
      results.push({ episode: e.id, ep: e.ep, status: r.outcome.status, runId: r.outcome.runId, error: r.outcome.status === 'passed' ? null : (r.outcome.message ?? null) });
    } catch (err) {
      results.push({ episode: e.id, ep: e.ep, status: 'error', runId: null, error: err instanceof Error ? err.message : String(err) });
    }
    // 连着两集出同样的错（余额不足、凭据缺失这类整体性的问题）：剩下的不再白试
    const [prev, last] = results.slice(-2);
    if (prev && last && last.error && prev.error === last.error) {
      for (const rest2 of episodes.slice(i + 1)) results.push({ episode: rest2.id, ep: rest2.ep, status: 'skipped', runId: null, error: `前面连着两集都是同样的错，没再试：${last.error}` });
      break;
    }
  }
  return { episodes: results, pending: pendingCells(db) };
}

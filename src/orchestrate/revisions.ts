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

export async function reject(project: Project, stage: Stage, opts: RejectOptions): Promise<RejectResult> {
  const { db } = project;
  const note = opts.note.trim();
  if (!note) throw new Error('打回要写意见（--note）');
  const base = latestArtifact(db, stage);
  if (!base) throw new Error(`${stage} 还没有产物，没什么可打回的：先 go 或 run`);
  const recipe = RECIPES[currentMount(db, stage)?.recipe ?? ''];
  if (opts.episode !== undefined && !recipe?.perEpisode) throw new Error(`${stage} 是整份负责的，不能只打回其中一集（去掉 --ep）`);
  const episode = opts.episode === undefined ? null : resolveEpisode(db, opts.episode);
  const request = addRevisionRequest(db, { stage, episodeKey: episode, note, baseArtifactVersionId: base.id });
  const { episode: _e, note: _n, ...run } = opts;
  const outcome = await runNode(project, stage, { ...run, revise: { note, requestId: request.id }, ...(episode ? { episodes: [episode] } : {}) });
  return { request, outcome, pending: pendingCells(db) };
}

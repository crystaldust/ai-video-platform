// 只补出图提示词（backlog #33）：拿现有角色卡只跑 character-refs、只写 characterRefs，不重写角色卡。
// 角色卡整张进了角色的版本（projections/cast.ts），补了提示词角色就换版本，分镜会因此被标需复核；
// 但外形没变，所以补完把这次新冒出来的需复核格子确认掉（原来就需复核的不动）。按内容判断复核（#34）做完后可以去掉这一步。
import { runNode, type RunNodeOptions, type RunOutcome } from '../executor/run-node.ts';
import type { Project } from '../project.ts';
import { acknowledge, pendingCells } from './review-matrix.ts';

export const REFS_ONLY_NOTE = '只补出图提示词，外形没变';

const keyOf = (c: { readonly stage: string; readonly episode: string | null }): string => `${c.stage}|${c.episode ?? ''}`;

export async function fillCharacterRefs(project: Project, opts: Omit<RunNodeOptions, 'refsOnly' | 'revise' | 'episodes'>): Promise<{ outcome: RunOutcome; acknowledged: number }> {
  const { db } = project;
  const before = new Set(pendingCells(db).map(keyOf));
  const outcome = await runNode(project, 'cast', { ...opts, refsOnly: true });
  if (outcome.status !== 'passed') return { outcome, acknowledged: 0 };
  // 只确认原因全部是「角色卡换了版本」的新格子：同一时间别处（比如命令行）改了别的上游，那些需复核要留给人看
  const fresh = pendingCells(db).filter((c) => !before.has(keyOf(c)) && c.reasons.length > 0 && c.reasons.every((r) => r.to.kind === 'character' && r.to.facet === 'cast'));
  for (const c of fresh) acknowledge(db, c.stage, c.episode, REFS_ONLY_NOTE);
  return { outcome, acknowledged: fresh.length };
}

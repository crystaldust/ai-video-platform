// 只补出图提示词（backlog #33）：拿现有角色卡只跑 character-refs、只写 characterRefs，不重写角色卡。
// 角色卡会因此换版本，但分镜不读 characterRefs（domain/reads.ts），需复核按内容判断（#34），所以不会冒出需复核。
import { runNode, type RunNodeOptions, type RunOutcome } from '../executor/run-node.ts';
import type { Project } from '../project.ts';

export async function fillCharacterRefs(project: Project, opts: Omit<RunNodeOptions, 'refsOnly' | 'revise' | 'episodes'>): Promise<{ outcome: RunOutcome }> {
  return { outcome: await runNode(project, 'cast', { ...opts, refsOnly: true }) };
}

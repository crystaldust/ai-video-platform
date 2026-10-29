// 测试用：注册仓库里真实的 novel 包（skill 用 test/fixtures/skills 的副本），设好渡口原文与参数。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECIPE_NAMES } from '../../src/executor/recipes.ts';
import type { Project } from '../../src/project.ts';
import { addInput } from '../../src/repo/inputs.ts';
import { registerPack } from '../../src/repo/skills.ts';
import { DUKO_BOOK } from '../helpers.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILLS = join(ROOT, 'test', 'fixtures', 'skills');

export const novelManifest = (): { skills: { name: string }[] } & Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, 'packs', 'novel.pack.json'), 'utf8'));

/** 副本里没有 character-refs：注册时记问题不阻断。manifest 可以换成删掉某些 skill 的版本。 */
export async function setupNovel(project: Project, manifest: unknown = novelManifest()): Promise<void> {
  await registerPack(project.db, manifest, SKILLS, RECIPE_NAMES);
  addInput(project.db, { kind: 'novel', text: DUKO_BOOK, params: { episodes: 6, seconds: 120, genre: '民国情感悬疑' } });
}

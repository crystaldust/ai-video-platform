// skill 包清单：哪个 skill 挂哪个阶段、脚本在哪、用哪个配方。清单是用户提供的文件，逐字段校验，不信任。
// 名称、版本不信清单，注册时从各 SKILL.md 读。
import { isAbsolute, normalize, sep } from 'node:path';
import { isStage, type Stage } from '../domain/types.ts';

export interface ManifestSkill {
  readonly name: string;
  /** null：非文本节点（如出图），先注册、不挂载 */
  readonly stage: Stage | null;
  /** 相对 skill 目录的脚本路径；只有提示词的 skill 为 null */
  readonly script: string | null;
  /** 执行配方名；非文本节点为 null */
  readonly recipe: string | null;
}

export interface PackManifest {
  readonly name: string;
  readonly description: string;
  /** 挂到依赖稳定 id 的阶段时要求的最低主版本 */
  readonly requiresMajor: number | null;
  readonly skills: readonly ManifestSkill[];
}

const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** 相对路径且不跳出所在目录。 */
export const isContainedPath = (p: string): boolean => {
  if (!p || isAbsolute(p)) return false;
  const n = normalize(p);
  return n !== '..' && !n.startsWith(`..${sep}`) && !n.split(sep).includes('..');
};

function parseSkill(x: unknown, i: number, recipes: ReadonlySet<string>, problems: string[]): ManifestSkill | null {
  const where = `skills 第 ${i + 1} 项`;
  if (!isRecord(x)) {
    problems.push(`${where}不是对象`);
    return null;
  }
  const { name, stage, script, recipe } = x;
  const before = problems.length;
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) problems.push(`${where}的 name 不合法：${String(name)}`);
  if (stage !== null && !isStage(stage)) problems.push(`${where}的 stage 不认识：${String(stage)}`);
  if (script !== null && (typeof script !== 'string' || !isContainedPath(script))) {
    problems.push(`${where}的 script 必须是 skill 目录内的相对路径：${String(script)}`);
  }
  if (recipe !== null && (typeof recipe !== 'string' || !recipes.has(recipe))) {
    problems.push(`${where}的 recipe 不认识：${String(recipe)}（可选 ${[...recipes].join(' / ')}）`);
  }
  if (stage !== null && recipe === null) problems.push(`${where}挂了阶段 ${String(stage)} 却没有 recipe`);
  if (problems.length > before) return null;
  return { name: name as string, stage: stage as Stage | null, script: script as string | null, recipe: recipe as string | null };
}

export function parseManifest(doc: unknown, recipes: ReadonlySet<string>): PackManifest {
  if (!isRecord(doc)) throw new Error('skill 包清单不是 JSON 对象');
  const problems: string[] = [];
  const name = typeof doc['name'] === 'string' && SKILL_NAME.test(doc['name']) ? doc['name'] : '';
  if (!name) problems.push(`清单 name 不合法：${String(doc['name'])}`);
  const requires = doc['requires'];
  const major = isRecord(requires) ? requires['major'] : undefined;
  if (requires !== undefined && !(Number.isInteger(major) && (major as number) >= 1)) problems.push(`清单 requires.major 必须是正整数：${String(major)}`);
  const list = Array.isArray(doc['skills']) ? doc['skills'] : [];
  if (!list.length) problems.push('清单 skills 必须是非空数组');
  const skills = list.map((s, i) => parseSkill(s, i, recipes, problems));
  const names = skills.flatMap((s) => (s ? [s.name] : []));
  const dupName = names.find((n, i) => names.indexOf(n) !== i);
  if (dupName) problems.push(`清单里 skill ${dupName} 出现了不止一次`);
  const stages = skills.flatMap((s) => (s?.stage ? [s.stage] : []));
  const dupStage = stages.find((s, i) => stages.indexOf(s) !== i);
  if (dupStage) problems.push(`同一阶段只能挂一个 skill：${dupStage} 出现了不止一次`);
  if (problems.length) throw new Error(`skill 包清单有 ${problems.length} 处问题：\n  ${problems.join('\n  ')}`);
  return {
    name,
    description: typeof doc['description'] === 'string' ? doc['description'] : '',
    requiresMajor: (major as number | undefined) ?? null,
    skills: skills as ManifestSkill[],
  };
}

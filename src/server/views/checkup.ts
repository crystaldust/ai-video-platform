// 各阶段的质量门：对最新产物跑挂载 skill 自己的 checkup（逐门 ✓/✗），没有 checkup 的退回 validate（只有违规清单）。
// 结果按「这一阶段与它上游的产物版本」缓存在内存里——都不变，门的结果就不变；同一份同时被请求只跑一次。
// 临时文件写在项目的 .cache/ 下，每组版本一个目录。脚本跑挂了不缓存，下次重试。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGES, type Stage } from '../../domain/types.ts';
import { parseViolations } from '../../executor/run-node.ts';
import type { Project } from '../../project.ts';
import { latestArtifact, latestArtifactDoc } from '../../repo/artifacts.ts';
import { currentInput } from '../../repo/inputs.ts';
import { currentMount } from '../../repo/skills.ts';
import { describeFailure, probeCapabilities, runScript } from '../../skills/script-runner.ts';
import type { SkillRow } from '../../repo/skills.ts';

export interface GateResult {
  /** 门的总数；只有 validate 的 skill 不知道总数，为 null */
  readonly total: number | null;
  readonly passed: number | null;
  /** 没过的门（checkup）或违规原文（validate） */
  readonly failed: readonly string[];
}

const cache = new Map<string, Promise<GateResult>>();
const probed = new Map<string, boolean>();

/** 注册时记下的能力里有没有 checkup；4b 之前注册的记录没有这一项，现场探测一次（按脚本缓存）。 */
async function hasCheckup(skill: SkillRow): Promise<boolean> {
  if (skill.capabilities.checkup !== undefined) return skill.capabilities.checkup;
  const script = join(skill.dir, skill.script!);
  if (!probed.has(script)) probed.set(script, (await probeCapabilities(script, skill.dir)).checkup === true);
  return probed.get(script)!;
}

/** checkup / validate 要带的上游参数，同执行器 validate 的约定。 */
function extraArgs(stage: Stage, path: (s: Stage) => string | null, book: () => string): string[] {
  const opt = (flag: string, s: Stage) => {
    const p = path(s);
    return p ? [flag, p] : [];
  };
  if (stage === 'cast') return [book()];
  if (stage === 'art') return opt('--cast', 'cast');
  if (stage === 'script') return [...opt('--outline', 'outline'), ...opt('--art', 'art')];
  if (stage === 'staging') return [...opt('--script', 'script'), ...opt('--art', 'art')];
  if (stage === 'storyboard') return [...opt('--script', 'script'), ...opt('--outline', 'outline'), ...opt('--cast', 'cast'), ...opt('--art', 'art'), '--no-log'];
  return [];
}

/** checkup 输出：每门一行「✓ 名称」「✗ 名称 — 原因」，最后一行是汇总。 */
export function parseCheckup(stdout: string): GateResult {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => /^[✓✗] /.test(l) && !/(全部通过|项未过)$/.test(l));
  const failed = lines.filter((l) => l.startsWith('✗')).map((l) => l.slice(2));
  return { total: lines.length, passed: lines.length - failed.length, failed };
}

/** 门的结果取决于哪些产物：自己、各上游（对账用）、项目输入（角色卡引文对原文）。 */
function versionsKey(project: Project, stage: Stage, skillId: number): string {
  const ids = STAGES.map((s) => latestArtifact(project.db, s)?.id ?? 0).join('.');
  return `${stage}-${skillId}-${ids}-${currentInput(project.db)?.id ?? 0}`;
}

export function stageGates(project: Project, stage: Stage): Promise<GateResult | null> {
  const skill = currentMount(project.db, stage);
  if (!latestArtifact(project.db, stage) || !skill?.script) return Promise.resolve(null);
  const version = versionsKey(project, stage, skill.id);
  const key = `${project.dir}|${version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const run = runGates(project, stage, skill, join(project.dir, '.cache', 'checkup', version));
  cache.set(key, run);
  // 跑挂了（超时、起不来、没有输出）不留缓存
  run.catch(() => cache.delete(key));
  return run;
}

async function runGates(project: Project, stage: Stage, skill: SkillRow, dir: string): Promise<GateResult> {
  const { db } = project;
  mkdirSync(dir, { recursive: true });
  const write = (name: string, doc: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc));
    return p;
  };
  const self = write(`${stage}.json`, latestArtifactDoc(db, stage)!.doc);
  const upstream = (s: Stage) => {
    const a = latestArtifactDoc(db, s);
    return a ? write(`${s}.json`, a.doc) : null;
  };
  const extra = extraArgs(stage, upstream, () => write('book.txt', currentInput(db)?.text ?? ''));
  const script = join(skill.dir, skill.script!);
  if (await hasCheckup(skill)) {
    const r = await runScript(script, ['checkup', self, ...extra], { cwd: dir });
    const result = parseCheckup(r.stdout);
    if (!result.total) throw new Error(describeFailure(`${skill.name} checkup`, r));
    return result;
  }
  const r = await runScript(script, ['validate', self, ...extra], { cwd: dir });
  return { total: null, passed: null, failed: parseViolations(r.code, r.stdout, r.stderr) };
}

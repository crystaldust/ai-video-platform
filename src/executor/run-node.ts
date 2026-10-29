// 节点执行器：按挂载的 skill 和它的配方跑一个阶段，门不过就带违规原文重试，用尽转人工；通过后导入项目库。
// 每次模型调用（完整提示词、输出、违规、用量）都单独落库，不包大事务——等模型是异步的，中途崩溃也留得下记录。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Stage } from '../domain/types.ts';
import { ImportError, importArtifact } from '../import/import-artifact.ts';
import { PROJECTIONS } from '../import/projections/index.ts';
import type { TextModel } from '../model/text-model.ts';
import { RUNS_DIR, type Project } from '../project.ts';
import { latestArtifactDoc } from '../repo/artifacts.ts';
import { characterKeyIndex, sceneEpisodeIndex } from '../repo/entities.ts';
import { currentInput } from '../repo/inputs.ts';
import { createRun, endAttempt, failInterruptedRuns, finishRun, runningRun, startAttempt } from '../repo/runs.ts';
import { currentMount, type SkillRow } from '../repo/skills.ts';
import { boundarySection, parseFrontmatter, type SkillFrontmatter } from '../skills/frontmatter.ts';
import { describeFailure, runScript } from '../skills/script-runner.ts';
import { extractJson } from './json-output.ts';
import { buildPrompt } from './prompt.ts';
import { RECIPES, type AskParts, type Check, type Doc, type RecipeContext } from './recipes.ts';

export const DEFAULT_MAX_ATTEMPTS = 3;

export type ProgressEvent =
  | { readonly type: 'run-start'; readonly runId: number; readonly stage: Stage; readonly skill: string; readonly model: string }
  | { readonly type: 'attempt'; readonly runId: number; readonly step: string; readonly n: number; readonly violations: readonly string[] }
  | { readonly type: 'gate'; readonly runId: number; readonly gate: string; readonly violations: readonly string[] }
  | { readonly type: 'run-end'; readonly runId: number; readonly status: RunOutcome['status'] };

export interface RunNodeOptions {
  readonly model: TextModel;
  readonly maxAttempts?: number;
  readonly onProgress?: (e: ProgressEvent) => void;
}

export interface RunOutcome {
  readonly runId: number;
  readonly status: 'passed' | 'needs_human' | 'failed';
  readonly dir: string;
  readonly artifactV?: number;
  /** needs_human / failed 时的说明 */
  readonly message?: string;
  readonly violations?: readonly string[];
  readonly skippedHumanGates: readonly string[];
}

/**
 * 用尽尝试次数：交给人。doc 是最后一版能解析的文档（人要改的就是它），
 * raw 是最后一次解析不了的模型原始输出（另存，供排查）。
 */
export class NeedsHuman extends Error {
  readonly gate: string;
  readonly doc: Doc | null;
  readonly raw: string | null;
  readonly violations: readonly string[];
  constructor(gate: string, doc: Doc | null, violations: readonly string[], raw: string | null = null) {
    super(`${gate} 重试用尽，仍有 ${violations.length} 处违规`);
    this.name = 'NeedsHuman';
    this.gate = gate;
    this.doc = doc;
    this.raw = raw;
    this.violations = [...violations];
  }
}

/** validate 的输出：首行「✗ N 处违规」，其后每行一条。通过时 exit 0。 */
export function parseViolations(code: number, stdout: string, stderr: string): string[] {
  if (code === 0) return [];
  const lines = `${stdout}\n${stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('✗') && !l.startsWith('✓'));
  return lines.length ? lines : [describeFailure('validate', { code, stdout, stderr })];
}

const stripFrontmatter = (md: string): string => md.replace(/^---\n[\s\S]*?\n---\n/, '');

/** 本进程正在执行的运行（按项目目录分开）：同一进程里残留的 running 记录靠它认出来。 */
const ACTIVE = new Map<string, Set<number>>();
const activeSet = (dir: string): Set<number> => ACTIVE.get(dir) ?? ACTIVE.set(dir, new Set()).get(dir)!;

interface Prepared {
  readonly skill: SkillRow;
  readonly recipeName: string;
  readonly upstream: Partial<Record<Stage, Doc>>;
  readonly inputId: number | null;
  readonly params: RecipeContext['params'];
  readonly source: string | null;
  readonly md: string;
  readonly fm: SkillFrontmatter;
}

function prepare(project: Project, stage: Stage): Prepared {
  const { db } = project;
  const skill = currentMount(db, stage);
  if (!skill) throw new Error(`阶段 ${stage} 还没有挂载 skill（先运行 pack register 或 mount）`);
  const recipe = skill.recipe ? RECIPES[skill.recipe] : undefined;
  if (!recipe) throw new Error(`skill ${skill.name} 没有可用的配方：${String(skill.recipe)}`);
  const input = currentInput(db);
  if (recipe.needsInput && !input) throw new Error('还没有项目输入（先用 input 提供梗概或原文与参数）');
  const upstream: Partial<Record<Stage, Doc>> = {};
  for (const s of recipe.needs(skill)) {
    const a = latestArtifactDoc(db, s);
    if (!a) throw new Error(`${stage} 需要上游 ${s}：先跑或导入 ${s}`);
    upstream[s] = a.doc as Doc;
  }
  for (const s of recipe.optional(skill)) {
    const a = latestArtifactDoc(db, s);
    if (a) upstream[s] = a.doc as Doc;
  }
  const md = readFileSync(join(skill.dir, 'SKILL.md'), 'utf8');
  return { skill, recipeName: recipe.name, upstream, inputId: input?.id ?? null, params: input?.params ?? null, source: input?.text ?? null, md, fm: parseFrontmatter(md) };
}

/** 一次运行的状态与动作：调模型、过门、跑脚本、收尾。 */
class NodeRun {
  readonly skipped: string[] = [];
  private readonly counters = new Map<string, number>();
  /** 配方最后一道 skill 自己的门：平台门修过的文档要再过一次它 */
  private lastSkillGate: { check: Check; post?: ((doc: Doc) => Promise<Doc>) | undefined } | null = null;

  private readonly project: Project;
  private readonly stage: Stage;
  private readonly p: Prepared;
  readonly opts: RunNodeOptions;
  private readonly maxAttempts: number;
  readonly runId: number;
  readonly dir: string;

  constructor(project: Project, stage: Stage, p: Prepared, opts: RunNodeOptions, maxAttempts: number, runId: number, dir: string) {
    this.project = project;
    this.stage = stage;
    this.p = p;
    this.opts = opts;
    this.maxAttempts = maxAttempts;
    this.runId = runId;
    this.dir = dir;
  }

  emit(e: ProgressEvent): void {
    this.opts.onProgress?.(e);
  }

  private nextN(step: string): number {
    const n = (this.counters.get(step) ?? 0) + 1;
    this.counters.set(step, n);
    return n;
  }

  /** 一次模型调用 → 记一条尝试；JSON 解析不了就带违规再问，最多 maxAttempts 次。 */
  async ask(step: string, parts: AskParts, violations: readonly string[]): Promise<Doc> {
    const { db } = this.project;
    let pending = [...violations];
    let lastOutput = '';
    for (let i = 0; i < this.maxAttempts; i++) {
      const prompt = buildPrompt({ ...parts, skillDescription: this.p.fm.description, boundary: boundarySection(this.p.md), violations: pending });
      const n = this.nextN(step);
      const attemptId = startAttempt(db, { runId: this.runId, step, n, system: prompt.system, user: prompt.user });
      let result;
      try {
        result = await this.opts.model.complete(prompt);
      } catch (error) {
        endAttempt(db, attemptId, { output: null, violations: [], usage: null });
        throw error;
      }
      lastOutput = result.text;
      const parsed = extractJson(result.text);
      const bad = parsed.ok ? [] : [parsed.violation];
      endAttempt(db, attemptId, { output: result.text, violations: bad, usage: result.usage });
      this.emit({ type: 'attempt', runId: this.runId, step, n, violations: bad });
      if (parsed.ok) return parsed.value as Doc;
      pending = bad;
    }
    throw new NeedsHuman(step, null, pending, lastOutput);
  }

  /** 过门：不过就把整份文档和违规交给模型修，修完先跑 post（如补 id）再查。 */
  async gate(check: Check, doc: Doc, repair: AskParts, post?: (doc: Doc) => Promise<Doc>): Promise<Doc> {
    let current = doc;
    for (let round = 0; ; round++) {
      const violations = await check.run(current);
      this.emit({ type: 'gate', runId: this.runId, gate: check.name, violations });
      if (!violations.length) return current;
      if (round >= this.maxAttempts) throw new NeedsHuman(check.name, current, violations);
      try {
        current = await this.ask(`repair:${check.name}`, { ...repair, draft: current, draftLabel: '当前版本（需要修正）' }, violations);
      } catch (error) {
        // 修复时模型一直给不出 JSON：交给人的应该是最后一版能用的文档，而不是那段解析不了的输出
        if (error instanceof NeedsHuman) throw new NeedsHuman(check.name, current, [...violations, ...error.violations], error.raw);
        throw error;
      }
      if (post) current = await post(current);
    }
  }

  private runSkillScript(args: readonly string[]) {
    const { skill } = this.p;
    if (!skill.script) throw new Error(`skill ${skill.name} 没有脚本，不能运行 ${args[0]}`);
    return runScript(join(skill.dir, skill.script), args, { cwd: this.dir });
  }

  context(): RecipeContext {
    const { p, dir } = this;
    return {
      skill: p.skill,
      params: p.params,
      source: p.source,
      upstream: p.upstream,
      skillBody: stripFrontmatter(p.md),
      readFile: (rel) => {
        const path = join(p.skill.dir, rel);
        return existsSync(path) ? readFileSync(path, 'utf8') : '';
      },
      inPath: (s) => join(dir, 'in', `${s}.json`),
      writeWork: (name, doc) => {
        const path = join(dir, 'work', name);
        writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
        return path;
      },
      runSkill: async (args) => {
        const r = await this.runSkillScript(args);
        if (r.code !== 0) throw new Error(describeFailure(`${p.skill.name} ${args[0]}`, r));
        return r.stdout;
      },
      check: async (args) => {
        if (!p.skill.script) return [];
        const r = await this.runSkillScript(args);
        return parseViolations(r.code, r.stdout, r.stderr);
      },
      ask: (step, parts) => this.ask(step, parts, []),
      gate: (check, doc, repair, post) => {
        this.lastSkillGate = { check, post };
        return this.gate(check, doc, repair, post);
      },
      skipHumanGate: (what) => this.skipped.push(what),
    };
  }

  /**
   * 平台门：投影干跑报的问题当违规。修复可能顺手改了内容，所以同时复查配方最后一道 skill 门，
   * 修完也照样补 id——平台门通过的文档一定同时满足 skill 的质量门。
   */
  finalGate(ctx: RecipeContext, doc: Doc): Promise<Doc> {
    const { db } = this.project;
    const skillGate = this.lastSkillGate;
    const check: Check = {
      name: 'platform',
      run: async (d) => {
        const index = characterKeyIndex(db);
        const problems = PROJECTIONS[this.stage](d, { characterKeyByName: index.byName, ambiguousNames: index.ambiguous, sceneEpisode: sceneEpisodeIndex(db) }).problems;
        return [...(skillGate ? await skillGate.check.run(d) : []), ...problems];
      },
    };
    const repair: AskParts = { task: '按违规修正 JSON，使它同时通过 skill 的质量门、能被平台导入；没被点到的内容不要改动。', schema: ctx.readFile('references/schema.md'), outputSpec: `输出修正后的整份 ${this.stage}.json。` };
    return this.gate(check, doc, repair, skillGate?.post);
  }

  /** 转人工：留下最后一版能解析的文档、模型原始输出（若有）与违规。写不了文件（目录都没建起来）不影响收尾。 */
  handOver(violations: readonly string[], doc: Doc | null, raw: string | null): void {
    if (!existsSync(join(this.dir, 'out'))) return;
    if (doc) writeFileSync(join(this.dir, 'out', `${this.stage}.json`), JSON.stringify(doc, null, 2));
    if (raw !== null) writeFileSync(join(this.dir, 'out', `${this.stage}.raw.txt`), raw);
    writeFileSync(join(this.dir, 'violations.txt'), `${violations.join('\n')}\n`);
  }
}

async function execute(run: NodeRun, project: Project, stage: Stage, p: Prepared): Promise<RunOutcome> {
  const { db } = project;
  const { runId, dir, skipped } = run;
  for (const sub of ['in', 'work', 'out']) mkdirSync(join(dir, sub), { recursive: true });
  for (const [s, doc] of Object.entries(p.upstream)) writeFileSync(join(dir, 'in', `${s}.json`), JSON.stringify(doc, null, 2));
  run.emit({ type: 'run-start', runId, stage, skill: `${p.skill.name}@${p.skill.version}`, model: run.opts.model.id });
  const ctx = run.context();
  const doc = await run.finalGate(ctx, await RECIPES[p.recipeName]!.run(ctx));
  const outPath = join(dir, 'out', `${stage}.json`);
  writeFileSync(outPath, JSON.stringify(doc, null, 2));
  const imported = importArtifact(project, stage, doc, { skill: `${p.skill.name}@${p.skill.version}`, sourcePath: outPath });
  finishRun(db, runId, { status: 'passed', artifactVersionId: imported.artifactId, skippedHumanGates: skipped });
  return { runId, status: 'passed', dir, artifactV: imported.artifactV, skippedHumanGates: skipped };
}

function settle(run: NodeRun, project: Project, error: unknown, maxAttempts: number): RunOutcome {
  const { runId, dir, skipped } = run;
  if (error instanceof NeedsHuman || error instanceof ImportError) {
    const violations = error instanceof NeedsHuman ? error.violations : error.problems;
    if (error instanceof NeedsHuman) run.handOver(violations, error.doc, error.raw);
    else run.handOver(violations, null, null);
    const message = error instanceof NeedsHuman ? `${error.gate} 重试 ${maxAttempts} 次仍未通过` : '导入时引用对不上';
    finishRun(project.db, runId, { status: 'needs_human', skippedHumanGates: skipped, error: message });
    return { runId, status: 'needs_human', dir, message, violations, skippedHumanGates: skipped };
  }
  const message = error instanceof Error ? error.message : String(error);
  finishRun(project.db, runId, { status: 'failed', skippedHumanGates: skipped, error: message });
  return { runId, status: 'failed', dir, message, skippedHumanGates: skipped };
}

export async function runNode(project: Project, stage: Stage, opts: RunNodeOptions): Promise<RunOutcome> {
  const { db } = project;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error(`重试上限必须是正整数：${maxAttempts}`);
  const active = activeSet(project.dir);
  failInterruptedRuns(db, (id) => active.has(id));
  const busy = runningRun(db, stage);
  if (busy) throw new Error(`阶段 ${stage} 已有运行中的任务（run ${busy.id}），等它结束再开；确认它已经不在跑了，用 runs unlock 解开`);
  const p = prepare(project, stage);
  const runId = createRun(db, { stage, skillId: p.skill.id, model: opts.model.id, inputId: p.inputId, maxAttempts });
  active.add(runId);
  // 运行记录一建好，之后任何一步出错（建目录、写文件、进度回调、配方、导入）都要把它收尾，不能卡在 running
  const run = new NodeRun(project, stage, p, opts, maxAttempts, runId, join(project.dir, RUNS_DIR, String(runId)));
  let outcome: RunOutcome;
  try {
    outcome = await execute(run, project, stage, p);
  } catch (error) {
    outcome = settle(run, project, error, maxAttempts);
  } finally {
    active.delete(runId);
  }
  try {
    run.emit({ type: 'run-end', runId, status: outcome.status });
  } catch {
    // 运行已经收尾；进度回调自己出错不影响结果
  }
  return outcome;
}

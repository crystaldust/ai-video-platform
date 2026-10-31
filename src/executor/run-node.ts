// 节点执行器：按挂载的 skill 和它的配方跑一个阶段，门不过就带违规原文重试，用尽转人工；通过后导入项目库。
// 每次模型调用（完整提示词、输出、违规、用量）都单独落库，不包大事务——等模型是异步的，中途崩溃也留得下记录。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from '../domain/hash.ts';
import { STAGES, type Stage } from '../domain/types.ts';
import { ImportError, importArtifact } from '../import/import-artifact.ts';
import { PROJECTIONS } from '../import/projections/index.ts';
import type { TextModel, TextResult } from '../model/text-model.ts';
import { describeHit, loadPriceSources, lookupPrice, type PriceSources } from '../pricing/prices.ts';
import { RUNS_DIR, type Project } from '../project.ts';
import { latestArtifactDoc } from '../repo/artifacts.ts';
import { characterKeyIndex, sceneEpisodeIndex } from '../repo/entities.ts';
import { currentInput } from '../repo/inputs.ts';
import { createRun, endAttempt, failInterruptedRuns, finishRun, runningRun, startAttempt } from '../repo/runs.ts';
import { currentMount, type SkillRow } from '../repo/skills.ts';
import { mergeScoped } from './scoped.ts';
import { boundarySection, parseFrontmatter, type SkillFrontmatter } from '../skills/frontmatter.ts';
import { describeFailure, runScript } from '../skills/script-runner.ts';
import { extractJson } from './json-output.ts';
import { buildPrompt } from './prompt.ts';
import { episodesOf, isDoc, mergeEpisodes, OutputTruncated, passedEpisodes, planRepair, RECIPES, withTask, type AskParts, type Check, type Doc, type Recipe, type RecipeContext, type RepairSplit, type UpstreamSlices } from './recipes.ts';

export const DEFAULT_MAX_ATTEMPTS = 3;

export type ProgressEvent =
  | { readonly type: 'run-start'; readonly runId: number; readonly stage: Stage; readonly skill: string; readonly model: string }
  | { readonly type: 'attempt'; readonly runId: number; readonly step: string; readonly n: number; readonly violations: readonly string[] }
  | { readonly type: 'gate'; readonly runId: number; readonly gate: string; readonly violations: readonly string[] }
  | { readonly type: 'notice'; readonly runId: number; readonly message: string }
  /** 已写好、还没过门的集数（页面据此刷新，先显示草稿） */
  | { readonly type: 'progress'; readonly runId: number; readonly episodes: number }
  | { readonly type: 'run-end'; readonly runId: number; readonly status: RunOutcome['status'] };

export interface RunNodeOptions {
  readonly model: TextModel;
  readonly maxAttempts?: number;
  readonly onProgress?: (e: ProgressEvent) => void;
  /** 计价用的价格；不给就读本机价格来源，读不了就不计价（费用记 null） */
  readonly prices?: PriceSources | null;
  /** 只重跑这几集（集 id）；配方不能按集跑时报错 */
  readonly episodes?: readonly string[];
  /** 在当前版本上改（打回、上游变了重跑）：底稿取这一阶段最新的整份产物，意见进每一遍的提示词。只重跑几集时总是带底稿 */
  readonly revise?: { readonly note?: string; readonly requestId?: number };
  /** 由哪次编排发起 */
  readonly orchestrationId?: number;
}

/** 一次调用的实际费用：输入、输出 token 都查得到单价才算，否则 null（不猜）。 */
export function attemptCost(modelId: string, result: TextResult, prices: PriceSources | null): { amount: number; currency: string; priceRef: string } | null {
  const { inputTokens, outputTokens } = result.usage;
  if (!prices || inputTokens === null || outputTokens === null) return null;
  const pin = lookupPrice(prices, modelId, 'token_in');
  const pout = lookupPrice(prices, modelId, 'token_out');
  if (!pin || !pout || pin.entry.currency !== pout.entry.currency) return null;
  // 命中缓存的输入有单独单价就按它算；没有就按全价（宁可高估，不猜折扣）
  const pcache = lookupPrice(prices, modelId, 'token_in_cached');
  const cached = pcache && pcache.entry.currency === pin.entry.currency ? Math.min(result.usage.cachedInputTokens ?? 0, inputTokens) : 0;
  const amount = ((inputTokens - cached) * pin.entry.price + cached * (pcache?.entry.price ?? 0) + outputTokens * pout.entry.price) / 1_000_000;
  return { amount: Math.round(amount * 1e6) / 1e6, currency: pin.entry.currency, priceRef: `in ${pin.entry.price} / out ${pout.entry.price} 每百万，${describeHit(pout)}，${pout.entry.source}` };
}

const truncationMessage = (r: TextResult): string => {
  const { outputTokens, reasoningTokens } = r.usage;
  const used = outputTokens === null ? '' : `已用 ${outputTokens} tokens${reasoningTokens ? `，其中推理 ${reasoningTokens}` : ''}`;
  return `输出被截断（撞上输出上限${used ? `：${used}` : ''}），原样重试结果相同`;
};

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
  readonly episodes: readonly string[] | null;
  readonly base: Doc | null;
}

/** 按集重跑时，集 id 要在哪份上游里找：剧本看大纲，站位、分镜看剧本。 */
export const EPISODE_SOURCE: Partial<Record<Stage, Stage>> = { script: 'outline', staging: 'script', storyboard: 'script' };

/** 上游文档里的集 id，按文档顺序。 */
export const episodeIdsOf = (doc: unknown): string[] =>
  (doc && typeof doc === 'object' && Array.isArray((doc as Doc)['episodes']) ? ((doc as Doc)['episodes'] as Doc[]) : []).flatMap((e) => (typeof e?.['id'] === 'string' ? [e['id'] as string] : []));

/** 校验集 id 都在上游里，并按上游的集顺序排好（配方按它分批，乱序会拼出倒着的区间）。 */
function orderEpisodes(stage: Stage, upstream: Partial<Record<Stage, Doc>>, episodes: readonly string[]): string[] {
  const source = EPISODE_SOURCE[stage];
  const known = episodeIdsOf(source ? upstream[source] : undefined);
  const missing = episodes.filter((id) => !known.includes(id));
  if (!episodes.length) throw new Error('按集重跑至少要给一集');
  if (missing.length) throw new Error(`上游 ${source ?? '?'} 里没有这些集：${missing.join('、')}`);
  return known.filter((id) => episodes.includes(id));
}

function prepare(project: Project, stage: Stage, opts: RunNodeOptions): Prepared {
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
  if (opts.episodes && !recipe.perEpisode) throw new Error(`${stage} 是整份负责的（配方 ${recipe.name}），不能只重跑其中几集`);
  const episodes = opts.episodes ? orderEpisodes(stage, upstream, opts.episodes) : null;
  const base = opts.revise || episodes ? ((latestArtifactDoc(db, stage)?.doc as Doc | undefined) ?? null) : null;
  if (episodes && !base) throw new Error(`${stage} 还没有产物，不能只重跑其中几集：先整阶段跑一次`);
  const md = readFileSync(join(skill.dir, 'SKILL.md'), 'utf8');
  return { skill, recipeName: recipe.name, upstream, inputId: input?.id ?? null, params: input?.params ?? null, source: input?.text ?? null, md, fm: parseFrontmatter(md), episodes, base };
}

/** 一次运行的状态与动作：调模型、过门、跑脚本、收尾。 */
class NodeRun {
  readonly skipped: string[] = [];
  /** 沿用的上一次中断前写好的那份（execute 开头查好） */
  resumed: Doc | null = null;
  /** 最近一次上报的进度（转人工时撞上截断，留下已写好的集） */
  lastProgress: Doc | null = null;
  private readonly counters = new Map<string, number>();
  /** 配方最后一道 skill 自己的门：平台门修过的文档要再过一次它 */
  private lastSkillGate: { check: Check; post?: ((doc: Doc) => Promise<Doc>) | undefined; split?: RepairSplit | undefined } | null = null;

  private readonly project: Project;
  private readonly stage: Stage;
  private readonly p: Prepared;
  readonly opts: RunNodeOptions;
  private readonly maxAttempts: number;
  readonly runId: number;
  readonly dir: string;
  readonly prices: PriceSources | null;
  /** 价格读不了的原因；运行开始时提示一次 */
  readonly priceProblem: string | null;

  constructor(project: Project, stage: Stage, p: Prepared, opts: RunNodeOptions, maxAttempts: number, runId: number, dir: string) {
    this.project = project;
    this.stage = stage;
    this.p = p;
    this.opts = opts;
    this.maxAttempts = maxAttempts;
    this.runId = runId;
    this.dir = dir;
    const loaded = opts.prices !== undefined ? { prices: opts.prices, problem: null } : loadPricesQuietly();
    this.prices = loaded.prices;
    this.priceProblem = loaded.problem;
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
      const note = parts.note ?? this.opts.revise?.note;
      const prompt = buildPrompt({ ...parts, note, skillDescription: this.p.fm.description, boundary: boundarySection(this.p.md), violations: pending });
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
      const cost = attemptCost(this.opts.model.id, result, this.prices);
      if (result.finishReason === 'length') {
        const msg = truncationMessage(result);
        endAttempt(db, attemptId, { output: result.text, violations: [msg], usage: result.usage, finishReason: 'length', cost });
        this.emit({ type: 'attempt', runId: this.runId, step, n, violations: [msg] });
        throw new OutputTruncated(step, msg);
      }
      const parsed = extractJson(result.text);
      const bad = parsed.ok ? [] : [parsed.violation];
      endAttempt(db, attemptId, { output: result.text, violations: bad, usage: result.usage, finishReason: result.finishReason ?? null, cost });
      this.emit({ type: 'attempt', runId: this.runId, step, n, violations: bad });
      if (parsed.ok) return parsed.value as Doc;
      pending = bad;
    }
    throw new NeedsHuman(step, null, pending, lastOutput);
  }

  /**
   * 一轮修复：违规落得到份上就逐份修、并回（见 planRepair）；否则整份修。
   * 修到一半出错转人工时，交出的是已经并回的那一版（前几份修好的不丢）。
   */
  private async repairRound(check: Check, doc: Doc, violations: readonly string[], repair: AskParts, split: RepairSplit | undefined): Promise<Doc> {
    const plan = planRepair(violations, doc, split);
    let current = doc;
    try {
      if (plan.whole) return await this.ask(`repair:${check.name}`, { ...repair, draft: doc, draftLabel: '当前版本（需要修正）' }, violations);
      for (const [key, own] of plan.parts) {
        const part = await split!.part(current, key);
        const [step, ask] = [`repair:${check.name}:${key}`, { ...part.ask, draftLabel: '当前版本（需要修正）' }];
        // 模型没交回这一份：同一份再问一次并说明漏了；还没有就留到下一轮
        const merged = part.merge(current, await this.ask(step, ask, own)) ?? part.merge(current, await this.ask(step, ask, [...own, part.missing]));
        current = merged ?? current;
      }
      return current;
    } catch (error) {
      // 修复时模型一直给不出 JSON：交给人的应该是最后一版能用的文档，而不是那段解析不了的输出
      if (error instanceof NeedsHuman) throw new NeedsHuman(check.name, current, [...violations, ...error.violations], error.raw);
      // 修复时被截断：同样交出最后一版能用的文档，而不是空手转人工
      if (error instanceof OutputTruncated) throw new NeedsHuman(check.name, current, [...violations, error.message]);
      throw error;
    }
  }

  /** 过门：不过就把文档和违规交给模型修（能按份就按份），修完先跑 post（如补 id）再查。 */
  async gate(check: Check, doc: Doc, repair: AskParts, post?: (doc: Doc) => Promise<Doc>, split?: RepairSplit): Promise<Doc> {
    let current = doc;
    for (let round = 0; ; round++) {
      const violations = await check.run(current);
      this.emit({ type: 'gate', runId: this.runId, gate: check.name, violations });
      if (!violations.length) return current;
      if (round >= this.maxAttempts) throw new NeedsHuman(check.name, current, violations);
      current = await this.repairRound(check, current, violations, repair, split);
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
      gate: (check, doc, repair, post, split) => {
        this.lastSkillGate = { check, post, split };
        return this.gate(check, doc, repair, post, split);
      },
      skipHumanGate: (what) => this.skipped.push(what),
      progress: (doc, problem) => {
        // 先写临时文件再改名：页面随时会读，不能读到写了一半的 JSON
        const path = join(this.dir, 'out', `${this.stage}.partial.json`);
        writeFileSync(`${path}.tmp`, JSON.stringify(doc));
        renameSync(`${path}.tmp`, path);
        this.lastProgress = doc;
        if (problem) this.emit({ type: 'notice', runId: this.runId, message: problem });
        this.emit({ type: 'progress', runId: this.runId, episodes: episodesOf(doc).length });
      },
      episodes: p.episodes,
      base: p.base,
      resumed: this.resumed,
      runMounted: async (stage, args) => {
        const mounted = currentMount(this.project.db, stage);
        if (!mounted?.script) throw new Error(`阶段 ${stage} 挂载的 skill 没有脚本，不能运行 ${args[0]}`);
        const r = await runScript(join(mounted.dir, mounted.script), args, { cwd: this.dir });
        if (r.code !== 0) throw new Error(describeFailure(`${mounted.name} ${args[0]}`, r));
        return r.stdout;
      },
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
    return this.gate(check, doc, repair, skillGate?.post, skillGate?.split && withTask(skillGate.split, repair.task));
  }

  /** 并回后的整份文档再过一次 skill 的门：只报告不阻断（例如剧本总时长），结果作为提示发出。 */
  async reviewWhole(whole: Doc): Promise<void> {
    const gate = this.lastSkillGate;
    if (!gate) return;
    writeFileSync(join(this.dir, 'out', `${this.stage}.whole.json`), JSON.stringify(whole, null, 2));
    const violations = await gate.check.run(whole);
    if (violations.length) this.emit({ type: 'notice', runId: this.runId, message: `并回整份后复查有 ${violations.length} 处问题（不阻断）：${violations[0]}` });
  }

  /** 转人工：留下最后一版能解析的文档、模型原始输出（若有）与违规。写不了文件（目录都没建起来）不影响收尾。 */
  handOver(violations: readonly string[], doc: Doc | null, raw: string | null): void {
    if (!existsSync(join(this.dir, 'out'))) return;
    if (doc) writeFileSync(join(this.dir, 'out', `${this.stage}.json`), JSON.stringify(doc, null, 2));
    if (raw !== null) writeFileSync(join(this.dir, 'out', `${this.stage}.raw.txt`), raw);
    writeFileSync(join(this.dir, 'violations.txt'), `${violations.join('\n')}\n`);
  }

  /** 撞上输出上限转人工时留下已写好的集（out/<stage>.kept.json）：输入不变时下一次重跑只写其余的。 */
  keep(doc: Doc | null): void {
    if (doc && episodesOf(doc).length && existsSync(join(this.dir, 'out'))) writeFileSync(join(this.dir, 'out', `${this.stage}.kept.json`), JSON.stringify(doc));
  }
}

/**
 * 续跑用的输入指纹：上游、项目参数与原文、挂载的 skill（含注册时 SKILL.md 与脚本的哈希）、模型、集范围、打回意见、底稿
 * 都一样，上一次写好的集才能沿用。
 */
function resumeKey(p: Prepared, opts: RunNodeOptions): string {
  const skill = [p.skill.id, p.skill.version, p.skill.skillMdHash, p.skill.scriptHash];
  return contentHash({ upstream: p.upstream, params: p.params, source: p.source, skill, model: opts.model.id, episodes: p.episodes, note: opts.revise?.note ?? null, base: p.base });
}

/** 读运行目录里的 JSON 文档；没有或坏了返回 null（续跑只是省钱，读不了就从头写）。 */
function readDoc(path: string): Doc | null {
  if (!existsSync(path)) return null;
  try {
    const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isDoc(doc) ? doc : null;
  } catch {
    return null;
  }
}

/**
 * 转人工的那次留下的可沿用的集：撞上输出上限的留了 kept.json（已写好的集）；
 * 质量门修复用尽的留了最后一版和违规清单，违规都落得到集上就去掉被点到的集——收尾时现算，旧版本跑出的运行也接得上。
 */
function passedOf(out: string, stage: Stage, keysOf: Recipe['keysOf']): Doc | null {
  const kept = readDoc(join(out, `${stage}.kept.json`));
  if (kept) return kept;
  const last = readDoc(join(out, `${stage}.json`));
  const list = join(out, '..', 'violations.txt');
  if (!last || !existsSync(list)) return null;
  return passedEpisodes(last, readFileSync(list, 'utf8').split('\n').filter(Boolean), keysOf);
}

/** 往前最多看几次同阶段运行（续跑只往回接连着失败、指纹相同的那一串） */
const RESUME_LOOKBACK = 20;

/**
 * 指纹不同时按集比：从那次运行的 in/ 读回它当时的上游，配上这次的其余输入重算指纹——对得上它记下的，
 * 才说明 skill、模型、参数、意见、底稿都没变、只是上游变了；再看共用部分一样，就返回「这一集的上游片没变」的判断。
 * 配方不能按集切、读不回上游、或除上游外还有别的变了：null（不沿用）。
 */
function sameEpisodes(prevDir: string, stored: string, p: Prepared, opts: RunNodeOptions, recipe: Recipe, now: UpstreamSlices | null): ((id: string) => boolean) | null {
  if (!recipe.sliceUpstream || !now) return null;
  const upstream: Partial<Record<Stage, Doc>> = {};
  for (const s of STAGES) {
    const doc = readDoc(join(prevDir, 'in', `${s}.json`));
    if (doc) upstream[s] = doc;
  }
  if (resumeKey({ ...p, upstream }, opts) !== stored) return null;
  const then = recipe.sliceUpstream(upstream);
  if (contentHash(then.shared) !== contentHash(now.shared)) return null;
  return (id) => then.episodes.has(id) && now.episodes.has(id) && contentHash(then.episodes.get(id)) === contentHash(now.episodes.get(id));
}

/**
 * 可续的那一串：同阶段从最近一次往前，连着以失败或转人工结束、输入没变的运行——
 * 故障失败（进程中断、供应商报错）取它已写好的进度（没写出进度的跳过）；转人工取它留下的过了门的那几集（被质量门点到的集重写）。
 * 输入变了但配方能按集比（见 sameEpisodes）：只取上游没变的那几集，变了的算进 changed、重写。
 * 各次留下的集按集号合起来，同一集取最新那次的；碰到通过的、输入变了又不能按集比的、或转人工的（取完它就停）就不再往前。
 */
function resumable(project: Project, stage: Stage, runId: number, p: Prepared, opts: RunNodeOptions, recipe: Recipe): { runIds: number[]; doc: Doc; changed: number } | null {
  const key = resumeKey(p, opts);
  const now = recipe.sliceUpstream ? recipe.sliceUpstream(p.upstream) : null;
  const prevs = project.db.prepare('SELECT id, status FROM node_run WHERE stage = ? AND id < ? ORDER BY id DESC LIMIT ?').all(stage, runId, RESUME_LOOKBACK) as { id: number; status: string }[];
  const found: { id: number; doc: Doc }[] = [];
  const changed = new Set<string>();
  for (const prev of prevs) {
    if (prev.status !== 'failed' && prev.status !== 'needs_human') break;
    const human = prev.status === 'needs_human';
    const dir = join(project.dir, RUNS_DIR, String(prev.id));
    const out = join(dir, 'out');
    if (!existsSync(join(out, 'resume.key'))) {
      // 还没开始写就失败（没留下指纹）：什么都没写，跳过；转人工的说不清，就停
      if (human) break;
      continue;
    }
    const stored = readFileSync(join(out, 'resume.key'), 'utf8');
    const same = stored === key ? () => true : sameEpisodes(dir, stored, p, opts, recipe, now);
    if (!same) break;
    const doc = human ? passedOf(out, stage, recipe.keysOf) : readDoc(join(out, `${stage}.partial.json`));
    const written = doc ? (episodesOf(doc).filter(isDoc) as Doc[]) : [];
    const kept = written.filter((e) => same(String(e['id'])));
    // 只算这次上游里还有的集：被删掉的集不会重写，不该报成「上游变了」
    for (const e of written) {
      const id = String(e['id']);
      if (!same(id) && (!now || now.episodes.has(id))) changed.add(id);
    }
    if (doc && kept.length) found.push({ id: prev.id, doc: { ...doc, episodes: kept } });
    // 转人工那次已经并进了更早的集、去掉了被点到的：再往前会把被点到的集的旧版本捡回来
    if (human) break;
  }
  if (!found.length) return null;
  // 从最早的往后并：后来的覆盖同一集；顶层字段取最新那次的
  const oldestFirst = [...found].reverse();
  const episodes = oldestFirst.reduce<Doc[]>((acc, f) => mergeEpisodes(acc, episodesOf(f.doc)), []);
  for (const e of episodes) if (isDoc(e)) changed.delete(String(e['id']));
  return { runIds: oldestFirst.map((f) => f.id), doc: { ...found[0]!.doc, episodes }, changed: changed.size };
}

async function execute(run: NodeRun, project: Project, stage: Stage, p: Prepared): Promise<RunOutcome> {
  const { db } = project;
  const { runId, dir, skipped } = run;
  for (const sub of ['in', 'work', 'out']) mkdirSync(join(dir, sub), { recursive: true });
  for (const [s, doc] of Object.entries(p.upstream)) writeFileSync(join(dir, 'in', `${s}.json`), JSON.stringify(doc, null, 2));
  run.emit({ type: 'run-start', runId, stage, skill: `${p.skill.name}@${p.skill.version}`, model: run.opts.model.id });
  const key = resumeKey(p, run.opts);
  writeFileSync(join(dir, 'out', 'resume.key'), key);
  const resumed = resumable(project, stage, runId, p, run.opts, RECIPES[p.recipeName]!);
  if (resumed) run.resumed = resumed.doc;
  const ctx = run.context();
  if (resumed) {
    // 先把沿用的那份记成这次的进度：这次还没写出新进度就又中断的话，下一次照样能接上
    ctx.progress(resumed.doc);
    const runs = resumed.runIds.map((id) => `run ${id}`).join('、');
    const changedNote = resumed.changed ? `；另有 ${resumed.changed} 集上游变了，重写` : '';
    run.emit({ type: 'notice', runId, message: `沿用之前（${runs}）已写好、没被质量门点到的 ${episodesOf(resumed.doc).length} 集，只写其余的${changedNote}` });
  }
  const notice = run.priceProblem ?? unpricedNotice(run.opts.model.id, run.prices);
  if (notice) run.emit({ type: 'notice', runId, message: notice });
  const doc = await run.finalGate(ctx, await RECIPES[p.recipeName]!.run(ctx));
  const outPath = join(dir, 'out', `${stage}.json`);
  writeFileSync(outPath, JSON.stringify(doc, null, 2));
  // 只重跑几集：只对这几集负责地导入，产物版本存并回后的整份
  const whole = p.episodes ? mergeScoped(stage, latestArtifactDoc(db, stage)?.doc, doc) : undefined;
  if (whole) await run.reviewWhole(whole);
  const imported = importArtifact(project, stage, doc, { skill: `${p.skill.name}@${p.skill.version}`, sourcePath: outPath, ...(whole ? { artifactDoc: whole } : {}) });
  finishRun(db, runId, { status: 'passed', artifactVersionId: imported.artifactId, skippedHumanGates: skipped });
  return { runId, status: 'passed', dir, artifactV: imported.artifactV, skippedHumanGates: skipped };
}

/** 计价是附带的：价格文件坏了不影响运行，只是不记费用——但要说出来，不能让人以为一直在记。 */
function loadPricesQuietly(): { prices: PriceSources | null; problem: string | null } {
  try {
    return { prices: loadPriceSources(), problem: null };
  } catch (error) {
    return { prices: null, problem: `价格文件读不了，本次不记费用：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 这个模型查不到单价时的提示（命令行模型不计价，不提示）。 */
function unpricedNotice(modelId: string, prices: PriceSources | null): string | null {
  if (!prices || modelId.startsWith('cmd:')) return null;
  return lookupPrice(prices, modelId, 'token_in') && lookupPrice(prices, modelId, 'token_out') ? null : `${modelId} 没有单价，本次不记费用（可在 <配置目录>/prices.json 补上）`;
}

function settle(run: NodeRun, project: Project, error: unknown, maxAttempts: number): RunOutcome {
  const { runId, dir, skipped } = run;
  if (error instanceof OutputTruncated) {
    // 已经拆到最小批次（分镜拆到单场）还截断：换更大输出上限的模型，或把这一阶段的单集内容减量
    const smallest = /:scenes:(\d+)-\1$/.test(error.step) ? '已拆到单场' : /^episodes:\d+-\d+/.test(error.step) ? '已拆到最小批次' : '这一步不分批';
    const message = `${error.step}：${error.message}；${smallest}，需要更大的输出上限或换模型`;
    run.handOver([message], null, null);
    run.keep(run.lastProgress);
    finishRun(project.db, runId, { status: 'needs_human', skippedHumanGates: skipped, error: message });
    return { runId, status: 'needs_human', dir, message, violations: [message], skippedHumanGates: skipped };
  }
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
  const p = prepare(project, stage, opts);
  const runId = createRun(db, {
    stage,
    skillId: p.skill.id,
    model: opts.model.id,
    inputId: p.inputId,
    maxAttempts,
    orchestrationId: opts.orchestrationId ?? null,
    // 一次重跑几集时逗号分隔
    episodeKey: p.episodes ? p.episodes.join(',') : null,
    revisionRequestId: opts.revise?.requestId ?? null,
  });
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

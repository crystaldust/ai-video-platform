// 配方共用：类型（配方、上下文、门）、截断后对半拆批、分批与合并分集、补 id、validate 门。
// recipes.ts 与 stage-recipes.ts 都从这里取，避免两个配方文件互相引用。
import { readFileSync } from 'node:fs';
import type { Stage } from '../domain/types.ts';
import type { InputParams } from '../repo/inputs.ts';
import type { SkillRow } from '../repo/skills.ts';
import type { PromptParts } from './prompt.ts';

export type Doc = Record<string, unknown>;

export const omit = (doc: Doc, keys: readonly string[]): Doc => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));

/** 模型输出撞上上限被截断：不能原样重试。分批的配方把批次对半拆开再问，拆到一集还截断就交给人。 */
export class OutputTruncated extends Error {
  readonly step: string;
  constructor(step: string, message: string) {
    super(message);
    this.name = 'OutputTruncated';
    this.step = step;
  }
}

/**
 * 按集写的起点：上一次中断前已写好、这次也要写的集直接沿用（只在最后整份过门时一起检查），只对剩下的集分批。
 * 全都沿用时顶层字段（source 等）取自沿用的那份。
 */
export function resumeStart(ctx: RecipeContext, nums: readonly number[]): { readonly rest: number[]; readonly head: Doc; readonly episodes: Doc[] } {
  const kept = ctx.resumed ? (episodesOf(ctx.resumed).filter(isDoc) as Doc[]).filter((e) => nums.includes(e['ep'] as number)) : [];
  const done = new Set(kept.map((e) => e['ep']));
  return { rest: nums.filter((n) => !done.has(n)), head: kept.length ? omit(ctx.resumed!, ['episodes']) : {}, episodes: kept };
}

/** 报进度：先补 id（页面要用段、切、场次 id），补不上就原样报并发提示——进度只给页面看，不影响这次运行。 */
export async function reportProgress(ctx: RecipeContext, name: string, doc: Doc, idArgs: readonly string[]): Promise<void> {
  try {
    ctx.progress(await withIds(ctx, name, doc, idArgs));
  } catch (error) {
    ctx.progress(doc, `进度草稿补 id 失败，页面上先显示没有 id 的版本：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 写 [a, b] 这一批；输出被截断就对半拆开分别写，结果按顺序拼起来。 */
export async function writeSplitting(a: number, b: number, write: (a: number, b: number) => Promise<Doc[]>): Promise<Doc[]> {
  try {
    return await write(a, b);
  } catch (error) {
    if (!(error instanceof OutputTruncated) || a >= b) throw error;
    const mid = Math.floor((a + b) / 2);
    return [...(await writeSplitting(a, mid, write)), ...(await writeSplitting(mid + 1, b, write))];
  }
}

/** 交给模型的一遍：执行器补上 skill 简介、边界和违规清单。 */
export type AskParts = Omit<PromptParts, 'skillDescription' | 'boundary' | 'violations'>;

export interface Check {
  /** 门的名字，记进尝试记录，如 validate:beats */
  readonly name: string;
  /** 检查当前文档，返回违规（空 = 通过） */
  run(doc: Doc): Promise<string[]>;
}

/**
 * 按份修：长文档（如 20 集的分镜）整份交回会撞上输出上限，违规能落到某几份（集）上时只修那几份、再并回。
 * 有违规落不到任何一份上，这一轮退回整份修。
 */
export interface RepairSplit {
  /** 这条违规落在哪几份上（如集号）；落不到返回空 */
  keysOf(violation: string, doc: Doc): string[];
  /** 修这一份：问模型的各部分（draft 是这一份）、把修好的并回整份（模型没交回这一份时返回 null）、没交回时补问用的违规 */
  part(doc: Doc, key: string): Promise<{ readonly ask: AskParts; merge(doc: Doc, fixed: Doc): Doc | null; readonly missing: string }>;
}

/** 按集分份时一集的键（违规落到哪几集、修哪几集都用它）。 */
export const episodeKey = (ep: number): string => `ep${String(ep)}`;

/**
 * 转人工时过了门的那几集：剩下的违规都落得到集上，就去掉被点到的集、留下其余的（下次重跑沿用）。
 * 有违规落不到集上、没法分份、或每集都被点到时返回 null——说不清哪几集是好的，就不沿用。
 */
export function passedEpisodes(doc: Doc, violations: readonly string[], split: RepairSplit | undefined): Doc | null {
  if (!split) return null;
  const hit = violations.map((v) => split.keysOf(v, doc));
  if (hit.some((keys) => !keys.length)) return null;
  const flagged = new Set(hit.flat());
  const kept = episodesOf(doc).filter((e) => isDoc(e) && !flagged.has(episodeKey(e['ep'] as number)));
  return kept.length ? { ...doc, episodes: kept } : null;
}

/** 每一份的任务说明前面加上一段修复要求（平台门按集修时带上「能被平台导入」）。 */
export const withTask = (split: RepairSplit, task: string): RepairSplit => ({
  keysOf: (violation, doc) => split.keysOf(violation, doc),
  part: async (doc, key) => {
    const part = await split.part(doc, key);
    return { ...part, ask: { ...part.ask, task: `${task}\n\n${part.ask.task}` } };
  },
});

/**
 * 一轮修复怎么分：落得到份上的违规按份修（份 → 它的违规，按首次出现排序）；落不到的留到下一轮再报。
 * 一条都落不到份上（或没给 split）才整份修。
 */
export function planRepair(violations: readonly string[], doc: Doc, split: RepairSplit | undefined): { readonly parts: ReadonlyMap<string, readonly string[]>; readonly whole: boolean } {
  const parts = new Map<string, string[]>();
  for (const v of split ? violations : []) {
    for (const key of split!.keysOf(v, doc)) parts.set(key, [...(parts.get(key) ?? []), v]);
  }
  return { parts, whole: parts.size === 0 };
}

export interface RecipeContext {
  readonly skill: SkillRow;
  readonly params: InputParams | null;
  readonly source: string | null;
  /** 上游产物（已写进运行目录 in/<stage>.json） */
  readonly upstream: Readonly<Partial<Record<Stage, Doc>>>;
  /** skill 目录下的文件；不存在返回空串 */
  readFile(rel: string): string;
  /** SKILL.md 去掉 frontmatter 的正文 */
  readonly skillBody: string;
  /** 上游在运行目录里的路径（给脚本当参数） */
  inPath(stage: Stage): string;
  /** 把文档写进运行目录 work/，返回路径 */
  writeWork(name: string, doc: unknown): string;
  /** 跑 skill 脚本，返回 stdout；非零退出抛错（seed 这类不该失败的命令用） */
  runSkill(args: readonly string[]): Promise<string>;
  /** 跑 skill 的 validate 一类命令，返回违规清单 */
  check(args: readonly string[]): Promise<string[]>;
  /** 调模型拿一份 JSON；输出解析不了会带违规重试 */
  ask(step: string, parts: AskParts): Promise<Doc>;
  /** 过门：不过就把整份文档和违规交给模型修（给了 split 且违规都落得到份上，就逐份修），每轮修完先跑 post（如补 id）再查 */
  gate(check: Check, doc: Doc, repair: AskParts, post?: (doc: Doc) => Promise<Doc>, split?: RepairSplit): Promise<Doc>;
  /** 记一个被跳过的「人工拍板」点 */
  skipHumanGate(what: string): void;
  /** 记下已写好、还没过门的进度（按集写的阶段每批写完调一次），页面运行中据此先显示；不入库。problem 作为运行提示发出 */
  progress(doc: Doc, problem?: string): void;
  /** 只处理这几集（集 id，按大纲顺序）；null = 整个阶段。只有 perEpisode 的配方会收到非 null */
  readonly episodes: readonly string[] | null;
  /** 改这一版：这一阶段当前的整份文档（打回、上游变了重跑时给）；null = 从头写 */
  readonly base: Doc | null;
  /** 上一次同阶段运行故障中断前已写好的那份（输入没变才有，见 run-node 的 resumable）；配方只写剩下的集 */
  readonly resumed: Doc | null;
  /** 跑另一个阶段挂载的 skill 的脚本（如分镜要站位的 blocking），返回 stdout；非零退出抛错 */
  runMounted(stage: Stage, args: readonly string[]): Promise<string>;
}

export interface Recipe {
  readonly name: string;
  /** 必须已有的上游 */
  needs(skill: SkillRow): readonly Stage[];
  /** 有就带上的上游 */
  optional(skill: SkillRow): readonly Stage[];
  /** 需要项目输入（梗概 / 原文） */
  readonly needsInput: boolean;
  /** 能只重跑其中几集（产物按集负责）；大纲、角色、美术是整份负责，不能 */
  readonly perEpisode: boolean;
  run(ctx: RecipeContext): Promise<Doc>;
}

/** 1..n 按 size 分批，返回 [起, 止] 闭区间。 */
export function batches(n: number, size: number): [number, number][] {
  const out: [number, number][] = [];
  for (let a = 1; a <= n; a += size) out.push([a, Math.min(n, a + size - 1)]);
  return out;
}

/**
 * 按集号分批（返回 nums 里的位置，1 起）：每批只含连续的集号——seed 和问模型都按「起–止」取集，
 * 跨过缺口会把中间不该写的集（沿用的、不在这次范围里的）也写一遍。
 */
export function contiguousBatches(nums: readonly number[], size: number): [number, number][] {
  const out: [number, number][] = [];
  let start = 1;
  for (let i = 1; i <= nums.length; i++) {
    if (i < nums.length && nums[i] === nums[i - 1]! + 1) continue;
    for (const [a, b] of batches(i - start + 1, size)) out.push([start + a - 1, start + b - 1]);
    start = i + 1;
  }
  return out;
}

/** 按 ep 合并分集：后来的覆盖同 ep 的，结果按 ep 排序。 */
export function mergeEpisodes(existing: readonly unknown[], incoming: readonly unknown[]): Doc[] {
  const byEp = new Map<number, Doc>();
  for (const e of [...existing, ...incoming]) {
    if (e && typeof e === 'object' && Number.isInteger((e as Doc)['ep'])) byEp.set((e as Doc)['ep'] as number, e as Doc);
  }
  return [...byEp.entries()].sort(([a], [b]) => a - b).map(([, e]) => e);
}

export const episodesOf = (doc: Doc): unknown[] => (Array.isArray(doc['episodes']) ? doc['episodes'] : []);

/** 写进工作目录 → 跑 ids --write → 读回。 */
export async function withIds(ctx: RecipeContext, name: string, doc: Doc, extra: readonly string[]): Promise<Doc> {
  const path = ctx.writeWork(name, doc);
  await ctx.runSkill(['ids', path, '--write', ...extra]);
  return JSON.parse(readFileSync(path, 'utf8')) as Doc;
}

export const validateCheck = (ctx: RecipeContext, name: string, file: string, extra: readonly string[] = []): Check => ({
  name,
  run: (doc) => ctx.check(['validate', ctx.writeWork(file, doc), ...extra]),
});


/** 合并成一个门：依次跑，违规拼在一起。修复时模型一次看到全部问题。 */
export const allChecks = (name: string, checks: readonly Check[]): Check => ({
  name,
  run: async (doc) => (await Promise.all(checks.map((c) => c.run(doc)))).flat(),
});

export const isDoc = (x: unknown): x is Doc => x !== null && typeof x === 'object' && !Array.isArray(x);
/** doc[field] 里是对象的那些项；不是数组就是空。 */
export const listOf = (doc: unknown, field: string): Doc[] => (isDoc(doc) && Array.isArray(doc[field]) ? (doc[field] as unknown[]).filter(isDoc) : []);

/** 文档里这些集 id 对应的集号，按文档顺序；找不到的集 id 报错（集号是给 seed --eps 用的）。 */
export function episodeNumbers(doc: Doc, ids: readonly string[]): number[] {
  const byId = new Map(episodesOf(doc).filter(isDoc).map((e) => [e['id'], e['ep']] as const));
  return ids.map((id) => {
    const n = byId.get(id);
    if (!Number.isInteger(n)) throw new Error(`上游里找不到集 ${id}`);
    return n as number;
  });
}

/** 底稿里集 id 在 ids 里的那几集；没有底稿就是 undefined（提示词里不出现底稿段）。 */
export function baseEpisodes(base: Doc | null, ids: ReadonlySet<unknown>): Doc[] | undefined {
  if (!base) return undefined;
  return episodesOf(base).filter((e): e is Doc => isDoc(e) && ids.has(e['id']));
}

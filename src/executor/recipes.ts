// 配方：一个 skill 在平台里怎么跑。每个配方是一个 async 函数，靠执行器给的上下文调用模型、跑 skill 脚本、过门。
// 门不过就进修复循环（见 run-node.ts 的 gate）；平台门（投影检查）由执行器在配方之后统一执行。
import { readFileSync } from 'node:fs';
import type { Stage } from '../domain/types.ts';
import type { InputParams } from '../repo/inputs.ts';
import type { SkillRow } from '../repo/skills.ts';
import type { PromptParts } from './prompt.ts';

export type Doc = Record<string, unknown>;

/** 模型输出撞上上限被截断：不能原样重试。分批的配方把批次对半拆开再问，拆到一集还截断就交给人。 */
export class OutputTruncated extends Error {
  readonly step: string;
  constructor(step: string, message: string) {
    super(message);
    this.name = 'OutputTruncated';
    this.step = step;
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
  /** 过门：不过就把整份文档和违规交给模型修，每轮修完先跑 post（如补 id）再查 */
  gate(check: Check, doc: Doc, repair: AskParts, post?: (doc: Doc) => Promise<Doc>): Promise<Doc>;
  /** 记一个被跳过的「人工拍板」点 */
  skipHumanGate(what: string): void;
}

export interface Recipe {
  readonly name: string;
  /** 必须已有的上游 */
  needs(skill: SkillRow): readonly Stage[];
  /** 有就带上的上游 */
  optional(skill: SkillRow): readonly Stage[];
  /** 需要项目输入（梗概 / 原文） */
  readonly needsInput: boolean;
  run(ctx: RecipeContext): Promise<Doc>;
}

const OUTLINE_BATCH = 10;
const SCRIPT_BATCH = 3;

/** 1..n 按 size 分批，返回 [起, 止] 闭区间。 */
export function batches(n: number, size: number): [number, number][] {
  const out: [number, number][] = [];
  for (let a = 1; a <= n; a += size) out.push([a, Math.min(n, a + size - 1)]);
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

const episodesOf = (doc: Doc): unknown[] => (Array.isArray(doc['episodes']) ? doc['episodes'] : []);

/** 写进工作目录 → 跑 ids --write → 读回。 */
async function withIds(ctx: RecipeContext, name: string, doc: Doc, extra: readonly string[]): Promise<Doc> {
  const path = ctx.writeWork(name, doc);
  await ctx.runSkill(['ids', path, '--write', ...extra]);
  return JSON.parse(readFileSync(path, 'utf8')) as Doc;
}

const validateCheck = (ctx: RecipeContext, name: string, file: string, extra: readonly string[] = []): Check => ({
  name,
  run: (doc) => ctx.check(['validate', ctx.writeWork(file, doc), ...extra]),
});

const novelOutline: Recipe = {
  name: 'novel-outline',
  needs: () => [],
  optional: () => [],
  needsInput: true,
  async run(ctx) {
    const schema = ctx.readFile('references/schema.md');
    const base = { schema, params: ctx.params ?? undefined, source: ctx.source ?? undefined };
    const skeletonTask: AskParts = {
      ...base,
      task: ctx.readFile('references/outline-pass.md'),
      outputSpec: '输出 outline.json 的骨架：source、params、adaptation、characters、scenes、props、beats；不要写 episodes。',
    };
    let skeleton = await ctx.ask('skeleton', skeletonTask);
    skeleton = await ctx.gate(validateCheck(ctx, 'validate:beats', 'outline.json', ['--stage', 'beats']), skeleton, {
      ...skeletonTask,
      outputSpec: '输出修正后的整份骨架（同样不写 episodes）。',
    });
    ctx.skipHumanGate('novel-outline Step 3：快版骨架由用户拍板（砍了哪条线、合了哪些人、大爆点落在第几集）');

    const total = ctx.params?.episodes ?? 0;
    let episodes: Doc[] = [];
    const writeEpisodes = async (a: number, b: number): Promise<Doc[]> => {
      const part = await ctx.ask(`episodes:${a}-${b}`, {
        ...base,
        task: ctx.readFile('references/episode-pass.md'),
        draft: skeleton,
        draftLabel: '拍板后的骨架',
        range: `第 ${a}–${b} 集`,
        outputSpec: '只输出 {"episodes": [...]}，每集写 ep（集号）及 schema 要求的字段。',
      });
      return episodesOf(part) as Doc[];
    };
    for (const [a, b] of batches(total, OUTLINE_BATCH)) {
      episodes = mergeEpisodes(episodes, await writeSplitting(a, b, writeEpisodes));
    }
    const post = (d: Doc) => withIds(ctx, 'outline.json', d, []);
    const doc = await post({ ...skeleton, episodes });
    return ctx.gate(validateCheck(ctx, 'validate', 'outline.json'), doc, { ...base, task: ctx.readFile('references/episode-pass.md'), outputSpec: '输出修正后的整份 outline.json。' }, post);
  },
};

const novelScript: Recipe = {
  name: 'novel-script',
  needs: () => ['outline'],
  optional: () => ['art'],
  needsInput: false,
  async run(ctx) {
    const outline = ctx.upstream.outline as Doc;
    const schema = ctx.readFile('references/schema.md');
    const task = ctx.readFile('references/script-pass.md');
    const eps = episodesOf(outline).map((e) => (e as Doc)['ep']).filter((n): n is number => Number.isInteger(n));
    const upstream = { outline, ...(ctx.upstream.art ? { art: ctx.upstream.art } : {}) };
    let head: Doc = {};
    let episodes: Doc[] = [];
    // a、b 是大纲里的位置（1 起）；seed 的 --eps 用集号
    const writeEpisodes = async (a: number, b: number): Promise<Doc[]> => {
      const [from, to] = [eps[a - 1]!, eps[b - 1]!];
      const seed = JSON.parse(await ctx.runSkill(['seed', ctx.inPath('outline'), '--eps', `${from}-${to}`])) as Doc;
      if (!Object.keys(head).length) head = Object.fromEntries(Object.entries(seed).filter(([k]) => k !== 'episodes'));
      const part = await ctx.ask(`episodes:${from}-${to}`, {
        schema,
        task,
        params: ctx.params ?? undefined,
        upstream,
        draft: seed,
        draftLabel: '骨架（seed 预填）',
        range: `第 ${from}–${to} 集`,
        outputSpec: '只输出 {"episodes": [...]}，沿用骨架里每集的 ep 与 id，补全 scenes。',
      });
      return episodesOf(part) as Doc[];
    };
    for (const [a, b] of batches(eps.length, SCRIPT_BATCH)) {
      episodes = mergeEpisodes(episodes, await writeSplitting(a, b, writeEpisodes));
    }
    const post = (d: Doc) => withIds(ctx, 'script.json', d, ['--outline', ctx.inPath('outline')]);
    const doc = await post({ ...head, episodes });
    const extra = ['--outline', ctx.inPath('outline'), ...(ctx.upstream.art ? ['--art', ctx.inPath('art')] : [])];
    return ctx.gate(validateCheck(ctx, 'validate', 'script.json', extra), doc, { schema, task, upstream, outputSpec: '输出修正后的整份 script.json。' }, post);
  },
};

/** 通用单遍配方的阶段约定：要哪些上游、seed / ids / validate 的额外参数。 */
const STAGE_IO: Readonly<Record<Stage, { needs: Stage[]; optional: Stage[] }>> = {
  outline: { needs: [], optional: [] },
  cast: { needs: ['outline'], optional: [] },
  art: { needs: ['outline'], optional: ['cast'] },
  script: { needs: ['outline'], optional: ['art'] },
  staging: { needs: ['script', 'art'], optional: ['outline'] },
  storyboard: { needs: ['script'], optional: ['staging', 'outline', 'cast', 'art'] },
};

function seedArgs(ctx: RecipeContext, stage: Stage): string[] | null {
  const has = (s: Stage) => Boolean(ctx.upstream[s]);
  if ((stage === 'cast' || stage === 'art') && has('outline')) return ['seed', ctx.inPath('outline')];
  if (stage === 'staging' && has('script')) return ['seed', ctx.inPath('script'), ...(has('art') ? ['--art', ctx.inPath('art')] : []), ...(has('outline') ? ['--outline', ctx.inPath('outline')] : [])];
  if (stage === 'storyboard' && has('script')) return ['seed', ctx.inPath('script')];
  return null;
}

function validateExtra(ctx: RecipeContext, stage: Stage, workDir: (n: string) => string): string[] {
  const opt = (flag: string, s: Stage) => (ctx.upstream[s] ? [flag, ctx.inPath(s)] : []);
  if (stage === 'cast') return ctx.source !== null ? [workDir('book.txt')] : [];
  if (stage === 'art') return opt('--cast', 'cast');
  if (stage === 'staging') return [...opt('--script', 'script'), ...opt('--art', 'art')];
  if (stage === 'storyboard') return [...opt('--script', 'script'), ...opt('--outline', 'outline'), ...opt('--cast', 'cast'), ...opt('--art', 'art')];
  if (stage === 'script') return [...opt('--outline', 'outline'), ...opt('--art', 'art')];
  return [];
}

const singlePass: Recipe = {
  name: 'single-pass',
  needs: (skill) => (skill.stage ? STAGE_IO[skill.stage].needs : []),
  optional: (skill) => (skill.stage ? STAGE_IO[skill.stage].optional : []),
  needsInput: false,
  async run(ctx) {
    const stage = ctx.skill.stage as Stage;
    const caps = ctx.skill.capabilities;
    const args = caps.seed ? seedArgs(ctx, stage) : null;
    const seed = args ? (JSON.parse(await ctx.runSkill(args)) as Doc) : undefined;
    const parts: AskParts = {
      task: ctx.skillBody,
      schema: ctx.readFile('references/schema.md'),
      params: ctx.params ?? undefined,
      source: stage === 'cast' || stage === 'outline' ? (ctx.source ?? undefined) : undefined,
      upstream: ctx.upstream,
      draft: seed,
      draftLabel: '骨架（seed 预填）',
      outputSpec: `输出完整的 ${stage}.json。`,
    };
    let doc = await ctx.ask('single', parts);
    const file = `${stage}.json`;
    const idsExtra = stage === 'storyboard' && ctx.upstream.script ? ['--script', ctx.inPath('script')] : stage === 'script' && ctx.upstream.outline ? ['--outline', ctx.inPath('outline')] : [];
    const post = caps.ids ? (d: Doc) => withIds(ctx, file, d, idsExtra) : undefined;
    if (post) doc = await post(doc);
    if (!caps.validate) return doc;
    const book = (n: string) => ctx.writeWork(n, ctx.source ?? '');
    return ctx.gate(validateCheck(ctx, 'validate', file, validateExtra(ctx, stage, book)), doc, { ...parts, draft: undefined, outputSpec: `输出修正后的整份 ${stage}.json。` }, post);
  },
};

export const RECIPES: Readonly<Record<string, Recipe>> = {
  [novelOutline.name]: novelOutline,
  [novelScript.name]: novelScript,
  [singlePass.name]: singlePass,
};

export const RECIPE_NAMES: ReadonlySet<string> = new Set(Object.keys(RECIPES));

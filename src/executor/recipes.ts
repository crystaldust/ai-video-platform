// 配方：一个 skill 在平台里怎么跑。每个配方是一个 async 函数，靠执行器给的上下文调用模型、跑 skill 脚本、过门。
// 门不过就进修复循环（见 run-node.ts 的 gate）；平台门（投影检查）由执行器在配方之后统一执行。
// 共用的类型与工具在 recipe-kit.ts；角色、美术、站位、分镜的专用配方在 stage-recipes.ts。
import type { Stage } from '../domain/types.ts';
import { baseEpisodes, batches, contiguousBatches, episodesOf, mergeEpisodes, omit, reportProgress, resumeStart, validateCheck, withIds, writeSplitting, type AskParts, type Doc, type Recipe, type RecipeContext } from './recipe-kit.ts';
import { STAGE_RECIPES } from './stage-recipes.ts';

export * from './recipe-kit.ts';

const OUTLINE_BATCH = 10;
const SCRIPT_BATCH = 3;

const withoutEpisodes = (doc: Doc): Doc => Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'episodes'));
/** 底稿里集号在 [a, b] 的那几集 */
const baseRange = (base: Doc | null, a: number, b: number): Doc[] | undefined =>
  base ? (episodesOf(base) as Doc[]).filter((e) => Number.isInteger(e['ep']) && (e['ep'] as number) >= a && (e['ep'] as number) <= b) : undefined;

const novelOutline: Recipe = {
  name: 'novel-outline',
  needs: () => [],
  optional: () => [],
  needsInput: true,
  perEpisode: false,
  async run(ctx) {
    const schema = ctx.readFile('references/schema.md');
    const base = { schema, params: ctx.params ?? undefined, source: ctx.source ?? undefined };
    const skeletonTask: AskParts = {
      ...base,
      base: ctx.base ? withoutEpisodes(ctx.base) : undefined,
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
        base: baseRange(ctx.base, a, b),
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
  perEpisode: true,
  async run(ctx) {
    const outline = ctx.upstream.outline as Doc;
    const schema = ctx.readFile('references/schema.md');
    const task = ctx.readFile('references/script-pass.md');
    // 只重跑几集时，只按这几集分批（集号仍取大纲里的，seed 的 --eps 认集号）
    const scope = ctx.episodes ? new Set<unknown>(ctx.episodes) : null;
    const eps = (episodesOf(outline) as Doc[]).filter((e) => !scope || scope.has(e['id'])).map((e) => e['ep']).filter((n): n is number => Number.isInteger(n));
    const upstream = { outline, ...(ctx.upstream.art ? { art: ctx.upstream.art } : {}) };
    // 上一次中断前已写好的集直接沿用（执行器已把它记成这次的进度），只对剩下的集分批写
    const start = resumeStart(ctx, eps);
    const rest = start.rest;
    let head: Doc = start.head;
    let episodes: Doc[] = start.episodes;
    // a、b 是 rest 里的位置（1 起）；seed 的 --eps 用集号
    const writeEpisodes = async (a: number, b: number): Promise<Doc[]> => {
      const [from, to] = [rest[a - 1]!, rest[b - 1]!];
      const seed = JSON.parse(await ctx.runSkill(['seed', ctx.inPath('outline'), '--eps', `${from}-${to}`])) as Doc;
      if (!Object.keys(head).length) head = omit(seed, ['episodes']);
      const part = await ctx.ask(`episodes:${from}-${to}`, {
        schema,
        task,
        params: ctx.params ?? undefined,
        upstream,
        base: baseEpisodes(ctx.base, new Set(episodesOf(seed).map((e) => (e as Doc)['id']))),
        draft: seed,
        draftLabel: '骨架（seed 预填）',
        range: `第 ${from}–${to} 集`,
        outputSpec: '只输出 {"episodes": [...]}，沿用骨架里每集的 ep 与 id，补全 scenes。',
      });
      return episodesOf(part) as Doc[];
    };
    for (const [a, b] of contiguousBatches(rest, SCRIPT_BATCH)) {
      episodes = mergeEpisodes(episodes, await writeSplitting(a, b, writeEpisodes));
      await reportProgress(ctx, 'script.partial.json', { ...head, episodes }, ['--outline', ctx.inPath('outline')]);
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
  perEpisode: false,
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
      base: ctx.base ?? undefined,
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
  ...STAGE_RECIPES,
};

export const RECIPE_NAMES: ReadonlySet<string> = new Set(Object.keys(RECIPES));

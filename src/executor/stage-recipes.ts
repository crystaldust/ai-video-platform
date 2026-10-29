// 角色、美术、站位、分镜的专用配方。都是「seed 骨架 → 按需分遍问模型 → 合并 → skill 的 validate」，
// 骨架里的事实（名单、分档、场次、节拍、出场人物）由 seed 确定性搬运，不让模型重想一遍。
// 站位、分镜能只重跑几集（产物按集负责）；底稿（ctx.base）按每一遍切片后给模型，意见由执行器统一附上。
import { STAGE_DEPS } from '../orchestrate/deps.ts';
import { parseBlocking, stagingCarryCheck } from './gates/staging-carry.ts';
import {
  allChecks,
  baseEpisodes,
  batches,
  episodeNumbers,
  episodesOf,
  isDoc,
  listOf,
  mergeEpisodes,
  validateCheck,
  withIds,
  writeSplitting,
  type AskParts,
  type Doc,
  type Recipe,
  type RecipeContext,
} from './recipe-kit.ts';
import type { Stage } from '../domain/types.ts';

const STAGING_BATCH = 3;
const STORYBOARD_BATCH = 2;

const deps = (stage: Stage) => ({ needs: () => STAGE_DEPS[stage].needs, optional: () => STAGE_DEPS[stage].optional });
const json = (x: unknown): string => JSON.stringify(x, null, 2);
const seedOf = async (ctx: RecipeContext, args: readonly string[]): Promise<Doc> => JSON.parse(await ctx.runSkill(args)) as Doc;
const refs = (ctx: RecipeContext, pairs: readonly [string, Stage][]): string[] => pairs.flatMap(([flag, s]) => (ctx.upstream[s] ? [flag, ctx.inPath(s)] : []));
const pick = (ctx: RecipeContext, stages: readonly Stage[]): Record<string, Doc> =>
  Object.fromEntries(stages.flatMap((s) => (ctx.upstream[s] ? [[s, ctx.upstream[s]]] : [])));
const readAll = (ctx: RecipeContext, files: readonly string[]): string => files.map((f) => ctx.readFile(f)).filter(Boolean).join('\n\n');
const omit = (doc: Doc, keys: readonly string[]): Doc => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));

/* ---------------------------------------------------------------- 角色卡 */

/** 名单、角色码由大纲定：模型交回的卡片以骨架的 id、name 为准，seedNote 不进成品。 */
const cardFrom = (skeleton: Doc, card: Doc): Doc => omit({ ...card, name: skeleton['name'], ...(skeleton['id'] !== undefined ? { id: skeleton['id'] } : {}) }, ['seedNote']);

const novelCharacters: Recipe = {
  name: 'novel-characters',
  ...deps('cast'),
  needsInput: true,
  perEpisode: false,
  async run(ctx) {
    const seed = await seedOf(ctx, ['seed', ctx.inPath('outline')]);
    const schema = ctx.readFile('references/schema.md');
    const task = readAll(ctx, ['references/profile-pass.md', 'references/sheet.md']);
    const skeletons = listOf(seed, 'characters');
    const names = skeletons.map((c) => String(c['name']));
    const baseCards = new Map(listOf(ctx.base, 'characters').map((c) => [c['name'], c]));
    const source = ctx.source ?? undefined;
    const cards: Doc[] = [];
    for (const c of skeletons) {
      const card = await ctx.ask(`card:${String(c['id'] ?? c['name'])}`, {
        task,
        schema,
        source,
        sections: [{ title: '同批其他角色（长相、声线不要撞车）', body: names.filter((n) => n !== c['name']).join('、') || '无' }],
        base: baseCards.get(c['name']),
        draft: c,
        draftLabel: '这个角色的骨架（seed 预填：名单、分档、弧光由大纲定，不要推翻）',
        outputSpec: '只输出这一个角色的完整角色卡（一个 JSON 对象），name 与骨架一致，seedNote 不要输出。',
      });
      cards.push(cardFrom(c, card));
    }
    const summary = await ctx.ask('summary', {
      task: '按 schema 里 summary 的要求写故事摘要：3–5 句，交代时空背景、核心情境、这几个人聚在一起的由头；不剧透结局，不写成推荐语。',
      schema,
      source,
      base: isDoc(ctx.base) && typeof ctx.base['summary'] === 'string' ? ctx.base['summary'] : undefined,
      outputSpec: '只输出 {"summary": "…"}。',
    });
    const doc: Doc = { ...omit(seed, ['characters']), summary: summary['summary'], characters: cards };
    const book = ctx.writeWork('book.txt', ctx.source ?? '');
    return ctx.gate(validateCheck(ctx, 'validate', 'cast.json', [book]), doc, { task, schema, source, outputSpec: '输出修正后的整份 cast.json。' });
  },
};

/* ---------------------------------------------------------------- 美术 */

const novelArt: Recipe = {
  name: 'novel-art',
  ...deps('art'),
  needsInput: false,
  perEpisode: false,
  async run(ctx) {
    const seed = await seedOf(ctx, ['seed', ctx.inPath('outline')]);
    const schema = ctx.readFile('references/schema.md');
    const upstream = pick(ctx, ['outline', 'cast']);
    const scenes = await ctx.ask('scenes', {
      task: ctx.readFile('references/scene-pass.md'),
      schema,
      upstream,
      base: ctx.base ? listOf(ctx.base, 'scenes') : undefined,
      draft: { scenes: seed['scenes'] },
      draftLabel: '场景骨架（seed 预填）',
      outputSpec: '只输出 {"scenes": [...]}：骨架里的每个场景都要有，id、name、primary、usage 照抄骨架，补全其余设定字段。',
    });
    const props = await ctx.ask('props', {
      task: ctx.readFile('references/prop-pass.md'),
      schema,
      upstream,
      // 大纲没有道具表时要从原文提取
      source: listOf(seed, 'props').length ? undefined : (ctx.source ?? undefined),
      base: ctx.base ? listOf(ctx.base, 'props') : undefined,
      draft: { props: seed['props'] ?? [] },
      draftLabel: '道具骨架（seed 预填）',
      outputSpec: '只输出 {"props": [...]}：骨架里有的道具都要有，id、name、usage 照抄骨架，补全设计字段。',
    });
    const doc: Doc = { ...seed, scenes: scenes['scenes'], props: props['props'] };
    return ctx.gate(validateCheck(ctx, 'validate', 'art.json', refs(ctx, [['--cast', 'cast']])), doc, {
      task: readAll(ctx, ['references/scene-pass.md', 'references/prop-pass.md']),
      schema,
      upstream,
      outputSpec: '输出修正后的整份 art.json。',
    });
  },
};

/* ---------------------------------------------------------------- 站位 */

/** 剧本里要排的几集（集号，按剧本顺序）：只重跑几集时只取这几集。 */
function scopedNumbers(ctx: RecipeContext, script: Doc): number[] {
  if (ctx.episodes) return episodeNumbers(script, ctx.episodes);
  return listOf(script, 'episodes').map((e) => e['ep']).filter((n): n is number => Number.isInteger(n));
}

const epRange = (nums: readonly number[]): string => `${Math.min(...nums)}-${Math.max(...nums)}`;

/** 认图：底稿里已经认过的地点直接沿用（只重跑几集时不动跨集共用的认图），其余交给模型。 */
async function readLocations(ctx: RecipeContext, seed: Doc, schema: string): Promise<Doc[]> {
  const known = new Map(listOf(ctx.base, 'locations').map((l) => [l['sceneId'], l]));
  const all = listOf(seed, 'locations');
  const toRead = ctx.episodes ? all.filter((l) => !known.has(l['sceneId'])) : all;
  if (!toRead.length) return all.map((l) => known.get(l['sceneId']) ?? l);
  const read = await ctx.ask('read', {
    task: ctx.readFile('references/read-pass.md'),
    schema,
    upstream: pick(ctx, ['art']),
    base: ctx.episodes ? undefined : (ctx.base ? listOf(ctx.base, 'locations') : undefined),
    draft: { locations: toRead },
    draftLabel: '地点骨架（seed 预填）',
    outputSpec: '只输出 {"locations": [...]}：骨架里每个地点都要有，sceneId、name 照抄。还没有场景图：按 art.json 的锚点与主视角提示词推算，readFrom 写 "prompt"，不写 box。',
  });
  const got = new Map(listOf(read, 'locations').map((l) => [l['sceneId'], l]));
  return all.map((l) => got.get(l['sceneId']) ?? known.get(l['sceneId']) ?? l);
}

const novelStaging: Recipe = {
  name: 'novel-staging',
  ...deps('staging'),
  needsInput: false,
  perEpisode: true,
  async run(ctx) {
    const script = ctx.upstream.script as Doc;
    const nums = scopedNumbers(ctx, script);
    const scope = new Set(nums);
    const seed = await seedOf(ctx, ['seed', ctx.inPath('script'), ...refs(ctx, [['--art', 'art'], ['--outline', 'outline']]), '--eps', epRange(nums)]);
    const seedScenes = listOf(seed, 'scenes').filter((s) => scope.has(s['ep'] as number));
    const schema = ctx.readFile('references/schema.md');
    const task = ctx.readFile('references/staging-pass.md');
    const locations = await readLocations(ctx, seed, schema);
    const head = omit(script, ['episodes']);
    const written = new Map<unknown, Doc>();
    const writeScenes = async (a: number, b: number): Promise<Doc[]> => {
      const [from, to] = [nums[a - 1]!, nums[b - 1]!];
      const inBatch = (s: Doc) => (s['ep'] as number) >= from && (s['ep'] as number) <= to;
      const batch = seedScenes.filter(inBatch);
      const used = new Set(batch.map((s) => s['sceneId']));
      const part = await ctx.ask(`episodes:${from}-${to}`, {
        task,
        schema,
        upstream: { script: { ...head, episodes: listOf(script, 'episodes').filter((e) => (e['ep'] as number) >= from && (e['ep'] as number) <= to) } },
        sections: [{ title: '认图结果（站位只能落在这些东西上）', body: json(locations.filter((l) => used.has(l['sceneId']))) }],
        base: ctx.base ? listOf(ctx.base, 'scenes').filter(inBatch) : undefined,
        draft: { scenes: batch },
        draftLabel: '站位骨架（seed 预填）',
        range: `第 ${from}–${to} 集`,
        outputSpec: '只输出 {"scenes": [...]}：骨架里这几集的每一场都要有，sceneRef、ep、scene、sceneId、lighting、cast 照抄；给 places 里每个人填 present、item、side、along、posture、facing，再填 extras、extrasWhere、why。',
      });
      return listOf(part, 'scenes');
    };
    for (const [a, b] of batches(nums.length, STAGING_BATCH)) {
      for (const s of await writeSplitting(a, b, writeScenes)) written.set(s['sceneRef'], s);
    }
    // 按骨架的场次顺序排；模型漏掉的场次留骨架，交给 validate 点名
    const scenes = seedScenes.map((s) => written.get(s['sceneRef']) ?? s);
    const doc: Doc = { ...seed, locations, scenes };
    return ctx.gate(validateCheck(ctx, 'validate', 'staging.json', refs(ctx, [['--script', 'script'], ['--art', 'art']])), doc, {
      task: readAll(ctx, ['references/read-pass.md', 'references/staging-pass.md']),
      schema,
      upstream: pick(ctx, ['art']),
      outputSpec: '输出修正后的整份 staging.json。',
    });
  },
};

/* ---------------------------------------------------------------- 分镜 */

const STORYBOARD_REFS = ['references/storyboard-pass.md', 'references/shot-writing.md', 'references/frame.md', 'references/h3-prompt.md'];

const openingSection = (opening: ReadonlyMap<string, string>, sceneRefs: readonly unknown[]) => ({
  title: '开场走位（每场第一段的 blocking 以这一句开头，逐字照抄）',
  body: sceneRefs.flatMap((r) => (opening.has(r as string) ? [`${String(r)}：${opening.get(r as string)}`] : [])).join('\n') || '（这几场没有站位）',
});

const novelStoryboard: Recipe = {
  name: 'novel-storyboard',
  ...deps('storyboard'),
  needsInput: false,
  perEpisode: true,
  async run(ctx) {
    const script = ctx.upstream.script as Doc;
    const nums = scopedNumbers(ctx, script);
    const opening = parseBlocking(await ctx.runMounted('staging', ['blocking', ctx.inPath('staging')]), ctx.upstream.staging);
    const schema = ctx.readFile('references/schema.md');
    const task = readAll(ctx, STORYBOARD_REFS);
    const upstream = pick(ctx, ['cast', 'art']);
    let head: Doc = {};
    let episodes: Doc[] = [];
    const writeEpisodes = async (a: number, b: number): Promise<Doc[]> => {
      const [from, to] = [nums[a - 1]!, nums[b - 1]!];
      const seed = await seedOf(ctx, ['seed', ctx.inPath('script'), '--eps', `${from}-${to}`, ...(ctx.params?.aspect ? ['--aspect', ctx.params.aspect] : [])]);
      if (!Object.keys(head).length) head = omit(seed, ['episodes']);
      const seedEps = listOf(seed, 'episodes').filter((e) => nums.includes(e['ep'] as number));
      const sceneRefs = seedEps.flatMap((e) => listOf(e, 'seedScenes').map((s) => s['sceneRef']));
      const part = await ctx.ask(`episodes:${from}-${to}`, {
        task,
        schema,
        upstream,
        sections: [openingSection(opening, sceneRefs)],
        base: baseEpisodes(ctx.base, new Set(seedEps.map((e) => e['id']))),
        draft: { ...seed, episodes: seedEps },
        draftLabel: '分镜底稿（seed 预填：场次、节拍与每拍秒数）',
        range: `第 ${from}–${to} 集`,
        outputSpec: '只输出 {"episodes": [...]}：沿用骨架里每集的 id 与 ep；每段写 sceneRef，每切写 beatIds（从 seedScenes 照抄），不写段 id 和切 id；输出里不要 seedScenes。',
      });
      return (episodesOf(part).filter(isDoc) as Doc[]).map((e) => omit(e, ['seedScenes']));
    };
    for (const [a, b] of batches(nums.length, STORYBOARD_BATCH)) {
      episodes = mergeEpisodes(episodes, await writeSplitting(a, b, writeEpisodes));
    }
    const post = (d: Doc) => withIds(ctx, 'storyboard.json', d, ['--script', ctx.inPath('script')]);
    const doc = await post({ ...head, episodes });
    const check = allChecks('validate', [
      validateCheck(ctx, 'validate', 'storyboard.json', refs(ctx, [['--script', 'script'], ['--outline', 'outline'], ['--cast', 'cast'], ['--art', 'art']])),
      stagingCarryCheck(opening),
    ]);
    const repair: AskParts = { task, schema, upstream, sections: [openingSection(opening, [...opening.keys()])], outputSpec: '输出修正后的整份 storyboard.json。' };
    return ctx.gate(check, doc, repair, post);
  },
};

export const STAGE_RECIPES: Readonly<Record<string, Recipe>> = {
  [novelCharacters.name]: novelCharacters,
  [novelArt.name]: novelArt,
  [novelStaging.name]: novelStaging,
  [novelStoryboard.name]: novelStoryboard,
};

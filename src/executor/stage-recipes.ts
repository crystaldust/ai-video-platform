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
  omit,
  validateCheck,
  withIds,
  reportProgress,
  contiguousBatches,
  episodeKey,
  resumeStart,
  writeSplitting,
  type AskParts,
  type Doc,
  type Recipe,
  type RecipeContext,
  type RepairSplit,
  type UpstreamSlices,
} from './recipe-kit.ts';
import type { Stage } from '../domain/types.ts';

const STAGING_BATCH = 3;
/** 推理模型的推理也算进输出上限：写 2 集一批几乎必然截断（实测推理 30k+），一上来就按单集写 */
const STORYBOARD_BATCH = 1;

const deps = (stage: Stage) => ({ needs: () => STAGE_DEPS[stage].needs, optional: () => STAGE_DEPS[stage].optional });
const json = (x: unknown): string => JSON.stringify(x, null, 2);
const seedOf = async (ctx: RecipeContext, args: readonly string[]): Promise<Doc> => JSON.parse(await ctx.runSkill(args)) as Doc;
const refs = (ctx: RecipeContext, pairs: readonly [string, Stage][]): string[] => pairs.flatMap(([flag, s]) => (ctx.upstream[s] ? [flag, ctx.inPath(s)] : []));
const pick = (ctx: RecipeContext, stages: readonly Stage[]): Record<string, Doc> =>
  Object.fromEntries(stages.flatMap((s) => (ctx.upstream[s] ? [[s, ctx.upstream[s]]] : [])));
const readAll = (ctx: RecipeContext, files: readonly string[]): string => files.map((f) => ctx.readFile(f)).filter(Boolean).join('\n\n');

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

/** 分镜要的角色「形象要点」：认人与外貌，不要出图提示词、版面指令和音色。 */
const PERSONA_KEYS = ['gender', 'ageRange', 'identity', 'appearance'];
const only = (doc: Doc, keys: readonly string[]): Doc => Object.fromEntries(keys.flatMap((k) => (doc[k] === undefined ? [] : [[k, doc[k]]])));
const idSet = (scenes: readonly Doc[], key: string): Set<string> => new Set(scenes.flatMap((s) => [s[key]].flat()).filter((x) => x !== undefined).map(String));

/**
 * 写这几场分镜要带的上游（SKILL.md：该集的场景卡 + 角色卡的形象要点）：只带这几场出场的人物、用到的场景与道具，
 * 去掉出图相关字段。整份带上的话 20 集的项目单批就有 5 万 token，推理也跟着拉长，单集都会撞上输出上限。
 */
function storyboardUpstream(ctx: RecipeContext, seedScenes: readonly Doc[]): Record<string, Doc> {
  const [characters, scenes, props] = [idSet(seedScenes, 'characters'), idSet(seedScenes, 'sceneId'), idSet(seedScenes, 'props')];
  // 旧角色卡没有 id：按大纲名单认名字
  const names = new Set(listOf(ctx.upstream.outline ?? null, 'characters').filter((c) => characters.has(String(c['id']))).map((c) => c['name']));
  const out: Record<string, Doc> = {};
  if (ctx.upstream.cast) {
    const cards = listOf(ctx.upstream.cast, 'characters').filter((c) => characters.has(String(c['id'])) || names.has(c['name']));
    out['cast'] = { characters: cards.map((c) => ({ ...only(c, ['id', 'name', 'aliases', 'oneLiner']), persona: only(isDoc(c['persona']) ? c['persona'] : {}, PERSONA_KEYS) })) };
  }
  if (ctx.upstream.art) {
    out['art'] = {
      scenes: listOf(ctx.upstream.art, 'scenes').filter((x) => scenes.has(String(x['id']))).map((x) => omit(x, ['image', 'usage'])),
      props: listOf(ctx.upstream.art, 'props').filter((x) => props.has(String(x['id']))).map((x) => omit(x, ['image', 'usage', 'relatedScenes', 'carriedBy'])),
    };
  }
  return out;
}

/** 改一版时的底稿：这几集；只写其中几场时，段也只留这几场的。 */
function storyboardBase(ctx: RecipeContext, seedEps: readonly Doc[], sceneRefs: ReadonlySet<unknown> | null): Doc[] | undefined {
  const eps = baseEpisodes(ctx.base, new Set(seedEps.map((e) => e['id'])));
  return sceneRefs && eps ? eps.map((e) => ({ ...e, segments: listOf(e, 'segments').filter((g) => sceneRefs.has(g['sceneRef'])) })) : eps;
}

/** 写分镜的一遍要用的、整次运行不变的东西。head 是 seed 去掉 episodes（source、aspectRatio）。 */
interface StoryboardPass {
  readonly ctx: RecipeContext;
  readonly task: string;
  readonly schema: string;
  readonly opening: ReadonlyMap<string, string>;
  readonly head: Doc;
}

/** 问一遍：这几集（seedScenes 已按要写的场次裁好）；onlyScenes 表示只写这一集的其中几场。 */
async function askStoryboard(sb: StoryboardPass, step: string, [from, to]: readonly [unknown, unknown], seedEps: readonly Doc[], onlyScenes: boolean): Promise<Doc[]> {
  const seedScenes = seedEps.flatMap((e) => listOf(e, 'seedScenes'));
  const sceneRefs = seedScenes.map((x) => x['sceneRef']);
  const part = await sb.ctx.ask(step, {
    task: sb.task,
    schema: sb.schema,
    upstream: storyboardUpstream(sb.ctx, seedScenes),
    sections: [openingSection(sb.opening, sceneRefs), ...(onlyScenes ? [{ title: '只写这几场（这一集的其余场次另外写，这里只交回这几场的段）', body: sceneRefs.join('\n') }] : [])],
    base: storyboardBase(sb.ctx, seedEps, onlyScenes ? new Set(sceneRefs) : null),
    draft: { ...sb.head, episodes: seedEps },
    draftLabel: '分镜底稿（seed 预填：场次、节拍与每拍秒数）',
    range: `第 ${String(from)}–${String(to)} 集`,
    outputSpec: '只输出 {"episodes": [...]}：沿用骨架里每集的 id 与 ep；每段写 sceneRef，每切写 beatIds（从 seedScenes 照抄），不写段 id 和切 id；输出里不要 seedScenes。',
  });
  return (episodesOf(part).filter(isDoc) as Doc[]).map((e) => omit(e, ['seedScenes']));
}

/**
 * 一集：先整集写；被截断就按场次对半拆开写，段按场次顺序拼回这一集（拆开写时只认分到的那几场的段）。
 * 一段都没写出来就当模型没交回这一集（同分批时一样不造空集），交给 validate 报缺。
 */
async function writeStoryboardEpisode(sb: StoryboardPass, seedEp: Doc): Promise<Doc[]> {
  const scenes = listOf(seedEp, 'seedScenes');
  const n = String(seedEp['ep']);
  const write = async (x: number, y: number): Promise<Doc[]> => {
    const whole = x === 1 && y >= scenes.length;
    const slice = scenes.slice(x - 1, y);
    const refs = new Set(slice.map((sc) => sc['sceneRef']));
    const eps = await askStoryboard(sb, whole ? `episodes:${n}-${n}` : `episodes:${n}-${n}:scenes:${x}-${y}`, [n, n], [{ ...seedEp, seedScenes: slice }], !whole);
    const segments = eps.filter((e) => e['id'] === seedEp['id'] || e['ep'] === seedEp['ep']).flatMap((e) => listOf(e, 'segments'));
    return whole ? segments : segments.filter((g) => refs.has(g['sceneRef']));
  };
  const segments = await writeSplitting(1, Math.max(1, scenes.length), write);
  return segments.length ? [{ id: seedEp['id'], ep: seedEp['ep'], segments }] : [];
}

/** 这一集的 seed（场次与节拍）：写和修都从这里抄 beatIds。 */
async function seedEpisode(ctx: RecipeContext, ep: number): Promise<Doc | null> {
  const seed = await seedOf(ctx, ['seed', ctx.inPath('script'), '--eps', `${ep}-${ep}`, ...(ctx.params?.aspect ? ['--aspect', ctx.params.aspect] : [])]);
  return listOf(seed, 'episodes').find((e) => e['ep'] === ep) ?? null;
}

/**
 * 违规落在哪几集（ep2 这样的键）：段标签 E02-01 / E02 第 1 场，或违规里提到的段 id、场次 id 所在的集。
 * known 是剧本里还有的集号：剧本里已经没有的集没有节拍底稿，按集修不了。
 */
export function storyboardKeysOf(violation: string, doc: Doc, known?: ReadonlySet<number>): string[] {
  const eps = listOf(doc, 'episodes');
  const byLabel = [...violation.matchAll(/\bE(\d+)(?!\d)/g)].map((m) => Number(m[1]));
  const byId = eps.filter((e) => listOf(e, 'segments').some((g) => [g['id'], g['sceneRef']].some((x) => typeof x === 'string' && violation.includes(x)))).map((e) => e['ep']);
  return [...new Set([...byLabel, ...byId])].filter((n) => eps.some((e) => e['ep'] === n) && (!known || known.has(n as number))).map((n) => episodeKey(n as number));
}

/** 分镜按集修：只给这一集的当前版本、节拍底稿和它用到的上游，只交回这一集，并回时 id、ep 以原集为准。 */
function storyboardSplit(sb: Omit<StoryboardPass, 'head'>): RepairSplit {
  const known = new Set(listOf(sb.ctx.upstream.script ?? null, 'episodes').map((e) => e['ep'] as number));
  return {
    keysOf: (violation, doc) => storyboardKeysOf(violation, doc, known),
    async part(doc, key) {
      const n = Number(key.slice(2));
      const current = listOf(doc, 'episodes').find((e) => e['ep'] === n)!;
      const seed = await seedEpisode(sb.ctx, n);
      const seedScenes = listOf(seed, 'seedScenes');
      const ask: AskParts = {
        task: sb.task,
        schema: sb.schema,
        upstream: storyboardUpstream(sb.ctx, seedScenes),
        sections: [openingSection(sb.opening, seedScenes.map((x) => x['sceneRef'])), { title: '这一集的节拍底稿（seed：场次、节拍与每拍秒数；beatIds 从这里照抄）', body: json(seed) }],
        draft: { episodes: [current] },
        range: `第 ${n}–${n} 集`,
        outputSpec: '只输出 {"episodes": [这一集]}：已有的段 id、切 id 原样保留；新加的段、切不写 id；其余集不要输出。',
      };
      const merge = (whole: Doc, fixed: Doc): Doc | null => {
        const got = (episodesOf(fixed).filter(isDoc) as Doc[]).find((e) => e['id'] === current['id'] || e['ep'] === n);
        if (!got) return null;
        return { ...whole, episodes: listOf(whole, 'episodes').map((e) => (e['ep'] === n ? { id: current['id'], ep: n, segments: listOf(got, 'segments') } : e)) };
      };
      return { ask, merge, missing: `上一次没有交回第 ${n} 集：只输出 {"episodes": [这一集]}` };
    },
  };
}

/**
 * 分镜每集只问这一集：用到剧本里这一集、站位里这一集那几场；剧本与站位的其余部分、大纲、角色、美术各集共用。
 * 角色、美术虽然也只带这几场用到的，但按整份算共用——宁可多重写，不拿变过的卡片沿用旧分镜。
 */
export function storyboardSlices(upstream: Partial<Record<Stage, Doc>>): UpstreamSlices {
  const script = upstream.script ?? null;
  const staging = upstream.staging ?? null;
  const stagingScenes = listOf(staging, 'scenes');
  const owned = new Set<unknown>();
  const episodes = new Map(
    listOf(script, 'episodes').map((e) => {
      const refs = new Set(listOf(e, 'scenes').map((sc) => sc['id']));
      const scenes = stagingScenes.filter((x) => refs.has(x['sceneRef']));
      for (const x of scenes) owned.add(x);
      return [String(e['id']), { script: e, staging: scenes }] as const;
    }),
  );
  const shared = {
    ...upstream,
    ...(script ? { script: omit(script, ['episodes']) } : {}),
    // 落不到任何一集的站位场次（对不上剧本）留在共用部分里
    ...(staging ? { staging: { ...omit(staging, ['scenes']), scenes: stagingScenes.filter((x) => !owned.has(x)) } } : {}),
  };
  return { shared, episodes };
}

const novelStoryboard: Recipe = {
  name: 'novel-storyboard',
  ...deps('storyboard'),
  keysOf: (violation, doc) => storyboardKeysOf(violation, doc),
  sliceUpstream: storyboardSlices,
  needsInput: false,
  perEpisode: true,
  async run(ctx) {
    const script = ctx.upstream.script as Doc;
    const nums = scopedNumbers(ctx, script);
    const opening = parseBlocking(await ctx.runMounted('staging', ['blocking', ctx.inPath('staging')]), ctx.upstream.staging);
    const base = { ctx, task: readAll(ctx, STORYBOARD_REFS), schema: ctx.readFile('references/schema.md'), opening };
    // 上一次中断前已写好的集直接沿用（执行器已把它记成这次的进度），只对剩下的集分批写
    const start = resumeStart(ctx, nums);
    const rest = start.rest;
    let head: Doc = start.head;
    let episodes: Doc[] = start.episodes;
    const writeEpisodes = async (a: number, b: number): Promise<Doc[]> => {
      const [from, to] = [rest[a - 1]!, rest[b - 1]!];
      const seed = await seedOf(ctx, ['seed', ctx.inPath('script'), '--eps', `${from}-${to}`, ...(ctx.params?.aspect ? ['--aspect', ctx.params.aspect] : [])]);
      if (!Object.keys(head).length) head = omit(seed, ['episodes']);
      const sb: StoryboardPass = { ...base, head };
      const seedEps = listOf(seed, 'episodes').filter((e) => rest.includes(e['ep'] as number));
      return a === b && seedEps.length === 1 ? writeStoryboardEpisode(sb, seedEps[0]!) : askStoryboard(sb, `episodes:${from}-${to}`, [from, to], seedEps, false);
    };
    for (const [a, b] of contiguousBatches(rest, STORYBOARD_BATCH)) {
      episodes = mergeEpisodes(episodes, await writeSplitting(a, b, writeEpisodes));
      await reportProgress(ctx, 'storyboard.partial.json', { ...head, episodes }, ['--script', ctx.inPath('script')]);
    }
    const post = (d: Doc) => withIds(ctx, 'storyboard.json', d, ['--script', ctx.inPath('script')]);
    const doc = await post({ ...head, episodes });
    const check = allChecks('validate', [
      validateCheck(ctx, 'validate', 'storyboard.json', refs(ctx, [['--script', 'script'], ['--outline', 'outline'], ['--cast', 'cast'], ['--art', 'art']])),
      stagingCarryCheck(opening),
    ]);
    const repair: AskParts = { task: base.task, schema: base.schema, upstream: pick(ctx, ['cast', 'art']), sections: [openingSection(opening, [...opening.keys()])], outputSpec: '输出修正后的整份 storyboard.json。' };
    return ctx.gate(check, doc, repair, post, storyboardSplit(base));
  },
};

export const STAGE_RECIPES: Readonly<Record<string, Recipe>> = {
  [novelCharacters.name]: novelCharacters,
  [novelArt.name]: novelArt,
  [novelStaging.name]: novelStaging,
  [novelStoryboard.name]: novelStoryboard,
};

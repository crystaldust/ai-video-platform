// 付费生成的计划：把一张已确认的确认单展开成任务，落库为 planned。
// 数量口径与估算（src/estimate/usage.ts）一致：要出图的角色 × 5 视图、每切 1 帧关键帧、每段 1 段视频（秒数 = max(4, Σ切秒)）。
// 模型取确认单里那份估算的选择——那是人确认时看到的，不按「现在的预设」重算。
// 幂等：同一张确认单里同一个「节点 + 标签」只建一次，再计划只补缺的。
// 依赖写进计划输入（deps）：派生视图、关键帧等锚点，视频等关键帧；也可以用以前确认单已经入库的那张。
import type { DatabaseSync } from 'node:sqlite';
import { findModel } from '../model/registry.ts';
import { lookupPrice, type PriceSources, type PriceUnit } from '../pricing/prices.ts';
import { latestArtifactDoc } from '../repo/artifacts.ts';
import { currentVersion } from '../repo/entities.ts';
import type { PaidGateRow } from '../repo/paid-gates.ts';
import { createTask, listTasks, type PaidNode, type TaskRow } from '../repo/tasks.ts';
import { ANCHOR_VIEW, CHARACTER_VIEWS, characterViewPrompt, keyframePrompt, pickRefs, sizeFor, VIEW_ORDER, type Ratio } from './prompts.ts';

/** Qwen-Image 3.0 最多 3 张参考图 */
const MAX_IMAGE_REFS = 3;
const MIN_VIDEO_SECONDS = 4;
const MAX_VIDEO_SECONDS = 15;
const FREE_VIDEO_REFS = 5;

type Doc = Record<string, unknown>;
const isDoc = (x: unknown): x is Doc => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const list = (x: unknown, key: string): Doc[] => (isDoc(x) && Array.isArray(x[key]) ? (x[key] as unknown[]).filter(isDoc) : []);
const text = (x: unknown): string => (typeof x === 'string' ? x : '');

/** 任务在一张确认单里的身份，也是依赖的写法。 */
export const taskKey = (node: PaidNode, label: string): string => `${node}|${label}`;

interface NodeChoice {
  readonly capability: 'image' | 'video';
  readonly provider: string;
  readonly model: string;
  readonly modelId: string;
  readonly params: Readonly<Record<string, string>>;
}

interface Draft {
  readonly node: PaidNode;
  readonly label: string;
  readonly episodeKey: string | null;
  readonly targetVersionId: number;
  readonly plannedInput: Doc & { readonly deps: readonly string[] };
  readonly usd: number | null;
}

function choiceOf(gate: PaidGateRow, node: PaidNode): NodeChoice {
  const est = gate.estimate.nodes.find((n) => n.node === node);
  if (!est) throw new Error(`确认单 ${gate.id} 的估算里没有 ${node}`);
  const info = findModel(est.model);
  if (info.capability !== 'image' && info.capability !== 'video') throw new Error(`${node} 用的 ${est.model} 不是图片或视频模型`);
  return { capability: info.capability, provider: info.provider, model: info.model, modelId: est.model, params: est.params };
}

/** 美元单价 × 数量；查不到单价返回 null（不猜）。 */
function priced(prices: PriceSources, c: NodeChoice, parts: readonly [PriceUnit, number][]): number | null {
  let sum = 0;
  for (const [unit, qty] of parts) {
    if (qty === 0) continue;
    const hit = lookupPrice(prices, c.modelId, unit, c.params);
    if (!hit || hit.entry.currency !== 'USD') return null;
    sum += hit.entry.price * qty;
  }
  return sum;
}

/** 以前（任何确认单）已经入库的任务：可以当依赖用。 */
function collectedKeys(db: DatabaseSync): Set<string> {
  return new Set(listTasks(db, { status: ['collected'] }).flatMap((t) => (t.node && t.label ? [taskKey(t.node, t.label)] : [])));
}

function versionId(db: DatabaseSync, kind: 'character' | 'cut' | 'segment', key: string, facets: readonly ('cast' | 'outline' | 'storyboard')[]): number {
  for (const f of facets) {
    const v = currentVersion(db, kind, key, f);
    if (v) return v.id;
  }
  throw new Error(`项目库里没有 ${kind} ${key} 的当前版本（先导入或重跑上游）`);
}

function characterDrafts(db: DatabaseSync, prices: PriceSources, c: NodeChoice): Draft[] {
  const outline = latestArtifactDoc(db, 'outline')?.doc;
  const cards = new Map(list(latestArtifactDoc(db, 'cast')?.doc, 'characters').map((card) => [text(card['name']), card]));
  const size = (view: (typeof VIEW_ORDER)[number]) => sizeFor(CHARACTER_VIEWS[view].ratio, c.params['size'] === '2k' ? '2k' : '1k');
  return list(outline, 'characters')
    .filter((ch) => ch['tier'] !== 'functional')
    .flatMap((ch) => {
      const id = text(ch['id']);
      const name = text(ch['name']);
      const card = cards.get(name);
      if (!card) throw new Error(`角色卡里没有「${name}」（${id}）：先跑或导入角色阶段`);
      const appearance = text(isDoc(card['image']) ? card['image']['prompt'] : '');
      const target = versionId(db, 'character', id, ['cast', 'outline']);
      return VIEW_ORDER.map((view): Draft => {
        const p = characterViewPrompt(appearance, view);
        const deps = CHARACTER_VIEWS[view].usesAnchor ? [taskKey('image:character-refs', `${id}:${ANCHOR_VIEW}`)] : [];
        return {
          node: 'image:character-refs',
          label: `${id}:${view}`,
          episodeKey: null,
          targetVersionId: target,
          plannedInput: { kind: 'character-view', character: id, view, prompt: p.prompt, negativePrompt: p.negativePrompt, size: size(view), deps },
          usd: priced(prices, c, [['image', 1], ['ref_image', deps.length]]),
        };
      });
    });
}

interface StoryboardEpisode {
  readonly id: string;
  readonly aspect: Ratio;
  readonly segments: Doc[];
}

function storyboardEpisodes(db: DatabaseSync, ids: readonly string[]): StoryboardEpisode[] {
  const board = latestArtifactDoc(db, 'storyboard')?.doc;
  const aspect = text(isDoc(board) ? board['aspectRatio'] : '') || '9:16';
  if (aspect !== '9:16' && aspect !== '16:9') throw new Error(`分镜画幅 ${aspect} 不支持（只支持 9:16、16:9）`);
  const eps = list(board, 'episodes');
  return ids.map((id) => {
    const ep = eps.find((e) => e['id'] === id);
    if (!ep) throw new Error(`确认单勾了 ${id}，但当前分镜里没有这一集（分镜改过？重新生成确认单）`);
    return { id, aspect, segments: list(ep, 'segments') };
  });
}

function keyframeDrafts(db: DatabaseSync, prices: PriceSources, c: NodeChoice, eps: readonly StoryboardEpisode[], anchors: ReadonlySet<string>): Draft[] {
  const names = new Map(list(latestArtifactDoc(db, 'outline')?.doc, 'characters').map((ch) => [text(ch['id']), text(ch['name'])]));
  const anchorOf = new Map([...names.keys()].flatMap((id) => {
    const key = taskKey('image:character-refs', `${id}:${ANCHOR_VIEW}`);
    return anchors.has(key) ? [[id, key] as const] : [];
  }));
  return eps.flatMap((ep) =>
    ep.segments.flatMap((seg) =>
      list(seg, 'cuts').map((cut): Draft => {
        const chars = Array.isArray(cut['characters']) ? (cut['characters'] as unknown[]).map(text) : [];
        const refs = pickRefs(chars, anchorOf, MAX_IMAGE_REFS);
        const props = Array.isArray(cut['props']) ? (cut['props'] as unknown[]).map(text) : [];
        const unavailable = [
          `场景 ${text(seg['sceneRef'])}（本阶段不出场景图）`,
          ...props.map((p) => `道具 ${p}（本阶段不出道具图）`),
          ...refs.missing.map((id) => `角色 ${names.get(id) ?? id}（还没有锚点图）`),
          ...refs.dropped.map((id) => `角色 ${names.get(id) ?? id}（超过 ${MAX_IMAGE_REFS} 张参考图）`),
        ];
        const deps = refs.used.map((id) => anchorOf.get(id)!);
        return {
          node: 'image:keyframe',
          label: text(cut['id']),
          episodeKey: ep.id,
          targetVersionId: versionId(db, 'cut', text(cut['id']), ['storyboard']),
          plannedInput: { kind: 'keyframe', cut: cut['id'], prompt: keyframePrompt(text(cut['frame']), refs.used.map((id) => names.get(id) ?? id)), size: sizeFor(ep.aspect, c.params['size'] === '2k' ? '2k' : '1k'), deps, unavailable },
          usd: priced(prices, c, [['image', 1], ['ref_image', deps.length]]),
        };
      }),
    ),
  );
}

function videoDrafts(db: DatabaseSync, prices: PriceSources, c: NodeChoice, eps: readonly StoryboardEpisode[], keyframes: ReadonlySet<string>): Draft[] {
  return eps.flatMap((ep) =>
    ep.segments.map((seg): Draft => {
      const cuts = list(seg, 'cuts');
      const deps = cuts.map((cut) => taskKey('image:keyframe', text(cut['id'])));
      const lacking = deps.filter((d) => !keyframes.has(d));
      if (lacking.length) throw new Error(`段 ${text(seg['id'])} 要用的关键帧还没有、这张确认单也没勾（${lacking.length} 张）：视频要先有关键帧，勾上这一集的关键帧再确认`);
      const seconds = cuts.reduce((a, cut) => a + (typeof cut['seconds'] === 'number' ? cut['seconds'] : 0), 0);
      const duration = Math.min(MAX_VIDEO_SECONDS, Math.max(MIN_VIDEO_SECONDS, Math.round(seconds)));
      return {
        node: 'video:segment',
        label: text(seg['id']),
        episodeKey: ep.id,
        targetVersionId: versionId(db, 'segment', text(seg['id']), ['storyboard']),
        plannedInput: { kind: 'segment', segment: seg['id'], prompt: text(seg['h3Prompt']), seconds, duration, ratio: ep.aspect, resolution: c.params['resolution'] ?? '480P', deps },
        usd: priced(prices, c, [['video_second', duration], ['ref_image_extra', Math.max(0, deps.length - FREE_VIDEO_REFS)]]),
      };
    }),
  );
}

const episodesSelected = (sel: unknown): string[] => (Array.isArray(sel) ? sel.filter((x): x is string => typeof x === 'string') : []);

/** 确认单 → 任务（只补没建的），返回这张确认单的全部任务。 */
export function planGeneration(db: DatabaseSync, gate: PaidGateRow, prices: PriceSources): TaskRow[] {
  if (gate.status !== 'confirmed') throw new Error(`确认单 ${gate.id} 还没确认（${gate.status}），不能生成`);
  const sel = isDoc(gate.selection) ? gate.selection : {};
  const fx = gate.estimate.fx.usdToCny;
  const done = collectedKeys(db);
  const drafts: { draft: Draft; choice: NodeChoice }[] = [];
  const planned = new Set<string>();
  const add = (choice: NodeChoice, ds: readonly Draft[]) => {
    for (const d of ds) {
      drafts.push({ draft: d, choice });
      planned.add(taskKey(d.node, d.label));
    }
  };
  if (sel['image:character-refs'] === true) {
    const c = choiceOf(gate, 'image:character-refs');
    add(c, characterDrafts(db, prices, c));
  }
  const kfEps = episodesSelected(sel['image:keyframe']);
  if (kfEps.length) {
    const c = choiceOf(gate, 'image:keyframe');
    add(c, keyframeDrafts(db, prices, c, storyboardEpisodes(db, kfEps), new Set([...done, ...planned])));
  }
  const vEps = episodesSelected(sel['video:segment']);
  if (vEps.length) {
    const c = choiceOf(gate, 'video:segment');
    add(c, videoDrafts(db, prices, c, storyboardEpisodes(db, vEps), new Set([...done, ...planned])));
  }
  const existing = new Set(listTasks(db, { paidGateId: gate.id }).flatMap((t) => (t.node && t.label ? [taskKey(t.node, t.label)] : [])));
  for (const { draft: d, choice: c } of drafts) {
    if (existing.has(taskKey(d.node, d.label))) continue;
    createTask(db, {
      targetVersionId: d.targetVersionId,
      capability: c.capability,
      provider: c.provider,
      model: c.model,
      node: d.node,
      episodeKey: d.episodeKey,
      label: d.label,
      plannedInput: d.plannedInput,
      costEstimate: d.usd === null ? null : d.usd * fx,
      currency: 'CNY',
      paidGateId: gate.id,
    });
  }
  return listTasks(db, { paidGateId: gate.id });
}

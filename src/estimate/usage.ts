// 用量估算：每个节点要花多少 token / 多少张图 / 多少秒视频，给区间并写明依据。
// 有真实数据就用真实数据（已通过的运行的实际用量、大纲的人物、分镜的切与段），没有才按集数粗估。
import type { DatabaseSync } from 'node:sqlite';
import type { Stage } from '../domain/types.ts';
import type { Node } from '../model/capabilities.ts';
import { latestArtifactDoc } from '../repo/artifacts.ts';
import { currentInput } from '../repo/inputs.ts';

export interface Range {
  readonly low: number;
  readonly high: number;
}

/** 一个节点的用量：按计价单位拆开（文本是输入 / 输出 token，图片是出图 / 参考图，视频是秒 / 超额参考图）。 */
export interface UsagePart {
  readonly unit: 'token_in' | 'token_out' | 'image' | 'ref_image' | 'video_second' | 'ref_image_extra';
  readonly qty: Range;
}

export interface NodeUsage {
  readonly node: Node;
  readonly parts: readonly UsagePart[];
  readonly assumptions: readonly string[];
  /** 按集拆开的用量（关键帧、视频按分镜每集算；付费确认单按集勾选用）。分镜还没有的集不在里面 */
  readonly episodes?: readonly { readonly episode: string; readonly ep: number; readonly parts: readonly UsagePart[] }[];
}

/**
 * 每集文本 token（输入, 输出），按 Phase 2 真实运行折算：2026-10-29 DeepSeek Flash 跑《渡口》6 集，
 * 大纲约 17.5k 入 / 18.7k 出，剧本约 55k 入 / 68k 出（含两轮修复与推理 token）。其余阶段还没有实测，按剧本比例粗估。
 */
const TEXT_PER_EPISODE: Readonly<Record<Stage, { in: number; out: number; measured: boolean }>> = {
  outline: { in: 3_000, out: 3_100, measured: true },
  script: { in: 9_200, out: 11_300, measured: true },
  cast: { in: 4_600, out: 5_600, measured: false },
  art: { in: 4_600, out: 5_600, measured: false },
  staging: { in: 9_200, out: 11_300, measured: false },
  storyboard: { in: 13_800, out: 17_000, measured: false },
};
/** 没有实际数据时的区间：低 = 一次通过，高 = 再加一轮修复 */
const TEXT_HIGH_FACTOR = 2;
const DEFAULT_EPISODES = 6;
const DEFAULT_SECONDS = 60;
const VIEWS_PER_CHARACTER = 5;
const CUTS_PER_EPISODE: Range = { low: 11, high: 16 };
const REROLL = 1.2;
const VIDEO_REROLL = 1.15;
const MIN_VIDEO_SECONDS = 4;
const FREE_REF_IMAGES = 5;
const KEYFRAME_REFS = 2;

const range = (low: number, high = low): Range => ({ low: Math.round(low), high: Math.round(high) });
const isRecord = (x: unknown): x is Record<string, any> => x !== null && typeof x === 'object' && !Array.isArray(x);

function episodeCount(db: DatabaseSync): { n: number; why: string } {
  const outline = latestArtifactDoc(db, 'outline')?.doc;
  if (isRecord(outline) && Array.isArray(outline['episodes']) && outline['episodes'].length) return { n: outline['episodes'].length, why: `大纲 ${outline['episodes'].length} 集` };
  const input = currentInput(db);
  if (input) return { n: input.params.episodes, why: `项目输入 ${input.params.episodes} 集` };
  return { n: DEFAULT_EPISODES, why: `还没有大纲和输入，按 ${DEFAULT_EPISODES} 集估` };
}

/** 最近一次通过的运行的实际用量（含它的全部尝试）；没有或用量缺失就是 null。 */
function measuredText(db: DatabaseSync, stage: Stage): { in: number; out: number } | null {
  const run = db.prepare(`SELECT id FROM node_run WHERE stage = ? AND status IN ('passed','resolved') ORDER BY id DESC LIMIT 1`).get(stage) as { id: number } | undefined;
  if (!run) return null;
  const rows = db.prepare('SELECT usage FROM node_attempt WHERE run_id = ?').all(run.id) as { usage: string | null }[];
  const usages = rows.map((r) => (r.usage ? (JSON.parse(r.usage) as { inputTokens: number | null; outputTokens: number | null }) : null));
  if (!usages.length || usages.some((u) => !u || u.inputTokens === null || u.outputTokens === null)) return null;
  return { in: usages.reduce((a, u) => a + u!.inputTokens!, 0), out: usages.reduce((a, u) => a + u!.outputTokens!, 0) };
}

function textUsage(db: DatabaseSync, stage: Stage, eps: { n: number; why: string }): NodeUsage {
  const node = `text:${stage}` as Node;
  const actual = measuredText(db, stage);
  if (actual) {
    return { node, parts: [{ unit: 'token_in', qty: range(actual.in) }, { unit: 'token_out', qty: range(actual.out) }], assumptions: ['按最近一次通过的运行的实际用量'] };
  }
  const per = TEXT_PER_EPISODE[stage];
  return {
    node,
    parts: [
      { unit: 'token_in', qty: range(per.in * eps.n, per.in * eps.n * TEXT_HIGH_FACTOR) },
      { unit: 'token_out', qty: range(per.out * eps.n, per.out * eps.n * TEXT_HIGH_FACTOR) },
    ],
    assumptions: [eps.why, per.measured ? '每集用量按 Phase 2 真实运行折算' : '每集用量还没有实测，按剧本比例粗估', '高位含一轮修复'],
  };
}

function characterRefs(db: DatabaseSync): NodeUsage {
  const outline = latestArtifactDoc(db, 'outline')?.doc;
  const chars = isRecord(outline) && Array.isArray(outline['characters']) ? outline['characters'] : null;
  const node: Node = 'image:character-refs';
  if (!chars) return { node, parts: [], assumptions: ['还没有大纲，数不出要出图的人物'] };
  const drawn = chars.filter((c) => isRecord(c) && c['tier'] !== 'functional').length;
  const images = drawn * VIEWS_PER_CHARACTER;
  // 每人先出锚点，其余 4 张视图各挂锚点 1 张参考图
  const refs = drawn * (VIEWS_PER_CHARACTER - 1);
  return {
    node,
    parts: [
      { unit: 'image', qty: range(images, images * REROLL) },
      { unit: 'ref_image', qty: range(refs, refs * REROLL) },
    ],
    assumptions: [`大纲里要出图的人物 ${drawn} 个（功能角色不出图）× ${VIEWS_PER_CHARACTER} 张视图`, '高位含 20% 重出'],
  };
}

interface SegmentStats {
  readonly cuts: number;
  readonly seconds: number;
  readonly extraRefs: number;
}

interface StoryboardStats extends SegmentStats {
  readonly episodes: number;
  readonly perEpisode: readonly (SegmentStats & { readonly episode: string; readonly ep: number })[];
}

const cutsOf = (s: unknown): unknown[] => (isRecord(s) && Array.isArray(s['cuts']) ? s['cuts'] : []);
const secondsOf = (s: unknown): number => cutsOf(s).reduce((a: number, c: unknown) => a + (isRecord(c) && typeof c['seconds'] === 'number' ? c['seconds'] : 0), 0);

function segmentStats(segments: readonly unknown[]): SegmentStats {
  return {
    cuts: segments.reduce((a: number, s) => a + cutsOf(s).length, 0),
    seconds: segments.reduce((a: number, s) => a + Math.max(MIN_VIDEO_SECONDS, secondsOf(s)), 0),
    extraRefs: segments.reduce((a: number, s) => a + Math.max(0, cutsOf(s).length - FREE_REF_IMAGES), 0),
  };
}

function storyboardStats(db: DatabaseSync): StoryboardStats | null {
  const sb = latestArtifactDoc(db, 'storyboard')?.doc;
  if (!isRecord(sb) || !Array.isArray(sb['episodes'])) return null;
  const episodes = sb['episodes'].filter(isRecord);
  const segmentsOf = (e: Record<string, any>): unknown[] => (Array.isArray(e['segments']) ? e['segments'] : []);
  const perEpisode = episodes
    .filter((e) => typeof e['id'] === 'string' && Number.isInteger(e['ep']))
    .map((e) => ({ episode: e['id'] as string, ep: e['ep'] as number, ...segmentStats(segmentsOf(e)) }));
  return { ...segmentStats(episodes.flatMap(segmentsOf)), episodes: sb['episodes'].length, perEpisode };
}

const keyframeParts = (cuts: Range): UsagePart[] => [
  { unit: 'image', qty: cuts },
  { unit: 'ref_image', qty: range(cuts.low * KEYFRAME_REFS, cuts.high * KEYFRAME_REFS) },
];
const videoParts = (s: SegmentStats): UsagePart[] => [
  { unit: 'video_second', qty: range(s.seconds, s.seconds * VIDEO_REROLL) },
  { unit: 'ref_image_extra', qty: range(s.extraRefs, s.extraRefs * VIDEO_REROLL) },
];

function keyframes(sb: StoryboardStats | null, eps: { n: number; why: string }): NodeUsage {
  const node: Node = 'image:keyframe';
  const cuts = sb ? range(sb.cuts, sb.cuts * REROLL) : range(eps.n * CUTS_PER_EPISODE.low, eps.n * CUTS_PER_EPISODE.high * REROLL);
  const why = sb ? `分镜 ${sb.episodes} 集共 ${sb.cuts} 切，每切一张` : `${eps.why}，还没有分镜，按每集 ${CUTS_PER_EPISODE.low}–${CUTS_PER_EPISODE.high} 切估`;
  return {
    node,
    parts: keyframeParts(cuts),
    assumptions: [why, `每张关键帧挂 ${KEYFRAME_REFS} 张参考图（角色、场景）`, '高位含 20% 重出'],
    ...(sb ? { episodes: sb.perEpisode.map((e) => ({ episode: e.episode, ep: e.ep, parts: keyframeParts(range(e.cuts, e.cuts * REROLL)) })) } : {}),
  };
}

function video(db: DatabaseSync, sb: StoryboardStats | null, eps: { n: number; why: string }): NodeUsage {
  const node: Node = 'video:segment';
  if (sb) {
    return {
      node,
      parts: videoParts(sb),
      episodes: sb.perEpisode.map((e) => ({ episode: e.episode, ep: e.ep, parts: videoParts(e) })),
      assumptions: [`分镜各段秒数之和 ${sb.seconds} 秒（每段至少 ${MIN_VIDEO_SECONDS} 秒）`, `每段参考图超出 ${FREE_REF_IMAGES} 张的部分另计`, '高位含 15% 重生成'],
    };
  }
  const seconds = (currentInput(db)?.params.seconds ?? DEFAULT_SECONDS) * eps.n;
  return {
    node,
    parts: [{ unit: 'video_second', qty: range(seconds, seconds * VIDEO_REROLL) }],
    assumptions: [`${eps.why} × 单集目标时长，还没有分镜`, '高位含 15% 重生成'],
  };
}

const TEXT_STAGES: readonly Stage[] = ['outline', 'cast', 'art', 'script', 'staging', 'storyboard'];

export function estimateUsage(db: DatabaseSync): NodeUsage[] {
  const eps = episodeCount(db);
  const sb = storyboardStats(db);
  return [...TEXT_STAGES.map((s) => textUsage(db, s, eps)), characterRefs(db), keyframes(sb, eps), video(db, sb, eps)];
}

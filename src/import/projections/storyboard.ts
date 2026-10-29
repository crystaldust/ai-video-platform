// storyboard.json → 视频段（一次生成调用）+ 段内分镜切。段、切都按上游稳定 id（sg_/ct_）定键，
// 段按 sceneRef 指向剧本场次；切的顺序由段侧面的 cutKeys 表达，切自己的 payload 不带位置。
// 「E01-02」「#3」这类编号是按位置推算的显示，平台不存。
import { isValidKey } from '../../domain/keys.ts';
import type { EntityDraft, FacetRef, Projection, ProjectionContext, RefDraft } from '../../domain/types.ts';
import {
  arrayField,
  coverEpisodes,
  entity,
  finish,
  isRecord,
  notObject,
  optionalArray,
  ref,
  refsTo,
  type Problems,
} from '../projection.ts';
import { episodeTitle } from './outline.ts';

const FACET = 'storyboard';
const IDS_HINT = '（3.0 起必填，先运行 novel-storyboard 的 ids --write）';

type Part = { entities: EntityDraft[]; refs: RefDraft[] };
const EMPTY: Part = { entities: [], refs: [] };

function cutPart(ep: string, segId: string, cut: unknown, index: number, problems: Problems): Part {
  if (!isRecord(cut) || !isValidKey('cut', cut['id'])) {
    problems.push(`段 ${segId} 第 ${index} 切缺少合法的切 id${IDS_HINT}`);
    return EMPTY;
  }
  const key = cut['id'];
  const where = `分镜切 ${key}`;
  const from: FacetRef = { kind: 'cut', key, facet: FACET };
  const refs = [
    ref(from, 'segment', { kind: 'segment', key: segId }, [FACET], where),
    ...refsTo(from, 'cast', 'character', arrayField(cut, 'characters', problems, where), ['cast', 'outline'], where, problems),
    ...refsTo(from, 'prop', 'prop', optionalArray(cut, 'props', problems, where), ['art', 'outline'], where, problems),
  ];
  return { entities: [entity('cut', key, '', FACET, cut, ep)], refs };
}

function segmentPart(ep: string, label: string, seg: unknown, index: number, ctx: ProjectionContext, problems: Problems): Part {
  if (!isRecord(seg) || !isValidKey('segment', seg['id'])) {
    problems.push(`${label}第 ${index} 段缺少合法的段 id${IDS_HINT}`);
    return EMPTY;
  }
  const segId = seg['id'];
  const where = `段 ${segId}`;
  const sceneRef = seg['sceneRef'];
  if (!isValidKey('script_scene', sceneRef)) {
    problems.push(`${where}的 sceneRef 不是合法的剧本场次 id：${String(sceneRef)}`);
    return EMPTY;
  }
  // 场次在别的集里：要么段放错了集，要么 sceneRef 抄错了，都不能静默接受
  const sceneEp = ctx.sceneEpisode.get(sceneRef);
  if (sceneEp && sceneEp !== ep) problems.push(`${where}的场次 ${sceneRef} 属于集 ${sceneEp}，不是${label}`);
  const { cuts: _cuts, ...rest } = seg;
  const parts = arrayField(seg, 'cuts', problems, `${where} `).map((c, k) => cutPart(ep, segId, c, k + 1, problems));
  const cutKeys = parts.flatMap((p) => p.entities.map((e) => e.key));
  const from: FacetRef = { kind: 'segment', key: segId, facet: FACET };
  return {
    entities: [entity('segment', segId, '', FACET, { ...rest, cutKeys }, ep), ...parts.flatMap((p) => p.entities)],
    refs: [
      ref(from, 'scene', { kind: 'script_scene', key: sceneRef }, ['script'], where),
      ref(from, 'staging', { kind: 'script_scene', key: sceneRef }, ['staging'], where, true),
      ...parts.flatMap((p) => p.refs),
    ],
  };
}

export function projectStoryboard(doc: unknown, ctx: ProjectionContext): Projection {
  if (!isRecord(doc)) return notObject('storyboard.json');
  const problems: Problems = [];
  const episodes = arrayField(doc, 'episodes', problems, 'storyboard ').flatMap((item, i) => {
    if (isRecord(item) && isValidKey('episode', item['id'])) {
      return [{ ep: item['id'], label: `${episodeTitle(item['ep']) || `分镜第 ${i + 1} 集`}（${item['id']}）`, item }];
    }
    problems.push(`分镜第 ${i + 1} 集缺少合法的集 id${IDS_HINT}`);
    return [];
  });
  const parts = episodes.flatMap(({ ep, label, item }) =>
    arrayField(item, 'segments', problems, label).map((seg, j) => segmentPart(ep, label, seg, j + 1, ctx, problems)),
  );
  const covers = coverEpisodes(FACET, ['segment', 'cut'], episodes.map((e) => e.ep));
  return finish(parts.flatMap((p) => p.entities), parts.flatMap((p) => p.refs), problems, covers);
}

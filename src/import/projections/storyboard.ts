// storyboard.json → 视频段（一次生成调用）+ 段内分镜。分镜没有 id，按段号 + 段内序号定键。
import { cutKey, episodeKey, isValidKey, scriptSceneKey } from '../../domain/keys.ts';
import type { EntityDraft, FacetRef, Projection, ProjectionContext, RefDraft } from '../../domain/types.ts';
import {
  arrayField,
  coverEpisodes,
  entity,
  finish,
  isPositiveInt,
  isRecord,
  notObject,
  optionalArray,
  ref,
  refsTo,
  type Problems,
} from '../projection.ts';

const FACET = 'storyboard';

type Part = { entities: EntityDraft[]; refs: RefDraft[] };
const EMPTY: Part = { entities: [], refs: [] };

function cutPart(segId: string, cut: unknown, index: number, problems: Problems): Part {
  const key = cutKey(segId, index);
  const where = `分镜 ${key}`;
  if (!isRecord(cut)) {
    problems.push(`${where}不是对象`);
    return EMPTY;
  }
  const from: FacetRef = { kind: 'cut', key, facet: FACET };
  const refs = [
    ref(from, 'segment', { kind: 'segment', key: segId }, [FACET], where),
    ...refsTo(from, 'cast', 'character', arrayField(cut, 'characters', problems, where), ['cast', 'outline'], where, problems),
    ...refsTo(from, 'prop', 'prop', optionalArray(cut, 'props', problems, where), ['art', 'outline'], where, problems),
  ];
  return { entities: [entity('cut', key, '', FACET, { ...cut, index })], refs };
}

function segmentPart(ep: number, seg: unknown, i: number, problems: Problems): Part {
  const label = `第 ${ep} 集第 ${i + 1} 段`;
  if (!isRecord(seg) || !isValidKey('segment', seg['id'])) {
    problems.push(`${label}缺少合法的段号 id（形如 E01-01）`);
    return EMPTY;
  }
  const segId = seg['id'];
  if (!segId.startsWith(`${episodeKey(ep)}-`)) problems.push(`段 ${segId} 不属于第 ${ep} 集`);
  if (!isPositiveInt(seg['sceneIndex'])) {
    problems.push(`段 ${segId} 的 sceneIndex 必须是正整数`);
    return EMPTY;
  }
  const sceneKey = scriptSceneKey(ep, seg['sceneIndex']);
  const { cuts: _cuts, ...rest } = seg;
  const cuts = arrayField(seg, 'cuts', problems, `段 ${segId} `);
  const parts = cuts.map((c, k) => cutPart(segId, c, k + 1, problems));
  const from: FacetRef = { kind: 'segment', key: segId, facet: FACET };
  const where = `段 ${segId}`;
  return {
    entities: [
      entity('segment', segId, '', FACET, { ...rest, ep, cutKeys: cuts.map((_, k) => cutKey(segId, k + 1)) }),
      ...parts.flatMap((p) => p.entities),
    ],
    refs: [
      ref(from, 'scene', { kind: 'script_scene', key: sceneKey }, ['script'], where),
      ref(from, 'staging', { kind: 'script_scene', key: sceneKey }, ['staging'], where, true),
      ...parts.flatMap((p) => p.refs),
    ],
  };
}

export function projectStoryboard(doc: unknown, _ctx: ProjectionContext): Projection {
  if (!isRecord(doc)) return notObject('storyboard.json');
  const problems: Problems = [];
  const episodes = arrayField(doc, 'episodes', problems, 'storyboard ').flatMap((item, i) => {
    if (isRecord(item) && isPositiveInt(item['ep'])) return [{ ep: item['ep'], item }];
    problems.push(`分镜第 ${i + 1} 集缺少正整数 ep`);
    return [];
  });
  const parts = episodes.flatMap(({ ep, item }) =>
    arrayField(item, 'segments', problems, `第 ${ep} 集`).map((seg, j) => segmentPart(ep, seg, j, problems)),
  );
  const covers = coverEpisodes(FACET, ['segment', 'cut'], episodes.map((e) => e.ep));
  return finish(parts.flatMap((p) => p.entities), parts.flatMap((p) => p.refs), problems, covers);
}

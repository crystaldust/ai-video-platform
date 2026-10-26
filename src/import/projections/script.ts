// script.json → 集的剧本侧面 + 剧本场次。场次没有编号，按"第几集第几场"定键。
import { episodeKey, scriptSceneKey } from '../../domain/keys.ts';
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
  refsTo,
  type Problems,
} from '../projection.ts';

const FACET = 'script';

type Part = { entities: EntityDraft[]; refs: RefDraft[]; ep?: number };

function sceneParts(ep: number, sc: unknown, index: number, problems: Problems): Part {
  const key = scriptSceneKey(ep, index);
  const where = `第 ${ep} 集第 ${index} 场（${key}）`;
  if (!isRecord(sc)) {
    problems.push(`${where}不是对象`);
    return { entities: [], refs: [] };
  }
  const from: FacetRef = { kind: 'script_scene', key, facet: FACET };
  const refs = [
    ...refsTo(from, 'episode', 'episode', [episodeKey(ep)], [FACET], where, problems),
    ...refsTo(from, 'location', 'location', [sc['sceneId']], ['art', 'outline'], where, problems),
    ...refsTo(from, 'cast', 'character', arrayField(sc, 'characters', problems, where), ['outline'], where, problems),
    ...refsTo(from, 'prop', 'prop', optionalArray(sc, 'props', problems, where), ['art', 'outline'], where, problems),
  ];
  return { entities: [entity('script_scene', key, '', FACET, { ...sc, ep, index })], refs };
}

function episodeParts(item: unknown, i: number, problems: Problems): Part {
  if (!isRecord(item) || !isPositiveInt(item['ep'])) {
    problems.push(`剧本第 ${i + 1} 集缺少正整数 ep`);
    return { entities: [], refs: [] };
  }
  const ep = item['ep'];
  const { scenes: _scenes, ...rest } = item;
  const scenes = arrayField(item, 'scenes', problems, `第 ${ep} 集`);
  const parts = scenes.map((sc, j) => sceneParts(ep, sc, j + 1, problems));
  const sceneKeys = scenes.map((_, j) => scriptSceneKey(ep, j + 1));
  return {
    entities: [entity('episode', episodeKey(ep), `第${ep}集`, FACET, { ...rest, sceneKeys }), ...parts.flatMap((p) => p.entities)],
    refs: parts.flatMap((p) => p.refs),
    ep,
  };
}

export function projectScript(doc: unknown, _ctx: ProjectionContext): Projection {
  if (!isRecord(doc)) return notObject('script.json');
  const problems: Problems = [];
  const parts = arrayField(doc, 'episodes', problems, 'script ').map((item, i) => episodeParts(item, i, problems));
  // 剧本常按集分批写：只对这份文件里出现的集负责
  const covers = coverEpisodes(FACET, ['episode', 'script_scene'], parts.flatMap((p) => (p.ep ? [p.ep] : [])));
  return finish(parts.flatMap((p) => p.entities), parts.flatMap((p) => p.refs), problems, covers);
}

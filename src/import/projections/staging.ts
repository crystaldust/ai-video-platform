// staging.json → 地点的认图侧面（能站能坐的东西）+ 剧本场次的开场站位侧面。
import { isValidKey, scriptSceneKey } from '../../domain/keys.ts';
import type { EntityDraft, FacetRef, Projection, ProjectionContext, RefDraft } from '../../domain/types.ts';
import {
  arrayField,
  coverEpisodes,
  entity,
  finish,
  isPositiveInt,
  isRecord,
  notObject,
  ref,
  refsTo,
  str,
  type Problems,
} from '../projection.ts';

const FACET = 'staging';

type Part = { entities: EntityDraft[]; refs: RefDraft[] };

function locationPart(item: unknown, i: number, problems: Problems): Part {
  if (!isRecord(item) || !isValidKey('location', item['sceneId'])) {
    problems.push(`站位地点第 ${i + 1} 条缺少合法的 sceneId`);
    return { entities: [], refs: [] };
  }
  const key = item['sceneId'];
  const from: FacetRef = { kind: 'location', key, facet: FACET };
  // 认图读的是美术场景图；还没有美术侧面时（按提示词推算的）就不挂这条
  const readFrom = ref(from, 'read-from', { kind: 'location', key }, ['art'], `站位地点 ${key}`, true);
  return { entities: [entity('location', key, str(item['name']), FACET, item)], refs: [readFrom] };
}

function scenePart(item: unknown, i: number, problems: Problems): Part {
  if (!isRecord(item) || !isPositiveInt(item['ep']) || !isPositiveInt(item['scene'])) {
    problems.push(`站位场次第 ${i + 1} 条缺少正整数 ep / scene`);
    return { entities: [], refs: [] };
  }
  const key = scriptSceneKey(item['ep'], item['scene']);
  const where = `第 ${item['ep']} 集第 ${item['scene']} 场站位（${key}）`;
  const from: FacetRef = { kind: 'script_scene', key, facet: FACET };
  const refs = [
    ref(from, 'staged', { kind: 'script_scene', key }, ['script'], where),
    ...refsTo(from, 'location', 'location', [item['sceneId']], [FACET], where, problems),
  ];
  return { entities: [entity('script_scene', key, '', FACET, item)], refs };
}

export function projectStaging(doc: unknown, _ctx: ProjectionContext): Projection {
  if (!isRecord(doc)) return notObject('staging.json');
  const problems: Problems = [];
  const scenes = arrayField(doc, 'scenes', problems, 'staging ');
  const parts = [
    ...arrayField(doc, 'locations', problems, 'staging ').map((x, i) => locationPart(x, i, problems)),
    ...scenes.map((x, i) => scenePart(x, i, problems)),
  ];
  // 站位可能只排了其中几集：场次按集负责；地点的认图结果跨集共用，缺席不代表删除，不退役
  const eps = scenes.flatMap((s) => (isRecord(s) && isPositiveInt(s['ep']) ? [s['ep']] : []));
  return finish(parts.flatMap((p) => p.entities), parts.flatMap((p) => p.refs), problems, coverEpisodes(FACET, ['script_scene'], eps));
}

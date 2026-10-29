// script.json → 集的剧本侧面 + 剧本场次。集和场次都按上游稳定 id（ep_/sc_）定键；
// 场次顺序由集侧面的 sceneKeys 表达，场次自己的 payload 不带位置——插一场不会让别的场次长出新版本。
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
  refsTo,
  type Problems,
} from '../projection.ts';
import { episodeTitle } from './outline.ts';

const FACET = 'script';
const IDS_HINT = '（3.0 起必填，先运行 novel-script 的 ids --write）';

type Part = { entities: EntityDraft[]; refs: RefDraft[]; ep?: string };
const EMPTY: Part = { entities: [], refs: [] };

function sceneParts(ep: string, label: string, sc: unknown, index: number, problems: Problems): Part {
  if (!isRecord(sc) || !isValidKey('script_scene', sc['id'])) {
    problems.push(`${label}第 ${index} 场缺少合法的场次 id${IDS_HINT}`);
    return EMPTY;
  }
  const key = sc['id'];
  const where = `${label}第 ${index} 场（${key}）`;
  const from: FacetRef = { kind: 'script_scene', key, facet: FACET };
  const refs = [
    ...refsTo(from, 'episode', 'episode', [ep], [FACET], where, problems),
    ...refsTo(from, 'location', 'location', [sc['sceneId']], ['art', 'outline'], where, problems),
    ...refsTo(from, 'cast', 'character', arrayField(sc, 'characters', problems, where), ['outline'], where, problems),
    ...refsTo(from, 'prop', 'prop', optionalArray(sc, 'props', problems, where), ['art', 'outline'], where, problems),
  ];
  return { entities: [entity('script_scene', key, '', FACET, sc, ep)], refs };
}

function episodeParts(item: unknown, i: number, problems: Problems): Part {
  if (!isRecord(item) || !isValidKey('episode', item['id'])) {
    problems.push(`剧本第 ${i + 1} 集缺少合法的集 id${IDS_HINT}`);
    return EMPTY;
  }
  const ep = item['id'];
  const label = `${episodeTitle(item['ep']) || `剧本第 ${i + 1} 集`}（${ep}）`;
  const { scenes: _scenes, ...rest } = item;
  const scenes = arrayField(item, 'scenes', problems, label);
  const parts = scenes.map((sc, j) => sceneParts(ep, label, sc, j + 1, problems));
  const sceneKeys = parts.flatMap((p) => p.entities.map((e) => e.key));
  return {
    entities: [entity('episode', ep, episodeTitle(item['ep']), FACET, { ...rest, sceneKeys }, ep), ...parts.flatMap((p) => p.entities)],
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

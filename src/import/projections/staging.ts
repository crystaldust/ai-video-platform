// staging.json → 地点的认图侧面（能站能坐的东西）+ 剧本场次的开场站位侧面。
// 站位场次按 sceneRef（剧本场次的稳定 id）对上剧本；ep / scene 只是显示编号，不参与对账。
// 站位文件不写集 id，所属集从库里剧本侧面查——所以要先导入剧本。
import { isValidKey } from '../../domain/keys.ts';
import type { EntityDraft, FacetRef, Projection, ProjectionContext, RefDraft } from '../../domain/types.ts';
import {
  arrayField,
  coverEpisodes,
  entity,
  finish,
  isRecord,
  notObject,
  ref,
  refsTo,
  str,
  type Problems,
} from '../projection.ts';

const FACET = 'staging';

type Part = { entities: EntityDraft[]; refs: RefDraft[]; ep?: string };
const EMPTY: Part = { entities: [], refs: [] };

function locationPart(item: unknown, i: number, problems: Problems): Part {
  if (!isRecord(item) || !isValidKey('location', item['sceneId'])) {
    problems.push(`站位地点第 ${i + 1} 条缺少合法的 sceneId`);
    return EMPTY;
  }
  const key = item['sceneId'];
  const from: FacetRef = { kind: 'location', key, facet: FACET };
  // 认图读的是美术场景图；还没有美术侧面时（按提示词推算的）就不挂这条
  const readFrom = ref(from, 'read-from', { kind: 'location', key }, ['art'], `站位地点 ${key}`, true);
  return { entities: [entity('location', key, str(item['name']), FACET, item)], refs: [readFrom] };
}

function scenePart(item: unknown, i: number, ctx: ProjectionContext, problems: Problems): Part {
  if (!isRecord(item) || !isValidKey('script_scene', item['sceneRef'])) {
    problems.push(`站位场次第 ${i + 1} 条缺少合法的 sceneRef（3.0 起必填，先运行 novel-staging 的 ids --write）`);
    return EMPTY;
  }
  const key = item['sceneRef'];
  const where = `站位场次第 ${i + 1} 条（${key}）`;
  const ep = ctx.sceneEpisode.get(key);
  if (!ep) {
    problems.push(`${where}在项目的剧本里找不到这个场次（先导入包含它的 script）`);
    return EMPTY;
  }
  const from: FacetRef = { kind: 'script_scene', key, facet: FACET };
  const refs = [
    ref(from, 'staged', { kind: 'script_scene', key }, ['script'], where),
    ...refsTo(from, 'location', 'location', [item['sceneId']], [FACET], where, problems),
  ];
  return { entities: [entity('script_scene', key, '', FACET, item, ep)], refs, ep };
}

export function projectStaging(doc: unknown, ctx: ProjectionContext): Projection {
  if (!isRecord(doc)) return notObject('staging.json');
  const problems: Problems = [];
  const sceneParts = arrayField(doc, 'scenes', problems, 'staging ').map((x, i) => scenePart(x, i, ctx, problems));
  const parts = [...arrayField(doc, 'locations', problems, 'staging ').map((x, i) => locationPart(x, i, problems)), ...sceneParts];
  // 站位可能只排了其中几集：场次按集负责；地点的认图结果跨集共用，缺席不代表删除，不退役
  const eps = sceneParts.flatMap((p) => (p.ep ? [p.ep] : []));
  return finish(parts.flatMap((p) => p.entities), parts.flatMap((p) => p.refs), problems, coverEpisodes(FACET, ['script_scene'], eps));
}

// outline.json → 集 / 人物 / 场景 / 道具 / 爽点 的大纲侧面。
// 大纲是人物清单、场景清单的权威来源；分集靠 C/S/P 编号引用它们。
// 集按稳定 id（ep_…）认，集号 ep 只用来拼显示名。
import { isValidKey } from '../../domain/keys.ts';
import type { EntityDraft, FacetRef, Projection, ProjectionContext, RefDraft } from '../../domain/types.ts';
import {
  arrayField,
  coverAll,
  entity,
  finish,
  idItems,
  isPositiveInt,
  isRecord,
  notObject,
  optionalArray,
  ref,
  refsTo,
  str,
  type Problems,
} from '../projection.ts';

const FACET = 'outline';
const IDS_HINT = '（3.0 起必填，先运行 novel-outline 的 ids --write）';

/** 显示名：「第3集」。集号只是显示，缺了也不影响身份。 */
export const episodeTitle = (ep: unknown): string => (isPositiveInt(ep) ? `第${ep}集` : '');

function catalog(doc: Record<string, unknown>, problems: Problems): EntityDraft[] {
  const characters = idItems(arrayField(doc, 'characters', problems, 'outline '), 'character', 'id', '人物表', problems);
  const scenes = idItems(arrayField(doc, 'scenes', problems, 'outline '), 'location', 'id', '场景表', problems);
  const props = idItems(optionalArray(doc, 'props', problems, 'outline '), 'prop', 'id', '道具表', problems);
  return [
    ...characters.map(({ key, item }) => entity('character', key, str(item['name']), FACET, item)),
    ...scenes.map(({ key, item }) => entity('location', key, str(item['name']), FACET, item)),
    ...props.map(({ key, item }) => entity('prop', key, str(item['name']), FACET, item)),
  ];
}

function beats(doc: Record<string, unknown>, problems: Problems): { entities: EntityDraft[]; refs: RefDraft[] } {
  const items = idItems(arrayField(doc, 'beats', problems, 'outline '), 'beat', 'id', '爽点表', problems);
  const entities = items.map(({ key, item }) => entity('beat', key, str(item['type']), FACET, item));
  const refs = items.flatMap(({ key, item }) => {
    const episodeRef = item['episodeRef'];
    if (!isValidKey('episode', episodeRef)) {
      problems.push(`爽点 ${key} 的 episodeRef 不是合法的集 id：${String(episodeRef)}${IDS_HINT}`);
      return [];
    }
    const from: FacetRef = { kind: 'beat', key, facet: FACET };
    return [ref(from, 'episode', { kind: 'episode', key: episodeRef }, [FACET], `爽点 ${key}`)];
  });
  return { entities, refs };
}

function episodes(doc: Record<string, unknown>, problems: Problems): { entities: EntityDraft[]; refs: RefDraft[] } {
  const list = arrayField(doc, 'episodes', problems, 'outline ');
  const parts = list.flatMap((item, i) => {
    if (!isRecord(item) || !isValidKey('episode', item['id'])) {
      problems.push(`分集第 ${i + 1} 条缺少合法的集 id${IDS_HINT}`);
      return [];
    }
    const key = item['id'];
    const where = `${episodeTitle(item['ep']) || `分集第 ${i + 1} 条`}（${key}）`;
    const from: FacetRef = { kind: 'episode', key, facet: FACET };
    const refs = [
      ...refsTo(from, 'cast', 'character', optionalArray(item, 'characterIds', problems, where), [FACET], where, problems),
      ...refsTo(from, 'location', 'location', optionalArray(item, 'sceneIds', problems, where), [FACET], where, problems),
      ...refsTo(from, 'prop', 'prop', optionalArray(item, 'propIds', problems, where), [FACET], where, problems),
    ];
    return [{ entity: entity('episode', key, episodeTitle(item['ep']), FACET, item), refs }];
  });
  return { entities: parts.map((p) => p.entity), refs: parts.flatMap((p) => p.refs) };
}

export function projectOutline(doc: unknown, _ctx: ProjectionContext): Projection {
  if (!isRecord(doc)) return notObject('outline.json');
  const problems: Problems = [];
  const b = beats(doc, problems);
  const e = episodes(doc, problems);
  const covers = coverAll(FACET, ['character', 'location', 'prop', 'beat', 'episode']);
  return finish([...catalog(doc, problems), ...b.entities, ...e.entities], [...b.refs, ...e.refs], problems, covers);
}

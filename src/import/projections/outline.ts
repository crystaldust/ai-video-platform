// outline.json → 集 / 人物 / 场景 / 道具 / 爽点 的大纲侧面。
// 大纲是人物清单、场景清单的权威来源；分集靠 C/S/P 编号引用它们。
import { episodeKey } from '../../domain/keys.ts';
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
    const ep = item['episode'];
    if (!isPositiveInt(ep)) {
      problems.push(`爽点 ${key} 的 episode 必须是正整数`);
      return [];
    }
    const from: FacetRef = { kind: 'beat', key, facet: FACET };
    return [ref(from, 'episode', { kind: 'episode', key: episodeKey(ep) }, [FACET], `爽点 ${key}`)];
  });
  return { entities, refs };
}

function episodes(doc: Record<string, unknown>, problems: Problems): { entities: EntityDraft[]; refs: RefDraft[] } {
  const list = arrayField(doc, 'episodes', problems, 'outline ');
  const parts = list.flatMap((item, i) => {
    if (!isRecord(item) || !isPositiveInt(item['ep'])) {
      problems.push(`分集第 ${i + 1} 条缺少正整数 ep`);
      return [];
    }
    const key = episodeKey(item['ep']);
    const where = `第 ${item['ep']} 集`;
    const from: FacetRef = { kind: 'episode', key, facet: FACET };
    const refs = [
      ...refsTo(from, 'cast', 'character', optionalArray(item, 'characterIds', problems, where), [FACET], where, problems),
      ...refsTo(from, 'location', 'location', optionalArray(item, 'sceneIds', problems, where), [FACET], where, problems),
      ...refsTo(from, 'prop', 'prop', optionalArray(item, 'propIds', problems, where), [FACET], where, problems),
    ];
    return [{ entity: entity('episode', key, `第${item['ep']}集`, FACET, item), refs }];
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

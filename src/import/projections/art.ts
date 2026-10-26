// art.json → 场景与道具的美术侧面（锚点、光照、提示词）。
import { isValidKey } from '../../domain/keys.ts';
import type { EntityDraft, FacetRef, Projection, ProjectionContext, RefDraft } from '../../domain/types.ts';
import {
  arrayField,
  coverAll,
  entity,
  finish,
  idItems,
  isRecord,
  notObject,
  optionalArray,
  ref,
  refsTo,
  str,
  type Problems,
} from '../projection.ts';

const FACET = 'art';

function scenes(doc: Record<string, unknown>, problems: Problems): { entities: EntityDraft[]; refs: RefDraft[] } {
  const items = idItems(arrayField(doc, 'scenes', problems, 'art '), 'location', 'id', '美术场景表', problems);
  const refs = items.flatMap(({ key, item }) => {
    const parent = item['variantOf'];
    if (parent === undefined) return [];
    if (!isValidKey('location', parent)) {
      problems.push(`场景 ${key} 的 variantOf 格式不对：${String(parent)}`);
      return [];
    }
    const from: FacetRef = { kind: 'location', key, facet: FACET };
    return [ref(from, 'variant-of', { kind: 'location', key: parent }, [FACET], `场景 ${key}`)];
  });
  return { entities: items.map(({ key, item }) => entity('location', key, str(item['name']), FACET, item)), refs };
}

function props(doc: Record<string, unknown>, problems: Problems): { entities: EntityDraft[]; refs: RefDraft[] } {
  const items = idItems(optionalArray(doc, 'props', problems, 'art '), 'prop', 'id', '美术道具表', problems);
  const refs = items.flatMap(({ key, item }) => {
    const where = `道具 ${key}`;
    const from: FacetRef = { kind: 'prop', key, facet: FACET };
    const related = optionalArray(item, 'relatedScenes', problems, where);
    return refsTo(from, 'location', 'location', related, [FACET, 'outline'], where, problems);
  });
  return { entities: items.map(({ key, item }) => entity('prop', key, str(item['name']), FACET, item)), refs };
}

export function projectArt(doc: unknown, _ctx: ProjectionContext): Projection {
  if (!isRecord(doc)) return notObject('art.json');
  const problems: Problems = [];
  const s = scenes(doc, problems);
  const p = props(doc, problems);
  return finish([...s.entities, ...p.entities], [...s.refs, ...p.refs], problems, coverAll(FACET, ['location', 'prop']));
}

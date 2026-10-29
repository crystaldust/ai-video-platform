// 投影共用工具：把 skill 产物 JSON 搬成对象侧面与引用。
// 投影是纯函数，不碰数据库、不改入参；拿不准的地方一律记 problem，不抛错。
import { isValidKey } from '../domain/keys.ts';
import type { Coverage, EntityDraft, EntityKind, Facet, FacetRef, Projection, RefDraft } from '../domain/types.ts';

export type Problems = string[];

export const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);

export const isPositiveInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

export const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');

/** 必填数组字段：缺了记 problem 并当空数组继续，让一次校验报全所有问题。 */
export function arrayField(obj: Record<string, unknown>, name: string, problems: Problems, label: string): unknown[] {
  const value = obj[name];
  if (Array.isArray(value)) return value;
  problems.push(`${label}缺少数组字段 ${name}`);
  return [];
}

/** 可选数组字段：没写就是空数组；写了但不是数组算问题。 */
export function optionalArray(obj: Record<string, unknown>, name: string, problems: Problems, label: string): unknown[] {
  const value = obj[name];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  problems.push(`${label}的 ${name} 应该是数组`);
  return [];
}

/** 一个对象侧面；按集负责的侧面要给 episode（集的稳定 id）。 */
export const entity = (kind: EntityKind, key: string, title: string, facet: Facet, payload: unknown, episode?: string): EntityDraft =>
  episode === undefined ? { kind, key, title, facet, payload } : { kind, key, title, facet, payload, episode };

export const ref = (
  from: FacetRef,
  role: string,
  to: { kind: EntityKind; key: string },
  toFacets: readonly Facet[],
  where: string,
  optional = false,
): RefDraft => ({ from, role, to, toFacets, optional, where });

/** 一组编号 → 引用；编号格式不对的记 problem。 */
export function refsTo(
  from: FacetRef,
  role: string,
  kind: EntityKind,
  keys: readonly unknown[],
  toFacets: readonly Facet[],
  where: string,
  problems: Problems,
): RefDraft[] {
  return keys.flatMap((key) => {
    if (isValidKey(kind, key)) return [ref(from, role, { kind, key }, toFacets, where)];
    problems.push(`${where}引用了格式不对的${kind}编号：${String(key)}`);
    return [];
  });
}

/** 带 id 的条目（人物、场景、道具、爽点）：校验 id 格式，返回通过的条目。 */
export function idItems(
  list: readonly unknown[],
  kind: EntityKind,
  idField: string,
  label: string,
  problems: Problems,
): { key: string; item: Record<string, unknown> }[] {
  return list.flatMap((item, i) => {
    if (!isRecord(item)) {
      problems.push(`${label}第 ${i + 1} 条不是对象`);
      return [];
    }
    const key = item[idField];
    if (!isValidKey(kind, key)) {
      problems.push(`${label}第 ${i + 1} 条的 ${idField} 格式不对：${String(key)}`);
      return [];
    }
    return [{ key, item }];
  });
}

/** 整份负责：文档里没有的就是删了。 */
export const coverAll = (facet: Facet, kinds: readonly EntityKind[]): Coverage[] =>
  kinds.map((kind) => ({ kind, facet, episodes: 'all' }));

/** 按集负责：只对文档里出现的集（按集 id）负责，分批写的其他集不受影响。 */
export const coverEpisodes = (facet: Facet, kinds: readonly EntityKind[], episodes: readonly string[]): Coverage[] =>
  kinds.map((kind) => ({ kind, facet, episodes: [...new Set(episodes)] }));

/** 收尾：同一份文档里同一对象的同一侧面只能出现一次。 */
export function finish(
  entities: readonly EntityDraft[],
  refs: readonly RefDraft[],
  problems: Problems,
  covers: readonly Coverage[],
): Projection {
  const seen = new Set<string>();
  const dupes = entities.flatMap((e) => {
    const id = `${e.kind}/${e.key}/${e.facet}`;
    if (seen.has(id)) return [`${e.kind} ${e.key} 在同一份文档里出现了不止一次`];
    seen.add(id);
    return [];
  });
  return { entities, refs, covers, problems: [...problems, ...dupes] };
}

export const notObject = (label: string): Projection => ({ entities: [], refs: [], covers: [], problems: [`${label} 不是对象`] });

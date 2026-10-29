// 追溯与过期。都是现算：引用钉住"当时用的版本"，和被引用方现在的版本一比就知道。
import type { DatabaseSync } from 'node:sqlite';
import type { EntityKind, Facet } from '../domain/types.ts';

export const MAX_LINEAGE_DEPTH = 20;

export interface LineageNode {
  readonly kind: EntityKind;
  readonly key: string;
  readonly title: string;
  readonly facet: Facet;
  readonly v: number;
  readonly versionId: number;
  /** 最近一跳是以什么身份被引用的（cast / location / segment …）。 */
  readonly role: string;
  readonly depth: number;
  /** false = 被引用的是旧版本：这正是"按旧版角色做的"证据，不能滤掉。 */
  readonly isCurrent: boolean;
}

// 只走生效的引用（live_ref：每处最新钉住的版本）。同一个版本只留深度最小的那跳；
// 同深度有多个身份时取字典序最小的，保证结果确定
const LINEAGE_SQL = `
WITH RECURSIVE
start(id) AS (
  SELECT cv.id FROM current_version cv JOIN entity e ON e.id = cv.entity_id
  WHERE e.kind = ? AND e.key = ? AND (? IS NULL OR cv.facet = ?) AND cv.retired = 0
),
walk(version_id, role, depth) AS (
  SELECT r.to_version_id, r.role, 1 FROM live_ref r WHERE r.from_version_id IN (SELECT id FROM start)
  UNION
  SELECT r.to_version_id, r.role, w.depth + 1 FROM walk w JOIN live_ref r ON r.from_version_id = w.version_id
  WHERE w.depth < ?
),
shallowest AS (SELECT version_id, MIN(depth) AS depth FROM walk GROUP BY version_id),
nearest AS (
  SELECT s.version_id, s.depth,
    (SELECT MIN(w.role) FROM walk w WHERE w.version_id = s.version_id AND w.depth = s.depth) AS role
  FROM shallowest s
)
SELECT e.kind, e.key, e.title, ev.facet, ev.v, ev.id AS version_id, n.role, n.depth,
  ev.v = (SELECT MAX(x.v) FROM entity_version x WHERE x.entity_id = ev.entity_id AND x.facet = ev.facet) AS is_current
FROM nearest n JOIN entity_version ev ON ev.id = n.version_id JOIN entity e ON e.id = ev.entity_id
ORDER BY n.depth, e.kind, e.key, ev.facet`;

interface RawNode {
  kind: EntityKind;
  key: string;
  title: string;
  facet: Facet;
  v: number;
  version_id: number;
  role: string;
  depth: number;
  is_current: number;
}

export function getLineage(
  db: DatabaseSync,
  kind: EntityKind,
  key: string,
  opts: { facet?: Facet; maxDepth?: number } = {},
): LineageNode[] {
  const facet = opts.facet ?? null;
  const rows = db.prepare(LINEAGE_SQL).all(kind, key, facet, facet, opts.maxDepth ?? MAX_LINEAGE_DEPTH) as unknown as RawNode[];
  return rows.map((r) => ({
    kind: r.kind,
    key: r.key,
    title: r.title,
    facet: r.facet,
    v: r.v,
    versionId: r.version_id,
    role: r.role,
    depth: r.depth,
    isCurrent: r.is_current === 1,
  }));
}

export interface StaleRef {
  /** episode：引用方当前版本记的所属集（跨集共用的对象为 null） */
  readonly from: { kind: EntityKind; key: string; facet: Facet; v: number; episode: string | null };
  readonly role: string;
  readonly to: { kind: EntityKind; key: string; facet: Facet };
  readonly pinnedV: number;
  readonly currentV: number;
}

// 只看引用方当前有效的版本（旧版本过期理所当然，不该报）、只看生效的引用。
// 被引用方退役时，它的当前版本就是退役版本——引用方照样报出来：它依赖的东西没了
const STALE_SQL = `
SELECT fe.kind AS from_kind, fe.key AS from_key, fv.facet AS from_facet, fv.v AS from_v, fv.episode_key AS from_episode, r.role,
  te.kind AS to_kind, te.key AS to_key, tv.facet AS to_facet, tv.v AS pinned_v, cur.v AS current_v
FROM live_ref r
JOIN current_version fv ON fv.id = r.from_version_id AND fv.retired = 0
JOIN entity fe ON fe.id = fv.entity_id
JOIN entity_version tv ON tv.id = r.to_version_id
JOIN entity te ON te.id = tv.entity_id
JOIN current_version cur ON cur.entity_id = tv.entity_id AND cur.facet = tv.facet
WHERE cur.id <> tv.id
ORDER BY fe.kind, fe.key, fv.facet, r.role, te.key`;

interface RawStale {
  from_kind: EntityKind;
  from_key: string;
  from_facet: Facet;
  from_v: number;
  from_episode: string | null;
  role: string;
  to_kind: EntityKind;
  to_key: string;
  to_facet: Facet;
  pinned_v: number;
  current_v: number;
}

export function findStaleRefs(db: DatabaseSync): StaleRef[] {
  const rows = db.prepare(STALE_SQL).all() as unknown as RawStale[];
  return rows.map((r) => ({
    from: { kind: r.from_kind, key: r.from_key, facet: r.from_facet, v: r.from_v, episode: r.from_episode },
    role: r.role,
    to: { kind: r.to_kind, key: r.to_key, facet: r.to_facet },
    pinnedV: r.pinned_v,
    currentV: r.current_v,
  }));
}

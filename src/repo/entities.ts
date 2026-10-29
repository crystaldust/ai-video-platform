// 对象、对象版本、引用的读写。版本行只插入不更新；只有 entity.title（仅用于显示）允许更新。
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../domain/clock.ts';
import { canonicalJson, contentHash } from '../domain/hash.ts';
import type { EntityKind, Facet } from '../domain/types.ts';

export interface VersionRow {
  readonly id: number;
  readonly entityId: number;
  readonly kind: EntityKind;
  readonly key: string;
  readonly title: string;
  readonly facet: Facet;
  readonly v: number;
  readonly payload: unknown;
  readonly contentHash: string;
  readonly artifactVersionId: number | null;
  readonly retired: boolean;
  readonly createdAt: string;
  /** 所属集的稳定 id；跨集共用的侧面为 null。 */
  readonly episodeKey: string | null;
}

/** 退役版本的内容指纹：不是任何 JSON 的哈希，所以恢复出来的内容一定会长出新版本。 */
const RETIRED_HASH = 'retired';

interface RawVersion {
  id: number;
  entity_id: number;
  kind: EntityKind;
  key: string;
  title: string;
  facet: Facet;
  v: number;
  payload: string;
  content_hash: string;
  artifact_version_id: number | null;
  retired: number;
  created_at: string;
  episode_key: string | null;
}

const VERSION_SELECT = `SELECT ev.id, ev.entity_id, e.kind, e.key, e.title, ev.facet, ev.v, ev.payload,
  ev.content_hash, ev.artifact_version_id, ev.retired, ev.created_at, ev.episode_key
  FROM entity_version ev JOIN entity e ON e.id = ev.entity_id`;

const toVersionRow = (r: RawVersion): VersionRow => ({
  id: r.id,
  entityId: r.entity_id,
  kind: r.kind,
  key: r.key,
  title: r.title,
  facet: r.facet,
  v: r.v,
  payload: JSON.parse(r.payload),
  contentHash: r.content_hash,
  artifactVersionId: r.artifact_version_id,
  retired: r.retired === 1,
  createdAt: r.created_at,
  episodeKey: r.episode_key,
});

/**
 * 不存在就建，返回 entity.id。title 只用于显示、不参与版本：
 * 权威来源（大纲）可以改它；其他来源只在它还空着时补上，避免显示名随导入顺序来回翻。
 */
export function ensureEntity(db: DatabaseSync, kind: EntityKind, key: string, title: string, authoritative = false): number {
  const row = db.prepare('SELECT id, title FROM entity WHERE kind = ? AND key = ?').get(kind, key) as
    | { id: number; title: string }
    | undefined;
  if (!row) {
    const result = db
      .prepare('INSERT INTO entity (kind, key, title, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, key, title, nowIso());
    return Number(result.lastInsertRowid);
  }
  if (title && row.title !== title && (authoritative || !row.title)) {
    db.prepare('UPDATE entity SET title = ? WHERE id = ?').run(title, row.id);
  }
  return row.id;
}

export interface VersionInput {
  readonly entityId: number;
  readonly facet: Facet;
  readonly payload: unknown;
  readonly artifactVersionId: number | null;
  /** 所属集的稳定 id；跨集共用的侧面不给。 */
  readonly episode?: string | undefined;
}

/** 追加一个侧面版本；内容和所属集都与当前版本相同则复用（created: false）。 */
export function appendEntityVersion(db: DatabaseSync, input: VersionInput): { id: number; v: number; created: boolean } {
  const hash = contentHash(input.payload);
  const episodeKey = input.episode ?? null;
  const latest = db
    .prepare('SELECT id, v, content_hash, episode_key FROM entity_version WHERE entity_id = ? AND facet = ? ORDER BY v DESC LIMIT 1')
    .get(input.entityId, input.facet) as { id: number; v: number; content_hash: string; episode_key: string | null } | undefined;
  if (latest && latest.content_hash === hash && latest.episode_key === episodeKey) return { id: latest.id, v: latest.v, created: false };
  const row = { ...input, v: (latest?.v ?? 0) + 1, payloadJson: canonicalJson(input.payload), hash, retired: false, episodeKey };
  return { ...insertVersion(db, row), created: true };
}

interface NewVersionRow {
  readonly entityId: number;
  readonly facet: Facet;
  readonly v: number;
  readonly payloadJson: string;
  readonly hash: string;
  readonly artifactVersionId: number | null;
  readonly retired: boolean;
  readonly episodeKey: string | null;
}

function insertVersion(db: DatabaseSync, row: NewVersionRow): { id: number; v: number } {
  const result = db
    .prepare(
      `INSERT INTO entity_version (entity_id, facet, v, payload, content_hash, artifact_version_id, retired, created_at, episode_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.entityId, row.facet, row.v, row.payloadJson, row.hash, row.artifactVersionId, row.retired ? 1 : 0, nowIso(), row.episodeKey);
  return { id: Number(result.lastInsertRowid), v: row.v };
}

/** 退役：追加一个空内容的版本。旧版本和指向它们的引用都保留，过期查询会把引用方报出来。 */
export function retireEntityVersion(
  db: DatabaseSync,
  entityId: number,
  facet: Facet,
  artifactVersionId: number | null,
): { id: number; v: number } {
  const latest = db
    .prepare('SELECT v, episode_key FROM entity_version WHERE entity_id = ? AND facet = ? ORDER BY v DESC LIMIT 1')
    .get(entityId, facet) as { v: number; episode_key: string | null } | undefined;
  const v = (latest?.v ?? 0) + 1;
  // 退役版本沿用原来的集：历史上它是哪一集的，退役后也查得到
  const episodeKey = latest?.episode_key ?? null;
  return insertVersion(db, { entityId, facet, v, payloadJson: 'null', hash: RETIRED_HASH, artifactVersionId, retired: true, episodeKey });
}

/** 当前有效版本；已退役的视为没有。 */
export function currentVersion(db: DatabaseSync, kind: EntityKind, key: string, facet: Facet): VersionRow | null {
  const row = db
    .prepare(`${VERSION_SELECT} WHERE e.kind = ? AND e.key = ? AND ev.facet = ? ORDER BY ev.v DESC LIMIT 1`)
    .get(kind, key, facet) as RawVersion | undefined;
  return row && row.retired === 0 ? toVersionRow(row) : null;
}

export interface LiveEntity {
  readonly entityId: number;
  readonly key: string;
  readonly episodeKey: string | null;
}

/** 某个侧面下当前有效的全部对象，连同当前版本记的所属集。 */
export function liveEntities(db: DatabaseSync, kind: EntityKind, facet: Facet): LiveEntity[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.key, cv.episode_key FROM current_version cv JOIN entity e ON e.id = cv.entity_id
       WHERE e.kind = ? AND cv.facet = ? AND cv.retired = 0 ORDER BY e.key`,
    )
    .all(kind, facet) as unknown as { id: number; key: string; episode_key: string | null }[];
  return rows.map((r) => ({ entityId: r.id, key: r.key, episodeKey: r.episode_key }));
}

/** 剧本场次 id → 所属集 id，取剧本侧面的当前有效版本；站位投影靠它知道场次属于哪一集。 */
export function sceneEpisodeIndex(db: DatabaseSync): Map<string, string> {
  return new Map(
    liveEntities(db, 'script_scene', 'script').flatMap((e) => (e.episodeKey ? [[e.key, e.episodeKey] as const] : [])),
  );
}

export function listVersions(db: DatabaseSync, kind: EntityKind, key: string, facet?: Facet): VersionRow[] {
  const rows = (
    facet
      ? db.prepare(`${VERSION_SELECT} WHERE e.kind = ? AND e.key = ? AND ev.facet = ? ORDER BY ev.facet, ev.v`).all(kind, key, facet)
      : db.prepare(`${VERSION_SELECT} WHERE e.kind = ? AND e.key = ? ORDER BY ev.facet, ev.v`).all(kind, key)
  ) as unknown as RawVersion[];
  return rows.map(toVersionRow);
}

/** 写一条钉版本的引用；已经钉过同一版本则忽略。返回是否真的写入。 */
export function insertRef(db: DatabaseSync, fromVersionId: number, role: string, toVersionId: number): boolean {
  const result = db
    .prepare('INSERT OR IGNORE INTO ref (from_version_id, role, to_version_id) VALUES (?, ?, ?)')
    .run(fromVersionId, role, toVersionId);
  return Number(result.changes) > 0;
}

export function countRefsFrom(db: DatabaseSync, fromVersionId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM ref WHERE from_version_id = ?').get(fromVersionId) as { n: number };
  return row.n;
}

/** 大纲人物名 → C 编号，供 cast 投影按名字对上人物；重名的单独列出，匹配时拒绝。 */
export function characterKeyIndex(db: DatabaseSync): { byName: Map<string, string>; ambiguous: Set<string> } {
  const rows = db
    .prepare(
      `SELECT e.key, cv.payload FROM current_version cv JOIN entity e ON e.id = cv.entity_id
       WHERE e.kind = 'character' AND cv.facet = 'outline' AND cv.retired = 0 ORDER BY e.key`,
    )
    .all() as unknown as { key: string; payload: string }[];
  const named = rows.flatMap((r) => {
    const name = (JSON.parse(r.payload) as { name?: unknown }).name;
    return typeof name === 'string' && name.trim() ? [{ name: name.trim(), key: r.key }] : [];
  });
  const counts = named.reduce((m, x) => m.set(x.name, (m.get(x.name) ?? 0) + 1), new Map<string, number>());
  const ambiguous = new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
  return { byName: new Map(named.filter((x) => !ambiguous.has(x.name)).map((x) => [x.name, x.key])), ambiguous };
}

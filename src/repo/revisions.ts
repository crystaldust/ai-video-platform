// 打回意见与复核确认。都只追加：意见记在哪次运行上由 node_run.revision_request_id 关联；
// 复核确认同一 (阶段, 集) 取最新一条。
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../domain/clock.ts';
import type { Stage } from '../domain/types.ts';

export interface RevisionRequestRow {
  readonly id: number;
  readonly stage: Stage;
  readonly episodeKey: string | null;
  readonly note: string;
  readonly baseArtifactVersionId: number | null;
  readonly createdAt: string;
}

export function addRevisionRequest(db: DatabaseSync, input: { stage: Stage; episodeKey: string | null; note: string; baseArtifactVersionId: number | null }): RevisionRequestRow {
  const result = db
    .prepare('INSERT INTO revision_request (stage, episode_key, note, base_artifact_version_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.stage, input.episodeKey, input.note, input.baseArtifactVersionId, nowIso());
  const row = db.prepare('SELECT * FROM revision_request WHERE id = ?').get(Number(result.lastInsertRowid)) as {
    id: number;
    stage: Stage;
    episode_key: string | null;
    note: string;
    base_artifact_version_id: number | null;
    created_at: string;
  };
  return { id: row.id, stage: row.stage, episodeKey: row.episode_key, note: row.note, baseArtifactVersionId: row.base_artifact_version_id, createdAt: row.created_at };
}

/** 这条打回意见放弃了没有；没有这条是 null。 */
export function revisionDismissed(db: DatabaseSync, id: number): boolean | null {
  const row = db.prepare('SELECT dismissed_at FROM revision_request WHERE id = ?').get(id) as { dismissed_at: string | null } | undefined;
  return row ? row.dismissed_at !== null : null;
}

/** 放弃一条打回意见（不要了）：记下放弃时间，意见本身留在记录里。不存在、已放弃都报错。 */
export function dismissRevision(db: DatabaseSync, id: number): void {
  const row = db.prepare('SELECT dismissed_at FROM revision_request WHERE id = ?').get(id) as { dismissed_at: string | null } | undefined;
  if (!row) throw new Error(`没有这条打回意见：${id}`);
  if (row.dismissed_at) throw new Error(`这条打回意见已经放弃了：${id}`);
  // 只在还没放弃时写：另一个进程（命令行）抢先放弃了，这里不覆盖它的时间
  const done = db.prepare('UPDATE revision_request SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL').run(nowIso(), id);
  if (Number(done.changes) === 0) throw new Error(`这条打回意见已经放弃了：${id}`);
}

export interface UnfulfilledRevision {
  readonly id: number;
  readonly stage: Stage;
  readonly episodeKey: string | null;
  readonly note: string;
  readonly latestRunId: number;
  readonly latestRunStatus: 'needs_human' | 'failed';
  readonly createdAt: string;
}

/**
 * 没落实的打回：这条意见引出的最近一次运行转人工或失败、没有任何一次运行过了门、没被放弃，
 * 且同一阶段同一集（整个阶段对整个阶段）没有更新的打回取代它。
 */
export function unfulfilledRevisions(db: DatabaseSync): UnfulfilledRevision[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.stage, r.episode_key, r.note, r.created_at, l.id AS run_id, l.status AS run_status
       FROM revision_request r
       JOIN node_run l ON l.id = (SELECT MAX(id) FROM node_run WHERE revision_request_id = r.id)
       WHERE l.status IN ('needs_human', 'failed')
         AND r.dismissed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM node_run p WHERE p.revision_request_id = r.id AND p.status = 'passed')
         AND NOT EXISTS (SELECT 1 FROM revision_request n WHERE n.id > r.id AND n.stage = r.stage AND n.episode_key IS r.episode_key)
       ORDER BY r.id`,
    )
    .all() as { id: number; stage: Stage; episode_key: string | null; note: string; created_at: string; run_id: number; run_status: 'needs_human' | 'failed' }[];
  return rows.map((r) => ({ id: r.id, stage: r.stage, episodeKey: r.episode_key, note: r.note, latestRunId: r.run_id, latestRunStatus: r.run_status, createdAt: r.created_at }));
}

/** 确认时各上游的版本：键是 `<kind>/<key>/<facet>`。 */
export type AckSnapshot = Readonly<Record<string, number>>;

export interface ReviewAckRow {
  readonly id: number;
  readonly stage: Stage;
  readonly episodeKey: string | null;
  readonly snapshot: AckSnapshot;
  readonly note: string;
  readonly createdAt: string;
}

export function addReviewAck(db: DatabaseSync, input: { stage: Stage; episodeKey: string | null; snapshot: AckSnapshot; note: string }): ReviewAckRow {
  const createdAt = nowIso();
  const result = db
    .prepare('INSERT INTO review_ack (stage, episode_key, snapshot, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.stage, input.episodeKey, JSON.stringify(input.snapshot), input.note, createdAt);
  return { id: Number(result.lastInsertRowid), ...input, createdAt };
}

/** 每个 (阶段, 集) 最新的复核确认；键是 `<stage>|<集 id 或空>`。 */
export function latestReviewAcks(db: DatabaseSync): Map<string, ReviewAckRow> {
  const rows = db.prepare('SELECT * FROM review_ack ORDER BY id').all() as {
    id: number;
    stage: Stage;
    episode_key: string | null;
    snapshot: string;
    note: string;
    created_at: string;
  }[];
  const out = new Map<string, ReviewAckRow>();
  for (const r of rows) {
    out.set(cellKey(r.stage, r.episode_key), { id: r.id, stage: r.stage, episodeKey: r.episode_key, snapshot: JSON.parse(r.snapshot), note: r.note, createdAt: r.created_at });
  }
  return out;
}

export const cellKey = (stage: Stage, episodeKey: string | null): string => `${stage}|${episodeKey ?? ''}`;

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

// skill 产物原文的版本库：按阶段只追加；内容哈希与该阶段最新一版相同则不新建。
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../domain/clock.ts';
import { contentHash } from '../domain/hash.ts';
import type { Stage } from '../domain/types.ts';

export interface ArtifactInput {
  readonly stage: Stage;
  readonly doc: unknown;
  readonly skill?: string | undefined;
  readonly sourcePath?: string | undefined;
}

export interface ArtifactVersionRef {
  readonly id: number;
  readonly v: number;
  readonly unchanged: boolean;
}

function latestRow(db: DatabaseSync, stage: Stage): { id: number; v: number; content_hash: string; doc: string } | undefined {
  return db.prepare('SELECT id, v, content_hash, doc FROM artifact_version WHERE stage = ? ORDER BY v DESC LIMIT 1').get(stage) as
    | { id: number; v: number; content_hash: string; doc: string }
    | undefined;
}

export function latestArtifact(db: DatabaseSync, stage: Stage): { id: number; v: number; contentHash: string } | null {
  const row = latestRow(db, stage);
  return row ? { id: row.id, v: row.v, contentHash: row.content_hash } : null;
}

/** 某阶段最新一版产物的原文；没有就是 null。 */
export function latestArtifactDoc(db: DatabaseSync, stage: Stage): { id: number; v: number; doc: unknown } | null {
  const row = latestRow(db, stage);
  return row ? { id: row.id, v: row.v, doc: JSON.parse(row.doc) } : null;
}

export function appendArtifactVersion(db: DatabaseSync, input: ArtifactInput): ArtifactVersionRef {
  const hash = contentHash(input.doc);
  const latest = latestArtifact(db, input.stage);
  if (latest && latest.contentHash === hash) return { id: latest.id, v: latest.v, unchanged: true };
  const v = (latest?.v ?? 0) + 1;
  const result = db
    .prepare(
      'INSERT INTO artifact_version (stage, v, doc, content_hash, skill, source_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    // 原文照原样存（保留键顺序，可还原成 skill 的输出）；去重用规范化后的哈希
    .run(input.stage, v, JSON.stringify(input.doc) ?? 'null', hash, input.skill ?? null, input.sourcePath ?? null, nowIso());
  return { id: Number(result.lastInsertRowid), v, unchanged: false };
}

export function countArtifacts(db: DatabaseSync, stage: Stage): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM artifact_version WHERE stage = ?').get(stage) as { n: number };
  return row.n;
}

// 候选：一次生成产出的一个文件，挂在任务目标的实体上（角色、切、段）。只追加；label 在同一实体内唯一。
// 审阅、选用在 Phase 6；这里只负责「生成出来、入库、能被找到」。
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../domain/clock.ts';

export interface CandidateRow {
  readonly id: number;
  readonly targetEntityId: number;
  readonly taskId: number | null;
  readonly mediaFileId: number;
  readonly label: string;
  readonly createdAt: string;
}

interface RawCandidate {
  id: number;
  target_entity_id: number;
  task_id: number | null;
  media_file_id: number;
  label: string;
  created_at: string;
}

const toCandidate = (r: RawCandidate): CandidateRow => ({ id: r.id, targetEntityId: r.target_entity_id, taskId: r.task_id, mediaFileId: r.media_file_id, label: r.label, createdAt: r.created_at });

/** 前缀之后接 v1、v2…：关键帧、视频前缀为空（v1），角色视图用视图名（「front-full v1」）。重新生成时递增，旧的留着。 */
export function nextLabel(db: DatabaseSync, entityId: number, prefix: string): string {
  const labels = (db.prepare('SELECT label FROM candidate WHERE target_entity_id = ?').all(entityId) as { label: string }[]).map((r) => r.label);
  const used = labels.flatMap((l) => (l.startsWith(`${prefix}v`) && /^\d+$/.test(l.slice(prefix.length + 1)) ? [Number(l.slice(prefix.length + 1))] : []));
  return `${prefix}v${Math.max(0, ...used) + 1}`;
}

/** 目标实体取任务的目标版本所属的实体。 */
export function addCandidate(db: DatabaseSync, input: { taskId: number; mediaFileId: number; label: string }): CandidateRow {
  const target = db.prepare('SELECT ev.entity_id FROM generation_task t JOIN entity_version ev ON ev.id = t.target_version_id WHERE t.id = ?').get(input.taskId) as { entity_id: number } | undefined;
  if (!target) throw new Error(`没有这个任务：${input.taskId}`);
  const result = db.prepare('INSERT INTO candidate (target_entity_id, task_id, media_file_id, label, created_at) VALUES (?, ?, ?, ?, ?)').run(target.entity_id, input.taskId, input.mediaFileId, input.label, nowIso());
  return toCandidate(db.prepare('SELECT * FROM candidate WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as RawCandidate);
}

export function candidatesOf(db: DatabaseSync, entityId: number): CandidateRow[] {
  return (db.prepare('SELECT * FROM candidate WHERE target_entity_id = ? ORDER BY id').all(entityId) as unknown as RawCandidate[]).map(toCandidate);
}

/** 任务产出的候选（一个任务一个文件；下载重试不会重复建）。 */
export function candidateOfTask(db: DatabaseSync, taskId: number): CandidateRow | null {
  const row = db.prepare('SELECT * FROM candidate WHERE task_id = ? ORDER BY id LIMIT 1').get(taskId) as RawCandidate | undefined;
  return row ? toCandidate(row) : null;
}

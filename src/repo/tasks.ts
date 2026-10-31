// 付费生成任务与它的事件记录。每条写入单独落盘（执行器是异步的，等供应商，不包大事务）。
// 要害：planned → submitting 是一条带条件的 UPDATE，发请求之前它必须已经提交——
// 进程在请求途中死掉，库里留下的是「提交中」，恢复时去供应商那边对账，而不是再提交一次。
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../domain/clock.ts';
import { contentHash } from '../domain/hash.ts';
import { assertTransition, type TaskStatus } from '../generate/state-machine.ts';

export const PAID_NODES = ['image:character-refs', 'image:keyframe', 'video:segment'] as const;
export type PaidNode = (typeof PAID_NODES)[number];
export const isPaidNode = (x: unknown): x is PaidNode => (PAID_NODES as readonly unknown[]).includes(x);

export interface TaskInput {
  readonly targetVersionId: number;
  readonly capability: 'image' | 'video';
  readonly provider: string;
  readonly model: string;
  readonly node: PaidNode;
  readonly episodeKey: string | null;
  readonly label: string;
  /** 规范化的计划输入：参考图用素材库 sha256 表示，不放图片本身 */
  readonly plannedInput: unknown;
  readonly costEstimate: number | null;
  readonly currency: string | null;
  readonly paidGateId: number | null;
  readonly attemptOf?: number | null;
}

export interface TaskRow {
  readonly id: number;
  readonly targetVersionId: number;
  readonly capability: string;
  readonly provider: string;
  readonly model: string;
  readonly status: TaskStatus;
  readonly providerTaskId: string | null;
  readonly plannedInput: unknown;
  readonly actualInput: unknown;
  readonly costEstimate: number | null;
  readonly costActual: number | null;
  readonly currency: string | null;
  readonly error: string | null;
  readonly node: PaidNode | null;
  readonly episodeKey: string | null;
  readonly label: string | null;
  readonly contentFingerprint: string | null;
  readonly paidGateId: number | null;
  readonly attemptOf: number | null;
  readonly pid: number | null;
  readonly submittedAt: string | null;
  readonly providerStatus: string | null;
  readonly resultUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawTask {
  id: number;
  target_version_id: number;
  capability: string;
  provider: string;
  model: string;
  status: TaskStatus;
  provider_task_id: string | null;
  planned_input: string;
  actual_input: string | null;
  cost_estimate: number | null;
  cost_actual: number | null;
  currency: string | null;
  error: string | null;
  node: PaidNode | null;
  episode_key: string | null;
  label: string | null;
  content_fingerprint: string | null;
  paid_gate_id: number | null;
  attempt_of: number | null;
  pid: number | null;
  submitted_at: string | null;
  provider_status: string | null;
  result_url: string | null;
  created_at: string;
  updated_at: string;
}

const toTask = (r: RawTask): TaskRow => ({
  id: r.id,
  targetVersionId: r.target_version_id,
  capability: r.capability,
  provider: r.provider,
  model: r.model,
  status: r.status,
  providerTaskId: r.provider_task_id,
  plannedInput: JSON.parse(r.planned_input),
  actualInput: r.actual_input === null ? null : JSON.parse(r.actual_input),
  costEstimate: r.cost_estimate,
  costActual: r.cost_actual,
  currency: r.currency,
  error: r.error,
  node: r.node,
  episodeKey: r.episode_key,
  label: r.label,
  contentFingerprint: r.content_fingerprint,
  paidGateId: r.paid_gate_id,
  attemptOf: r.attempt_of,
  pid: r.pid,
  submittedAt: r.submitted_at,
  providerStatus: r.provider_status,
  resultUrl: r.result_url,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** 事件详情里只放供应商响应的关键字段：不放凭据、不放图片的 base64。 */
function addEvent(db: DatabaseSync, taskId: number, status: TaskStatus, detail: unknown): void {
  db.prepare('INSERT INTO task_event (task_id, status, detail, at) VALUES (?, ?, ?, ?)').run(taskId, status, detail === undefined ? null : JSON.stringify(detail), nowIso());
}

export function getTask(db: DatabaseSync, id: number): TaskRow | null {
  const row = db.prepare('SELECT * FROM generation_task WHERE id = ?').get(id) as RawTask | undefined;
  return row ? toTask(row) : null;
}

function mustGet(db: DatabaseSync, id: number): TaskRow {
  const task = getTask(db, id);
  if (!task) throw new Error(`没有这个任务：${id}`);
  return task;
}

export function createTask(db: DatabaseSync, input: TaskInput): TaskRow {
  const at = nowIso();
  const result = db
    .prepare(
      `INSERT INTO generation_task (target_version_id, capability, provider, model, status, planned_input, cost_estimate, currency,
         node, episode_key, label, content_fingerprint, paid_gate_id, attempt_of, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.targetVersionId,
      input.capability,
      input.provider,
      input.model,
      JSON.stringify(input.plannedInput),
      input.costEstimate,
      input.currency,
      input.node,
      input.episodeKey,
      input.label,
      contentHash(input.plannedInput),
      input.paidGateId,
      input.attemptOf ?? null,
      at,
      at,
    );
  const id = Number(result.lastInsertRowid);
  addEvent(db, id, 'planned', undefined);
  return mustGet(db, id);
}

/**
 * planned → submitting：带条件的 UPDATE，只有一个进程能抢到。调用方必须在这条写入成功之后才发请求。
 */
export function markSubmitting(db: DatabaseSync, id: number, pid: number): TaskRow {
  const at = nowIso();
  const done = db.prepare(`UPDATE generation_task SET status = 'submitting', pid = ?, submitted_at = ?, updated_at = ? WHERE id = ? AND status = 'planned'`).run(pid, at, at, id);
  if (Number(done.changes) === 0) throw new Error(`任务 ${id} 不是 planned，不能提交（${mustGet(db, id).status}）`);
  addEvent(db, id, 'submitting', { pid });
  return mustGet(db, id);
}

/** 拿到供应商任务 id 立刻落库（提交中或未知 → 已提交）；actualInput 是真正发出的请求（去掉凭据、图片用哈希表示）。 */
export function recordProviderId(db: DatabaseSync, id: number, providerTaskId: string, actualInput?: unknown): TaskRow {
  const task = mustGet(db, id);
  assertTransition(task.status, 'submitted');
  const other = db.prepare('SELECT id FROM generation_task WHERE provider = ? AND provider_task_id = ? AND id <> ?').get(task.provider, providerTaskId, id) as { id: number } | undefined;
  if (other) throw new Error(`供应商任务 ${providerTaskId} 已经记在任务 ${other.id} 上`);
  db.prepare(`UPDATE generation_task SET status = 'submitted', provider_task_id = ?, actual_input = COALESCE(?, actual_input), updated_at = ? WHERE id = ?`).run(
    providerTaskId,
    actualInput === undefined ? null : JSON.stringify(actualInput),
    nowIso(),
    id,
  );
  addEvent(db, id, 'submitted', { providerTaskId });
  return mustGet(db, id);
}

export interface TaskPatch {
  readonly providerStatus?: string | null;
  readonly resultUrl?: string | null;
  readonly error?: string | null;
  readonly costActual?: number | null;
  readonly actualInput?: unknown;
  readonly pid?: number | null;
}

const PATCH_COLUMNS: Readonly<Record<keyof TaskPatch, string>> = {
  providerStatus: 'provider_status',
  resultUrl: 'result_url',
  error: 'error',
  costActual: 'cost_actual',
  actualInput: 'actual_input',
  pid: 'pid',
};

/** 合法转移：写状态与补充字段，留一条事件；非法的抛错、不改库。to 与当前相同时只补字段（轮询时状态没变）。 */
export function transition(db: DatabaseSync, id: number, to: TaskStatus, patch: TaskPatch = {}, detail?: unknown): TaskRow {
  const task = mustGet(db, id);
  if (task.status !== to) assertTransition(task.status, to);
  const keys = (Object.keys(patch) as (keyof TaskPatch)[]).filter((k) => patch[k] !== undefined);
  const values = keys.map((k) => (k === 'actualInput' ? JSON.stringify(patch[k]) : (patch[k] as string | number | null)));
  const sets = [...keys.map((k) => `${PATCH_COLUMNS[k]} = ?`), 'status = ?', 'updated_at = ?'].join(', ');
  db.prepare(`UPDATE generation_task SET ${sets} WHERE id = ?`).run(...values, to, nowIso(), id);
  if (task.status !== to) addEvent(db, id, to, detail);
  return mustGet(db, id);
}

export interface TaskFilter {
  readonly status?: readonly TaskStatus[];
  readonly node?: PaidNode;
  readonly paidGateId?: number;
  readonly provider?: string;
}

export function listTasks(db: DatabaseSync, filter: TaskFilter = {}): TaskRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.status?.length) {
    where.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
    args.push(...filter.status);
  }
  if (filter.node) {
    where.push('node = ?');
    args.push(filter.node);
  }
  if (filter.paidGateId !== undefined) {
    where.push('paid_gate_id = ?');
    args.push(filter.paidGateId);
  }
  if (filter.provider) {
    where.push('provider = ?');
    args.push(filter.provider);
  }
  const sql = `SELECT * FROM generation_task${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
  return (db.prepare(sql).all(...args) as unknown as RawTask[]).map(toTask);
}

export interface TaskEventRow {
  readonly status: TaskStatus;
  readonly detail: unknown;
  readonly at: string;
}

export function taskEvents(db: DatabaseSync, taskId: number): TaskEventRow[] {
  const rows = db.prepare('SELECT status, detail, at FROM task_event WHERE task_id = ? ORDER BY id').all(taskId) as { status: TaskStatus; detail: string | null; at: string }[];
  return rows.map((r) => ({ status: r.status, detail: r.detail === null ? null : JSON.parse(r.detail), at: r.at }));
}

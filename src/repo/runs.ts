// 节点运行与每次模型调用的记录。执行器是异步的（等模型），不包大事务：每条记录单独写入、立即落盘。
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../domain/clock.ts';
import type { Stage } from '../domain/types.ts';
import type { TextUsage } from '../model/text-model.ts';

export const RUN_STATUSES = ['running', 'passed', 'needs_human', 'failed', 'resolved'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunInput {
  readonly stage: Stage;
  readonly skillId: number;
  readonly model: string;
  readonly inputId: number | null;
  readonly maxAttempts: number;
}

export interface RunRow {
  readonly id: number;
  readonly stage: Stage;
  readonly skillId: number;
  readonly model: string;
  readonly status: RunStatus;
  readonly maxAttempts: number;
  readonly artifactVersionId: number | null;
  readonly skippedHumanGates: readonly string[];
  readonly error: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface AttemptRow {
  readonly id: number;
  readonly step: string;
  readonly n: number;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly output: string | null;
  readonly violations: readonly string[];
  readonly usage: TextUsage | null;
}

interface RawRun {
  id: number;
  stage: Stage;
  skill_id: number;
  model: string;
  status: RunStatus;
  max_attempts: number;
  artifact_version_id: number | null;
  skipped_human_gates: string;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

const toRun = (r: RawRun): RunRow => ({
  id: r.id,
  stage: r.stage,
  skillId: r.skill_id,
  model: r.model,
  status: r.status,
  maxAttempts: r.max_attempts,
  artifactVersionId: r.artifact_version_id,
  skippedHumanGates: JSON.parse(r.skipped_human_gates),
  error: r.error,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程在，只是没权限发信号
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * 把已经没人在跑的 running 运行标为失败（进程中断），返回处理了几条。
 * 本进程的运行看 isActive（执行器登记的「正在跑」名单）；别的进程看进程号是否还在——
 * 进程号可能被系统复用，那种情况认不出来，用 `runs unlock` 手动解开。
 */
export function failInterruptedRuns(db: DatabaseSync, isActive: (runId: number) => boolean): number {
  const rows = db.prepare(`SELECT id, pid FROM node_run WHERE status = 'running'`).all() as { id: number; pid: number | null }[];
  const dead = rows.filter((r) => (r.pid === process.pid ? !isActive(r.id) : r.pid === null || !isAlive(r.pid)));
  for (const r of dead) {
    db.prepare(`UPDATE node_run SET status = 'failed', error = '进程中断', ended_at = ? WHERE id = ?`).run(nowIso(), r.id);
  }
  return dead.length;
}

export function runningRun(db: DatabaseSync, stage: Stage): RunRow | null {
  const row = db.prepare(`SELECT * FROM node_run WHERE stage = ? AND status = 'running' ORDER BY id DESC LIMIT 1`).get(stage) as RawRun | undefined;
  return row ? toRun(row) : null;
}

export function createRun(db: DatabaseSync, input: RunInput): number {
  const result = db
    .prepare(`INSERT INTO node_run (stage, skill_id, model, input_id, status, max_attempts, pid, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`)
    .run(input.stage, input.skillId, input.model, input.inputId, input.maxAttempts, process.pid, nowIso());
  return Number(result.lastInsertRowid);
}

export interface RunEnd {
  readonly status: Exclude<RunStatus, 'running' | 'resolved'>;
  readonly artifactVersionId?: number;
  readonly skippedHumanGates?: readonly string[];
  readonly error?: string;
}

export function finishRun(db: DatabaseSync, runId: number, end: RunEnd): void {
  db.prepare(`UPDATE node_run SET status = ?, artifact_version_id = ?, skipped_human_gates = ?, error = ?, ended_at = ? WHERE id = ?`).run(
    end.status,
    end.artifactVersionId ?? null,
    JSON.stringify(end.skippedHumanGates ?? []),
    end.error ?? null,
    nowIso(),
    runId,
  );
}

/**
 * 只有同阶段、状态为 needs_human、且之后没有更新的运行已经产出结果的，才能人工结案。
 * 导入之前先查：免得导了却结不了案，也免得旧的修复盖掉后来已经通过的产物。
 */
export function assertResolvable(db: DatabaseSync, runId: number, stage: Stage): void {
  const run = getRun(db, runId);
  if (!run) throw new Error(`没有这个运行：${runId}`);
  if (run.stage !== stage) throw new Error(`运行 ${runId} 是 ${run.stage} 阶段的，不是 ${stage}`);
  if (run.status !== 'needs_human') throw new Error(`运行 ${runId} 的状态是 ${run.status}，只有 needs_human 的运行能人工结案`);
  const newer = db
    .prepare(`SELECT id, status FROM node_run WHERE stage = ? AND id > ? AND status IN ('passed', 'resolved') ORDER BY id DESC LIMIT 1`)
    .get(stage, runId) as { id: number; status: RunStatus } | undefined;
  if (newer) {
    throw new Error(`运行 ${runId} 之后，run ${newer.id} 已经${newer.status === 'passed' ? '通过' : '结案'}并产出了更新的 ${stage}；确实要用这份修复覆盖，请去掉 --run 直接导入`);
  }
}

/** 手动解锁：卡在 running 的运行标为失败。 */
export function unlockRun(db: DatabaseSync, runId: number): RunRow {
  const run = getRun(db, runId);
  if (!run) throw new Error(`没有这个运行：${runId}`);
  if (run.status !== 'running') throw new Error(`运行 ${runId} 的状态是 ${run.status}，不需要解锁`);
  db.prepare(`UPDATE node_run SET status = 'failed', error = '人工解锁', ended_at = ? WHERE id = ?`).run(nowIso(), runId);
  return getRun(db, runId)!;
}

/** 人工修好后导入：把 needs_human 的运行结案，关联到这次导入的产物版本。 */
export function resolveRun(db: DatabaseSync, runId: number, stage: Stage, artifactVersionId: number): void {
  assertResolvable(db, runId, stage);
  db.prepare(`UPDATE node_run SET status = 'resolved', artifact_version_id = ?, ended_at = ? WHERE id = ?`).run(artifactVersionId, nowIso(), runId);
}

export function getRun(db: DatabaseSync, runId: number): RunRow | null {
  const row = db.prepare('SELECT * FROM node_run WHERE id = ?').get(runId) as RawRun | undefined;
  return row ? toRun(row) : null;
}

export function listRuns(db: DatabaseSync): RunRow[] {
  return (db.prepare('SELECT * FROM node_run ORDER BY id').all() as unknown as RawRun[]).map(toRun);
}

export interface AttemptInput {
  readonly runId: number;
  readonly step: string;
  readonly n: number;
  readonly system: string;
  readonly user: string;
}

export function startAttempt(db: DatabaseSync, a: AttemptInput): number {
  const result = db
    .prepare('INSERT INTO node_attempt (run_id, step, n, system_prompt, user_prompt, started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(a.runId, a.step, a.n, a.system, a.user, nowIso());
  return Number(result.lastInsertRowid);
}

export function endAttempt(db: DatabaseSync, attemptId: number, end: { output: string | null; violations: readonly string[]; usage: TextUsage | null }): void {
  db.prepare('UPDATE node_attempt SET output = ?, violations = ?, usage = ?, ended_at = ? WHERE id = ?').run(
    end.output,
    JSON.stringify(end.violations),
    end.usage ? JSON.stringify(end.usage) : null,
    nowIso(),
    attemptId,
  );
}

export function listAttempts(db: DatabaseSync, runId: number): AttemptRow[] {
  const rows = db.prepare('SELECT * FROM node_attempt WHERE run_id = ? ORDER BY id').all(runId) as {
    id: number;
    step: string;
    n: number;
    system_prompt: string;
    user_prompt: string;
    output: string | null;
    violations: string;
    usage: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    step: r.step,
    n: r.n,
    systemPrompt: r.system_prompt,
    userPrompt: r.user_prompt,
    output: r.output,
    violations: JSON.parse(r.violations),
    usage: r.usage ? JSON.parse(r.usage) : null,
  }));
}

// 编排记录：一次「一键跑」的模式、状态与汇总。同一项目同一时刻只允许一条 running。
// 每个阶段的运行自己记在 node_run 上（带 orchestration_id），这里只记汇总。
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/transaction.ts';
import { nowIso } from '../domain/clock.ts';
import { isAlive } from './runs.ts';

export const ORCHESTRATION_MODES = ['all', 'only-stale', 'single'] as const;
export type OrchestrationMode = (typeof ORCHESTRATION_MODES)[number];
export type OrchestrationStatus = 'running' | 'done' | 'blocked' | 'failed';

export interface OrchestrationRow {
  readonly id: number;
  readonly mode: OrchestrationMode;
  readonly status: OrchestrationStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly summary: unknown;
}

interface RawOrchestration {
  id: number;
  mode: OrchestrationMode;
  status: OrchestrationStatus;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

const toRow = (r: RawOrchestration): OrchestrationRow => ({
  id: r.id,
  mode: r.mode,
  status: r.status,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  summary: r.summary === null ? null : JSON.parse(r.summary),
});

/** 进程已经不在的 running 编排标为失败（同 failInterruptedRuns 的规则），返回处理了几条。 */
export function failInterruptedOrchestrations(db: DatabaseSync, isActive: (id: number) => boolean): number {
  const rows = db.prepare(`SELECT id, pid FROM orchestration WHERE status = 'running'`).all() as { id: number; pid: number | null }[];
  const dead = rows.filter((r) => (r.pid === process.pid ? !isActive(r.id) : r.pid === null || !isAlive(r.pid)));
  for (const r of dead) {
    db.prepare(`UPDATE orchestration SET status = 'failed', ended_at = ?, summary = ? WHERE id = ?`).run(nowIso(), JSON.stringify({ error: '进程中断' }), r.id);
  }
  return dead.length;
}

/** 开一条编排；已有 running 的就拒绝（检查和插入在同一个写事务里，两个进程不会同时开成）。 */
export function startOrchestration(db: DatabaseSync, mode: OrchestrationMode): number {
  return withTransaction(db, () => {
    const busy = db.prepare(`SELECT id FROM orchestration WHERE status = 'running' LIMIT 1`).get() as { id: number } | undefined;
    if (busy) throw new Error(`已有编排在运行（orchestration ${busy.id}），等它结束再开`);
    const result = db.prepare(`INSERT INTO orchestration (mode, status, pid, started_at) VALUES (?, 'running', ?, ?)`).run(mode, process.pid, nowIso());
    return Number(result.lastInsertRowid);
  });
}

export function finishOrchestration(db: DatabaseSync, id: number, status: Exclude<OrchestrationStatus, 'running'>, summary: unknown): void {
  db.prepare('UPDATE orchestration SET status = ?, ended_at = ?, summary = ? WHERE id = ?').run(status, nowIso(), JSON.stringify(summary), id);
}

export function getOrchestration(db: DatabaseSync, id: number): OrchestrationRow | null {
  const row = db.prepare('SELECT * FROM orchestration WHERE id = ?').get(id) as RawOrchestration | undefined;
  return row ? toRow(row) : null;
}

export function listOrchestrations(db: DatabaseSync): OrchestrationRow[] {
  return (db.prepare('SELECT * FROM orchestration ORDER BY id').all() as unknown as RawOrchestration[]).map(toRow);
}

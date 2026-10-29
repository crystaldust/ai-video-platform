// 付费确认单：文本阶段跑完后停在付费阶段之前，存一份当时的估算（含价格来源）。
// 确认与勾选由 Phase 5 的生成器处理；新确认单生成时，之前还在等确认的旧单作废——估算已经过时。
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/transaction.ts';
import { nowIso } from '../domain/clock.ts';
import type { ProjectEstimate } from '../estimate/estimate.ts';

export type PaidGateStatus = 'awaiting_confirmation' | 'confirmed' | 'cancelled';

export interface PaidGateRow {
  readonly id: number;
  readonly orchestrationId: number | null;
  readonly status: PaidGateStatus;
  readonly estimate: ProjectEstimate;
  readonly selection: unknown;
  readonly budgetCap: number | null;
  readonly currency: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

interface RawGate {
  id: number;
  orchestration_id: number | null;
  status: PaidGateStatus;
  estimate: string;
  selection: string | null;
  budget_cap: number | null;
  currency: string | null;
  created_at: string;
  decided_at: string | null;
}

const toRow = (r: RawGate): PaidGateRow => ({
  id: r.id,
  orchestrationId: r.orchestration_id,
  status: r.status,
  estimate: JSON.parse(r.estimate),
  selection: r.selection === null ? null : JSON.parse(r.selection),
  budgetCap: r.budget_cap,
  currency: r.currency,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export function createPaidGate(db: DatabaseSync, input: { orchestrationId: number | null; estimate: ProjectEstimate }): PaidGateRow {
  return withTransaction(db, () => {
    const at = nowIso();
    db.prepare(`UPDATE paid_gate SET status = 'cancelled', decided_at = ? WHERE status = 'awaiting_confirmation'`).run(at);
    const result = db
      .prepare(`INSERT INTO paid_gate (orchestration_id, status, estimate, currency, created_at) VALUES (?, 'awaiting_confirmation', ?, ?, ?)`)
      .run(input.orchestrationId, JSON.stringify(input.estimate), input.estimate.currency, at);
    return getPaidGate(db, Number(result.lastInsertRowid))!;
  });
}

export function getPaidGate(db: DatabaseSync, id: number): PaidGateRow | null {
  const row = db.prepare('SELECT * FROM paid_gate WHERE id = ?').get(id) as RawGate | undefined;
  return row ? toRow(row) : null;
}

export function listPaidGates(db: DatabaseSync): PaidGateRow[] {
  return (db.prepare('SELECT * FROM paid_gate ORDER BY id').all() as unknown as RawGate[]).map(toRow);
}

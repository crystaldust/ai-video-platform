// 测试共用：渡口全套产物 + 一张已确认的付费确认单（估算用内置价格、汇率 7），付费生成的计划、执行、恢复测试都从这里起步。
import { loadPriceSources, type PriceSources } from '../../src/pricing/prices.ts';
import { createPaidGate, decidePaidGate, getPaidGate, type PaidGateRow } from '../../src/repo/paid-gates.ts';
import type { Project } from '../../src/project.ts';
import { importAll, tempProject } from '../helpers.ts';
import { testEstimate } from './server-harness.ts';

export const PRICES: PriceSources = loadPriceSources('/nonexistent-avp');

export function confirmGate(project: Project, selection: Record<string, true | string[]>, budgetCap = 500): PaidGateRow {
  const gate = createPaidGate(project.db, { orchestrationId: null, estimate: testEstimate(project.db) });
  decidePaidGate(project.db, gate.id, { status: 'confirmed', selection, budgetCap, currency: 'CNY' });
  return getPaidGate(project.db, gate.id)!;
}

export function genProject(): ReturnType<typeof tempProject> {
  const t = tempProject();
  importAll(t.project);
  return t;
}

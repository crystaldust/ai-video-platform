// 付费任务的两个人工操作，故意分开：
//   重新查询（requery）：只查询、下载，不花钱；未知的任务可以由人指定供应商任务 id（在供应商控制台核对过）
//   重新生成（regenerate）：新建一条任务（attempt_of 指向旧的），要再提交、再花钱——只能由人明确发起
import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../project.ts';
import { getPaidGate } from '../repo/paid-gates.ts';
import { createTask, getTask, listTasks, recordProviderId, type TaskRow } from '../repo/tasks.ts';
import { TERMINAL } from './state-machine.ts';
import { refreshTask, type GenerateOptions } from './runner.ts';

export async function requeryTask(project: Project, taskId: number, opts: GenerateOptions & { readonly providerTaskId?: string }): Promise<TaskRow> {
  const task = getTask(project.db, taskId);
  if (!task) throw new Error(`没有这个任务：${taskId}`);
  const gate = task.paidGateId === null ? null : getPaidGate(project.db, task.paidGateId);
  if (!gate) throw new Error(`任务 ${taskId} 不属于任何付费确认单`);
  if (opts.providerTaskId) {
    if (task.status !== 'unknown') throw new Error(`只有「未知」的任务才能指定供应商任务 id（任务 ${taskId} 是 ${task.status}）`);
    recordProviderId(project.db, taskId, opts.providerTaskId);
  }
  return refreshTask(project, gate, taskId, opts);
}

/** 能重新生成的：失败、被拒、取消、已入库（想要另一版）。在途、提交中、未知的不行——先对账或重新查询，免得重复付费。 */
const REGENERABLE = new Set(['failed', 'rejected', 'cancelled', 'collected']);

export function regenerateTask(db: DatabaseSync, taskId: number): TaskRow {
  const old = getTask(db, taskId);
  if (!old) throw new Error(`没有这个任务：${taskId}`);
  if (!REGENERABLE.has(old.status)) throw new Error(`任务 ${taskId} 是 ${old.status}，不能重新生成：只有失败、被拒、取消、已入库的可以（提交中、未知的先对账或重新查询）`);
  if (!old.node || !old.label) throw new Error(`任务 ${taskId} 没有节点信息（Phase 5 之前的任务），不能重新生成`);
  const live = listTasks(db, { node: old.node, ...(old.paidGateId === null ? {} : { paidGateId: old.paidGateId }) }).find((t) => t.label === old.label && !TERMINAL.has(t.status));
  if (live) throw new Error(`${old.label} 已经有一条没结束的任务 ${live.id}（${live.status}），不能再重新生成`);
  return createTask(db, {
    targetVersionId: old.targetVersionId,
    capability: old.capability === 'video' ? 'video' : 'image',
    provider: old.provider,
    model: old.model,
    node: old.node,
    episodeKey: old.episodeKey,
    label: old.label,
    plannedInput: old.plannedInput,
    costEstimate: old.costEstimate,
    currency: old.currency,
    paidGateId: old.paidGateId,
    attemptOf: old.id,
  });
}

// 付费任务的状态机：合法转移写成表，别的一律拒绝。
// 要害在「提交中」：请求可能已经到达供应商，所以它只能等对账（补记 id / 判失败 / 判未知），
// 永远不能回到 planned——回去就会被再提交一次，两家供应商都没有幂等键，那就是重复付费。

export const TASK_STATUSES = ['planned', 'submitting', 'submitted', 'running', 'succeeded', 'collected', 'failed', 'rejected', 'cancelled', 'unknown'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const isTaskStatus = (x: unknown): x is TaskStatus => (TASK_STATUSES as readonly unknown[]).includes(x);

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  // 超预算、人取消：还没花钱，可以直接取消；明确的参数错在提交前就能判
  planned: ['submitting', 'cancelled', 'failed'],
  // 拿到 id；4xx 明确没创建（失败 / 内容审核）；崩溃后对账：没找到 → 失败，对出多个 → 未知
  submitting: ['submitted', 'failed', 'rejected', 'unknown'],
  // 图片任务可能一查就完成，跳过 running
  submitted: ['running', 'succeeded', 'failed', 'rejected', 'cancelled', 'unknown'],
  running: ['succeeded', 'failed', 'rejected', 'unknown'],
  // 下载入库成功 → collected；结果过期拿不到 → failed
  succeeded: ['collected', 'failed'],
  // 人用 requery 指定了供应商任务 id，或判定没到达
  unknown: ['submitted', 'running', 'succeeded', 'failed', 'rejected', 'cancelled'],
  collected: [],
  failed: [],
  rejected: [],
  cancelled: [],
};

/** 终态：不再查询、不再变化；要再来一次就「重新生成」，新建一条任务。 */
export const TERMINAL: ReadonlySet<TaskStatus> = new Set(TASK_STATUSES.filter((s) => TRANSITIONS[s].length === 0));

export const canTransition = (from: TaskStatus, to: TaskStatus): boolean => TRANSITIONS[from].includes(to);

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new Error(`任务状态不能从 ${from} 变成 ${to}`);
}

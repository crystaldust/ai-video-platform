// 付费任务的状态机：先写库再请求、崩溃后只对账不重提——合法转移以外的一律拒绝。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTransition, canTransition, isTaskStatus, TASK_STATUSES, TERMINAL } from '../src/generate/state-machine.ts';

test('状态集合与 v7 迁移的 CHECK 一致', () => {
  assert.deepEqual([...TASK_STATUSES], ['planned', 'submitting', 'submitted', 'running', 'succeeded', 'collected', 'failed', 'rejected', 'cancelled', 'unknown']);
  assert.ok(isTaskStatus('submitting'));
  assert.ok(!isTaskStatus('weird'));
});

test('主路径：planned → submitting → submitted → running → succeeded → collected', () => {
  const path = ['planned', 'submitting', 'submitted', 'running', 'succeeded', 'collected'] as const;
  for (let i = 1; i < path.length; i++) assert.ok(canTransition(path[i - 1]!, path[i]!), `${path[i - 1]} → ${path[i]}`);
  assert.ok(canTransition('submitted', 'succeeded'), '图片任务可能一查就完成，跳过 running');
});

test('提交中只能等对账：拿到 id、确定没到达（失败）、对出多个（未知）、明确被拒；不能回到 planned 再提交一次', () => {
  for (const to of ['submitted', 'failed', 'unknown', 'rejected'] as const) assert.ok(canTransition('submitting', to), `submitting → ${to}`);
  assert.ok(!canTransition('submitting', 'planned'), '回到 planned 就会被再提交一次，可能重复付费');
  assert.throws(() => assertTransition('submitting', 'planned'), /不能从 submitting 变成 planned/);
});

test('未知只能靠人指定 id 或判失败；终态不再变', () => {
  assert.ok(canTransition('unknown', 'submitted'));
  assert.ok(canTransition('unknown', 'failed'));
  assert.ok(!canTransition('unknown', 'submitting'));
  for (const s of TERMINAL) for (const to of TASK_STATUSES) assert.ok(!canTransition(s, to), `${s} 是终态`);
  assert.deepEqual([...TERMINAL].sort(), ['cancelled', 'collected', 'failed', 'rejected']);
});

test('planned 可以取消（超预算、人取消）；已提交的不能直接取消', () => {
  assert.ok(canTransition('planned', 'cancelled'));
  assert.ok(!canTransition('running', 'cancelled'));
});

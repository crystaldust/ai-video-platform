// 生成任务页的纯逻辑：状态的颜色与文字、排队任务在不同情况下怎么说、进度数字、费用文字、预览切换、确认弹窗扣掉的已生成项。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costText, nextPreview, progressOf, skippedFor, taskLabel, taskState, taskTone, viewTitle } from '../web/src/generation.ts';

const counts = (over: Record<string, number>) => ({ planned: 0, submitting: 0, submitted: 0, running: 0, succeeded: 0, collected: 0, failed: 0, rejected: 0, cancelled: 0, unknown: 0, ...over });

test('状态 → 颜色与文字', () => {
  assert.deepEqual([taskTone('collected'), taskLabel('collected')], ['ok', '已完成']);
  assert.deepEqual([taskTone('running'), taskLabel('running')], ['run', '生成中']);
  assert.deepEqual([taskTone('submitted'), taskLabel('submitted')], ['run', '生成中']);
  assert.deepEqual([taskTone('failed'), taskLabel('failed')], ['err', '失败']);
  assert.deepEqual([taskTone('rejected'), taskLabel('rejected')], ['warn', '被拒']);
  assert.deepEqual([taskTone('unknown'), taskLabel('unknown')], ['warn', '结果未知']);
  assert.equal(taskLabel('succeeded'), '下载中');
});

test('排队的任务：生成在跑时「排队」，停了是「未提交」，超了上限是「预算停下」', () => {
  const t = { status: 'planned' as const, costEstimate: 0.23 };
  assert.equal(taskState(t, { running: true, spent: 9.9, cap: 10 }).label, '排队');
  assert.equal(taskState(t, { running: false, spent: 1, cap: 10 }).label, '未提交');
  assert.equal(taskState(t, { running: false, spent: 9.9, cap: 10 }).label, '预算停下');
  assert.equal(taskState(t, { running: false, spent: 9.9, cap: null }).label, '未提交');
  assert.equal(taskState({ status: 'collected', costEstimate: 0.23 }, { running: false, spent: 99, cap: 1 }).label, '已完成');
});

test('进度：完成、在途、排队、失败、被拒与占比', () => {
  const p = progressOf({ total: 36, counts: counts({ collected: 23, running: 3, planned: 8, failed: 1, rejected: 1 }) });
  assert.deepEqual([p.done, p.active, p.queued, p.failed, p.rejected], [23, 3, 8, 1, 1]);
  assert.ok(Math.abs(p.ratio - 23 / 36) < 1e-9);
  assert.ok(Math.abs(p.badRatio - 2 / 36) < 1e-9);
  assert.deepEqual(progressOf({ total: 0, counts: counts({}) }).ratio, 0);
});

test('费用文字：实际、不计费、预估、查不到', () => {
  assert.equal(costText({ status: 'collected', costEstimate: 0.2, costActual: 0.213 }), '¥0.21');
  assert.equal(costText({ status: 'rejected', costEstimate: 0.2, costActual: 0 }), '不计费');
  assert.equal(costText({ status: 'planned', costEstimate: 0.23, costActual: null }), '¥0.23 预估');
  assert.equal(costText({ status: 'collected', costEstimate: 0.23, costActual: null }), '¥0.23');
  assert.equal(costText({ status: 'planned', costEstimate: null, costActual: null }), '—');
});

test('预览切换：到头停住，不绕回；当前不在列表里从第一个开始', () => {
  assert.equal(nextPreview([1, 2, 3], 2, 1), 3);
  assert.equal(nextPreview([1, 2, 3], 3, 1), 3);
  assert.equal(nextPreview([1, 2, 3], 1, -1), 1);
  assert.equal(nextPreview([1, 2, 3], 9, 1), 1);
  assert.equal(nextPreview([], 1, 1), null);
});

test('视图名', () => {
  assert.equal(viewTitle('front-full'), '正面全身');
  assert.equal(viewTitle('face-45'), '45° 大头照');
  assert.equal(viewTitle('weird'), 'weird');
});

test('确认弹窗：按勾选扣掉会跳过的已生成项', () => {
  const skip = {
    'image:character-refs': { count: 4, cny: 0.85, byEpisode: {} },
    'image:keyframe': { count: 3, cny: 0.6, byEpisode: { ep1: { count: 2, cny: 0.4 }, ep2: { count: 1, cny: 0.2 } } },
  };
  const all = skippedFor(skip, true, new Set(['image:keyframe|ep1']));
  assert.equal(all.count, 6);
  assert.ok(Math.abs(all.cny - 1.25) < 1e-9);
  assert.deepEqual(all.byNode['image:keyframe'], { count: 2, cny: 0.4 });
  const none = skippedFor(skip, false, new Set());
  assert.deepEqual([none.count, none.cny, none.byNode], [0, 0, {}]);
});

test('勾选的一句话', async () => {
  const { selectionText } = await import('../web/src/generation.ts');
  assert.equal(selectionText({ 'image:character-refs': true, 'image:keyframe': ['a', 'b'], 'video:segment': [] }), '角色参考图 · 关键帧 2 集');
  assert.equal(selectionText(null), '—');
  assert.equal(selectionText({}), '—');
});

test('生成失败的出路：角色卡缺出图提示词 → 重跑角色阶段（only: cast，要先确认）；别的原因没有直达操作', async () => {
  const { remedyFor } = await import('../web/src/generation.ts');
  const r = remedyFor('角色卡「卡特」（C01）没有出图提示词：先重跑角色阶段（角色图提示词由 character-refs 生成）');
  assert.deepEqual(r && { label: r.label, body: r.body }, { label: '重跑角色阶段', body: { only: 'cast' } });
  assert.match(r!.confirm, /DeepSeek|花钱|费用/);
  assert.equal(remedyFor('角色卡「卡特」（C01）的出图提示词缺视图 face-45：先重跑角色阶段')?.body.only, 'cast');
  assert.equal(remedyFor('没有 dashscope 的凭据：设置环境变量 DASHSCOPE_API_KEY，或运行 cred set dashscope'), null);
  assert.equal(remedyFor(null), null);
});

test('确认单该显示成哪种样子：生成中 / 出错 / 待开始 / 普通进度', async () => {
  const { gatePhase } = await import('../web/src/generation.ts');
  const base = { running: false, error: null, toCreate: null, total: 0 };
  assert.equal(gatePhase({ ...base, running: true }), 'running');
  assert.equal(gatePhase({ ...base, error: '先重跑角色阶段' }), 'failed');
  assert.equal(gatePhase({ ...base, toCreate: 40 }), 'pending');
  assert.equal(gatePhase({ ...base, toCreate: 0 }), 'progress', '都生成过了：按普通进度显示');
  assert.equal(gatePhase({ ...base, total: 20 }), 'progress');
  assert.equal(gatePhase({ ...base, running: true, error: '旧的错' }), 'running', '在跑优先');
});

test('「确认付费生成」按钮：有等待确认的就打开它；没有就先开新单；在跑或算不出估算时不能点', async () => {
  const { paidButton } = await import('../web/src/generation.ts');
  assert.deepEqual(paidButton({ gateId: 4, busy: false, hasEstimate: true }), { action: 'open', gateId: 4, disabledReason: null });
  assert.deepEqual(paidButton({ gateId: null, busy: false, hasEstimate: true }), { action: 'create', gateId: null, disabledReason: null });
  assert.match(paidButton({ gateId: 4, busy: true, hasEstimate: true }).disabledReason!, /有任务在跑/);
  assert.match(paidButton({ gateId: null, busy: false, hasEstimate: false }).disabledReason!, /估算/);
});

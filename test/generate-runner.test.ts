// 付费生成的执行：按依赖调度（锚点 → 派生视图与关键帧 → 视频）、先写库再提交、预算到线就停、
// 审核拒绝与依赖它的任务、结果未知不重提、限流等一等再提同一条、下载失败可单独重试——全程不重复提交。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ImageRequest, VideoRequest } from '../src/model/media-model.ts';
import { runGeneration, type GenerateOptions } from '../src/generate/runner.ts';
import { planGeneration } from '../src/generate/planner.ts';
import { candidateOfTask } from '../src/repo/candidates.ts';
import { getTask, listTasks } from '../src/repo/tasks.ts';
import type { PaidGateRow } from '../src/repo/paid-gates.ts';
import type { Project } from '../src/project.ts';
import { DUKO } from './helpers.ts';
import { FakeMediaModel, fakeDownload, type FakeBehavior } from './support/fake-media.ts';
import { confirmGate, genProject, PRICES } from './support/gen-fixture.ts';

const ALL = { 'image:character-refs': true as const, 'image:keyframe': [DUKO.ep1], 'video:segment': [DUKO.ep1] };

function rig(project: Project, gate: PaidGateRow, image: FakeBehavior = {}, video: FakeBehavior = {}, failUrls?: Set<string>) {
  planGeneration(project.db, gate, PRICES);
  const img = new FakeMediaModel<ImageRequest>('dashscope', 'qwen-image-3.0', 'image', image);
  const vid = new FakeMediaModel<VideoRequest>('minimax', 'MiniMax-H3-Lite', 'video', video);
  const dl = fakeDownload(failUrls);
  const opts: GenerateOptions = { modelFor: (provider) => (provider === 'dashscope' ? img : vid), download: dl.download, prices: PRICES, sleep: async () => {}, pollMs: 0, pid: process.pid };
  return { img, vid, dl, opts, run: (o: Partial<GenerateOptions> = {}) => runGeneration(project, gate, { ...opts, ...o }) };
}

test('全勾第 1 集：全部入库为候选；锚点先于派生视图；关键帧挂锚点；视频按 Picture 顺序挂各切关键帧', async () => {
  const { project, cleanup } = genProject();
  const gate = confirmGate(project, ALL);
  const { img, vid, run } = rig(project, gate);
  const summary = await run();
  assert.equal(summary.counts['collected'], 64);
  assert.equal(img.submits.length, 54, '20 张参考图 + 34 帧关键帧，各提交一次');
  assert.equal(vid.submits.length, 10);
  const order = img.submits.map((s) => s.prompt);
  const anchorAt = order.findIndex((p) => p.includes('Full-body front view') && p.includes('slender nineteen-year-old'));
  const sideAt = order.findIndex((p) => p.includes('Full-body side profile') && p.includes('slender nineteen-year-old'));
  assert.ok(anchorAt >= 0 && sideAt > anchorAt, '派生视图在锚点入库之后才提交');
  assert.equal(img.submits.find((s) => s.prompt.startsWith('参考图 1 是「沈知微」'))!.refs.length, 1);
  assert.equal(vid.submits.find((s) => s.prompt === vid.submits[0]!.prompt)!.refs.length, 4, '第 1 段 4 切');
  for (const t of listTasks(project.db, { paidGateId: gate.id })) assert.ok(candidateOfTask(project.db, t.id), `任务 ${t.label} 有候选`);
  const anchor = listTasks(project.db, { paidGateId: gate.id }).find((t) => t.label === 'C01:front-full')!;
  assert.equal(candidateOfTask(project.db, anchor.id)!.label, 'front-full v1');
  assert.ok(anchor.costActual !== null && anchor.costActual > 0, '按用量记实际费用');
  cleanup();
});

test('再跑一次：已入库的不再提交', async () => {
  const { project, cleanup } = genProject();
  const gate = confirmGate(project, { 'image:keyframe': [DUKO.ep1] });
  const r = rig(project, gate);
  await r.run();
  await r.run();
  assert.equal(r.img.submits.length, 34);
  cleanup();
});

test('预算到线就停：剩下的保持 planned、不提交；按人民币比较', async () => {
  const { project, cleanup } = genProject();
  const gate = confirmGate(project, { 'image:keyframe': [DUKO.ep1] }, 1);
  const { img, run } = rig(project, gate);
  const summary = await run();
  // 每帧 0.03 美元 × 7 = 0.21 元：1 元的上限只够 4 帧
  assert.equal(img.submits.length, 4);
  assert.ok(summary.budgetStopped);
  assert.equal(summary.counts['planned'], 30);
  cleanup();
});

test('审核拒绝：这一帧 rejected、不计费；依赖它的视频不提交，汇总里说明', async () => {
  const { project, cleanup } = genProject();
  const gate = confirmGate(project, { 'image:keyframe': [DUKO.ep1], 'video:segment': [DUKO.ep1] });
  const { vid, run } = rig(project, gate, { rejectPrompts: ['灯'] });
  const summary = await run();
  const rejected = listTasks(project.db, { paidGateId: gate.id, status: ['rejected'] });
  assert.ok(rejected.length > 0);
  assert.ok(rejected.every((t) => t.costActual === 0 && /审核/.test(t.error ?? '')), '百炼审核失败不收费');
  assert.ok(summary.blocked.length > 0 && summary.blocked.every((b) => /关键帧/.test(b.reason)));
  assert.equal(vid.submits.length + summary.blocked.length, 10);
  cleanup();
});

test('提交结果未知：任务停在 submitting，不重提；依赖它的不提交；这家供应商这次不再提交', async () => {
  const { project, cleanup } = genProject();
  const gate = confirmGate(project, { 'image:character-refs': true });
  const { img, run } = rig(project, gate, { failSubmit: new Map([[1, 'unknown']]) });
  const summary = await run();
  const stuck = listTasks(project.db, { paidGateId: gate.id, status: ['submitting'] });
  assert.equal(stuck.length, 1);
  assert.deepEqual(summary.unknownSubmits, [stuck[0]!.id]);
  // 第一个锚点没回音：它的 4 个派生视图被挡住；百炼这次不再提交（对账时间窗里只留它一个）
  assert.equal(img.submits.length, 1);
  assert.equal(summary.blocked.length, 4);
  assert.equal(summary.counts['planned'], 19);
  cleanup();
});

test('限流：等一等再提交同一条任务，最终只有一个供应商任务；参数错直接 failed', async () => {
  const { project, cleanup } = genProject();
  const gate = confirmGate(project, { 'image:keyframe': [DUKO.ep1] });
  const { img, run } = rig(project, gate, { failSubmit: new Map([[1, 'rate'], [3, 'invalid']]) });
  const summary = await run();
  assert.equal(img.submits.length, 35, '限流那次多提交一回');
  assert.equal(img.tasks.length, 33, '供应商只建了 33 个任务：限流、参数错都没建');
  assert.equal(summary.counts['collected'], 33);
  assert.equal(summary.counts['failed'], 1);
  cleanup();
});

test('下载失败：停在 succeeded，再跑时只重新下载、不重新提交', async () => {
  const { project, cleanup } = genProject();
  const gate = confirmGate(project, { 'image:keyframe': [DUKO.ep1] });
  const bad = new Set(['https://fake/dashscope-1.png']);
  const r = rig(project, gate, {}, {}, bad);
  const first = await r.run();
  assert.equal(first.downloadFailed.length, 1);
  const stuck = getTask(project.db, first.downloadFailed[0]!)!;
  assert.equal(stuck.status, 'succeeded');
  bad.clear();
  const second = await r.run();
  assert.equal(second.counts['collected'], 34);
  assert.equal(r.img.submits.length, 34);
  cleanup();
});

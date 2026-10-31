// 崩溃恢复（PRD Phase 5 成功标准）：进程死在提交前、提交后，重启对账——唯一匹配补记 id、没找到判失败、对出多个交给人；
// 全程 submit 次数不增加；还活着的进程的任务不碰。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ImageRequest, VideoRequest } from '../src/model/media-model.ts';
import { planGeneration } from '../src/generate/planner.ts';
import { recoverTasks } from '../src/generate/recovery.ts';
import { runGeneration, type GenerateOptions } from '../src/generate/runner.ts';
import { getTask, listTasks, markSubmitting, recordProviderId } from '../src/repo/tasks.ts';
import { DUKO } from './helpers.ts';
import { CrashAfterSubmit, FakeMediaModel, fakeDownload, type FakeBehavior } from './support/fake-media.ts';
import { confirmGate, genProject, PRICES } from './support/gen-fixture.ts';

const DEAD_PID = 999_999_999;

function rig(behavior: FakeBehavior = {}) {
  const t = genProject();
  const gate = confirmGate(t.project, { 'image:keyframe': [DUKO.ep1] });
  planGeneration(t.project.db, gate, PRICES);
  const img = new FakeMediaModel<ImageRequest>('dashscope', 'qwen-image-3.0', 'image', behavior);
  const vid = new FakeMediaModel<VideoRequest>('minimax', 'MiniMax-H3-Lite', 'video');
  const opts: GenerateOptions = { modelFor: (p) => (p === 'dashscope' ? img : vid), download: fakeDownload().download, prices: PRICES, sleep: async () => {}, pollMs: 0, pid: DEAD_PID };
  return { ...t, gate, img, opts, recover: () => recoverTasks(t.project, { modelFor: opts.modelFor }) };
}

test('提交后、记 id 前崩溃：对账在供应商列表里唯一匹配 → 补记 id；续跑只查询、下载，submit 总次数仍为 1', async () => {
  const r = rig({ crashAfterSubmit: 1 });
  await assert.rejects(runGeneration(r.project, r.gate, r.opts), CrashAfterSubmit);
  const stuck = listTasks(r.project.db, { status: ['submitting'] });
  assert.equal(stuck.length, 1);
  const report = await r.recover();
  assert.deepEqual(report.matched, [stuck[0]!.id]);
  const fixed = getTask(r.project.db, stuck[0]!.id)!;
  assert.equal(fixed.status, 'submitted');
  assert.equal(fixed.providerTaskId, r.img.tasks[0]!.id);
  await runGeneration(r.project, r.gate, { ...r.opts, submit: false });
  assert.equal(getTask(r.project.db, fixed.id)!.status, 'collected');
  assert.equal(r.img.submits.length, 1, '没有重复提交');
  r.cleanup();
});

test('请求在路上丢了（供应商没建任务）：对账没找到 → failed，写明可安全重新生成', async () => {
  const r = rig({ lostSubmit: 1 });
  const summary = await runGeneration(r.project, r.gate, { ...r.opts, submit: true });
  assert.equal(summary.unknownSubmits.length, 1);
  const report = await r.recover();
  assert.deepEqual(report.notFound, summary.unknownSubmits);
  const t = getTask(r.project.db, summary.unknownSubmits[0]!)!;
  assert.equal(t.status, 'failed');
  assert.match(t.error ?? '', /可以安全重新生成/);
  assert.equal(r.img.submits.length, 1, '丢的那条没有自动重提；结果未知之后这次不再往百炼提交'); 
  r.cleanup();
});

test('提交前崩溃（已写「提交中」、请求没发出）：对账没找到 → failed；供应商 0 次调用', async () => {
  const r = rig();
  const t = listTasks(r.project.db, { status: ['planned'] })[0]!;
  markSubmitting(r.project.db, t.id, DEAD_PID);
  const report = await r.recover();
  assert.deepEqual(report.notFound, [t.id]);
  assert.equal(r.img.submits.length, 0);
  r.cleanup();
});

test('时间窗里有多个不认识的任务：不猜 → unknown，列出候选 id，交给人', async () => {
  const r = rig();
  await r.img.submit({ prompt: '别的程序 1', size: '1*1', refs: [] });
  await r.img.submit({ prompt: '别的程序 2', size: '1*1', refs: [] });
  const t = listTasks(r.project.db, { status: ['planned'] })[0]!;
  markSubmitting(r.project.db, t.id, DEAD_PID);
  const report = await r.recover();
  assert.deepEqual(report.ambiguous, [t.id]);
  const got = getTask(r.project.db, t.id)!;
  assert.equal(got.status, 'unknown');
  assert.match(got.error ?? '', /dashscope-1.*dashscope-2|dashscope-2.*dashscope-1/);
  r.cleanup();
});

test('已经记在别的任务上的供应商 id 不算；还活着的进程的任务不碰', async () => {
  const r = rig();
  await r.img.submit({ prompt: '已记录的', size: '1*1', refs: [] });
  const [a, b, c] = listTasks(r.project.db, { status: ['planned'] });
  markSubmitting(r.project.db, a!.id, DEAD_PID);
  recordProviderId(r.project.db, a!.id, 'dashscope-1');
  markSubmitting(r.project.db, b!.id, DEAD_PID);
  markSubmitting(r.project.db, c!.id, process.ppid);
  const report = await r.recover();
  assert.deepEqual(report.notFound, [b!.id], '唯一的那个 id 已经记在 a 上，b 没有匹配');
  assert.equal(getTask(r.project.db, c!.id)!.status, 'submitting', '父进程还活着：不碰');
  r.cleanup();
});

// 审查后补的防线：看不懂的状态不判失败、查不到转未知；结果未知后这家停止提交；预算不漏算；
// 重新生成不重复建；对账列表没取完不判「没到达」；地址只认官方域名；408 按结果未知；另一个进程在提交时拒绝启动。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateCommand } from '../src/cli-generate.ts';
import { mediaEndpoint } from '../src/config/endpoints.ts';
import { regenerateTask } from '../src/generate/manage.ts';
import { planGeneration } from '../src/generate/planner.ts';
import { recoverTasks } from '../src/generate/recovery.ts';
import { runGeneration, type GenerateOptions } from '../src/generate/runner.ts';
import { DashScopeImageModel } from '../src/model/dashscope-image.ts';
import type { ImageRequest, VideoRequest } from '../src/model/media-model.ts';
import { SubmitError } from '../src/model/media-model.ts';
import { MiniMaxVideoModel } from '../src/model/minimax-video.ts';
import { getTask, listTasks, markSubmitting } from '../src/repo/tasks.ts';
import { DUKO } from './helpers.ts';
import { fakeHttp } from './support/fake-http.ts';
import { FakeMediaModel, fakeDownload, type FakeBehavior } from './support/fake-media.ts';
import { confirmGate, genProject, PRICES } from './support/gen-fixture.ts';

function rig(behavior: FakeBehavior = {}, cap = 500) {
  const t = genProject();
  const gate = confirmGate(t.project, { 'image:keyframe': [DUKO.ep1] }, cap);
  planGeneration(t.project.db, gate, PRICES);
  const img = new FakeMediaModel<ImageRequest>('dashscope', 'qwen-image-3.0', 'image', behavior);
  const vid = new FakeMediaModel<VideoRequest>('minimax', 'MiniMax-H3-Lite', 'video');
  const opts: GenerateOptions = { modelFor: (p) => (p === 'dashscope' ? img : vid), download: fakeDownload().download, prices: PRICES, sleep: async () => {}, pollMs: 0, pid: process.pid };
  return { ...t, gate, img, opts };
}

test('适配器：看不懂的状态、缺 task 字段 → 查询出错（不改任务状态）；百炼明说查不到 → unknown', async () => {
  const mm = (body: unknown) => new MiniMaxVideoModel('MiniMax-H3-Lite', 'k', 'https://api.minimax.io', fakeHttp([{ status: 200, body }]));
  await assert.rejects(mm({ task: { status: 'preparing' } }).query('x'), /看不懂/);
  await assert.rejects(mm({ base_resp: {} }).query('x'), /看不懂/);
  const ds = (body: unknown) => new DashScopeImageModel('qwen-image-3.0', 'k', 'https://dashscope-intl.aliyuncs.com', fakeHttp([{ status: 200, body }]));
  await assert.rejects(ds({ output: { task_status: 'WEIRD' } }).query('x'), /看不懂/);
  assert.equal((await ds({ output: { task_status: 'UNKNOWN' } }).query('x')).state, 'unknown');
});

test('适配器：提交返回 408 按结果未知（可能已建任务）', async () => {
  const m = new MiniMaxVideoModel('MiniMax-H3-Lite', 'k', 'https://api.minimax.io', fakeHttp([{ status: 408, body: 'timeout' }]));
  await assert.rejects(m.submit({ prompt: 'p', refs: [], duration: 4, resolution: '480P', ratio: '9:16' }), (e: unknown) => e instanceof SubmitError && e.kind === 'unknown');
});

test('供应商说查不到：任务转 unknown（交给人），不是 failed；unknown 不能直接重新生成', async () => {
  const r = rig({ queryMode: 'unknown' });
  const summary = await runGeneration(r.project, r.gate, r.opts);
  assert.equal(summary.counts['unknown'], 34);
  assert.equal(summary.counts['failed'], 0);
  assert.throws(() => regenerateTask(r.project.db, listTasks(r.project.db)[0]!.id), /unknown/);
  r.cleanup();
});

test('查询一直出错：任务保持已提交，汇总里列出放弃查询的任务和原因', async () => {
  const r = rig({ queryMode: 'throw' });
  const summary = await runGeneration(r.project, r.gate, r.opts);
  // 放下查询的任务仍算在途（供应商那边可能还在跑）：占着并发数，其余的这次不提交
  assert.equal(summary.counts['submitted'], 4);
  assert.equal(summary.pollGaveUp.length, 4);
  assert.equal(summary.counts['planned'], 30);
  assert.ok(summary.problems.some((p) => /看不懂/.test(p.error)));
  r.cleanup();
});

test('结果未知之后，这家供应商不再提交（时间窗里只留一个未记录的任务，对账才对得准）', async () => {
  const r = rig({ failSubmit: new Map([[1, 'unknown']]) });
  const summary = await runGeneration(r.project, r.gate, r.opts);
  assert.equal(r.img.submits.length, 1);
  assert.equal(summary.counts['planned'], 33);
  assert.ok(summary.problems.some((p) => /结果未知/.test(p.error)));
  r.cleanup();
});

test('预算：没有单价的任务在设了上限时不提交；未知、实际费用为空的按预估计入已花', async () => {
  const r = rig();
  const [a, b, c] = listTasks(r.project.db);
  r.project.db.prepare('UPDATE generation_task SET cost_estimate = NULL WHERE id = ?').run(a!.id);
  r.project.db.prepare(`UPDATE generation_task SET status = 'unknown' WHERE id = ?`).run(b!.id);
  r.project.db.prepare(`UPDATE generation_task SET status = 'collected', cost_actual = NULL WHERE id = ?`).run(c!.id);
  const summary = await runGeneration(r.project, r.gate, r.opts);
  assert.equal(getTask(r.project.db, a!.id)!.status, 'planned');
  assert.ok(summary.blocked.some((x) => x.taskId === a!.id && /单价/.test(x.reason)));
  const est = b!.costEstimate! + c!.costEstimate!;
  const collected = listTasks(r.project.db, { status: ['collected'] }).filter((t) => t.id !== c!.id).reduce((s, t) => s + (t.costActual ?? 0), 0);
  assert.ok(Math.abs(summary.spent - (est + collected)) < 1e-9, '未知与实际为空的都按预估算');
  r.cleanup();
});

test('重新生成：同一个节点 + 标签已有没结束的任务就拒绝（免得两条一起提交）', async () => {
  const r = rig({ queryMode: 'unknown' });
  r.project.db.prepare(`UPDATE generation_task SET status = 'failed'`).run();
  const t = listTasks(r.project.db)[0]!;
  regenerateTask(r.project.db, t.id);
  assert.throws(() => regenerateTask(r.project.db, t.id), /已经有一条/);
  r.cleanup();
});

test('对账时任务列表没取完：不判「没到达」，任务保持提交中、汇总说明', async () => {
  const r = rig({ listThrows: true });
  const t = listTasks(r.project.db)[0]!;
  markSubmitting(r.project.db, t.id, 999_999_999);
  const report = await recoverTasks(r.project, { modelFor: r.opts.modelFor });
  assert.equal(getTask(r.project.db, t.id)!.status, 'submitting');
  assert.ok(report.errors.some((e) => e.taskId === t.id && /没取完/.test(e.error)));
  r.cleanup();
});

test('地址只认官方域名：百炼国内 / 国际 / 工作空间、MiniMax 国际 / 国内；别的一律拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avp-ep-'));
  const set = (x: object) => writeFileSync(join(dir, 'endpoints.json'), JSON.stringify(x));
  for (const ok of ['https://dashscope.aliyuncs.com', 'https://ws-1.cn-beijing.maas.aliyuncs.com']) {
    set({ dashscope: ok });
    assert.equal(mediaEndpoint('dashscope', { dir, env: {} }), ok);
  }
  set({ minimax: 'https://api.minimax.cn' });
  assert.equal(mediaEndpoint('minimax', { dir, env: {} }), 'https://api.minimax.cn');
  for (const bad of ['https://evil.example', 'https://aliyuncs.com.evil.example', 'https://localhost']) {
    set({ dashscope: bad });
    assert.throws(() => mediaEndpoint('dashscope', { dir, env: {} }), /官方域名/);
  }
});

test('另一个活着的进程有「提交中」的任务：generate 拒绝启动', async () => {
  const r = rig();
  markSubmitting(r.project.db, listTasks(r.project.db)[0]!.id, process.ppid);
  await assert.rejects(generateCommand('generate', [r.dir], {}, { modelFor: r.opts.modelFor, prices: PRICES, download: fakeDownload().download, sleep: async () => {}, pollMs: 0 }), /另一个进程/);
  r.cleanup();
});

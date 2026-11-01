// 付费生成的管理操作与命令行：重新查询（不花钱）与重新生成（新建任务、指向旧任务）分开；
// generate 先对账再执行；tasks resume 只查询不提交。供应商用假的，从命令函数注入。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCommand, type GenerateDeps } from '../src/cli-generate.ts';
import type { ImageRequest, VideoRequest } from '../src/model/media-model.ts';
import { regenerateTask, requeryTask } from '../src/generate/manage.ts';
import { planGeneration } from '../src/generate/planner.ts';
import { runGeneration } from '../src/generate/runner.ts';
import { getTask, listTasks, markSubmitting, transition } from '../src/repo/tasks.ts';
import { DUKO } from './helpers.ts';
import { FakeMediaModel, fakeDownload } from './support/fake-media.ts';
import { confirmGate, genProject, PRICES } from './support/gen-fixture.ts';

function rig(failUrls?: Set<string>) {
  const t = genProject();
  const img = new FakeMediaModel<ImageRequest>('dashscope', 'qwen-image-3.0', 'image');
  const vid = new FakeMediaModel<VideoRequest>('minimax', 'MiniMax-H3-Lite', 'video');
  const deps: GenerateDeps = { modelFor: (p) => (p === 'dashscope' ? img : vid), download: fakeDownload(failUrls).download, prices: PRICES, sleep: async () => {}, pollMs: 0 };
  return { ...t, img, vid, deps };
}

test('重新生成：新建一条任务（attempt_of 指向旧的、同一确认单），旧的不动；在途、未知、计划中的不能重新生成', async () => {
  const r = rig();
  const gate = confirmGate(r.project, { 'image:keyframe': [DUKO.ep1] });
  planGeneration(r.project.db, gate, PRICES);
  await runGeneration(r.project, gate, { ...r.deps, pid: process.pid });
  const old = listTasks(r.project.db, { paidGateId: gate.id })[0]!;
  const again = regenerateTask(r.project.db, old.id);
  assert.equal(again.status, 'planned');
  assert.equal(again.attemptOf, old.id);
  assert.equal(again.paidGateId, gate.id);
  assert.deepEqual(again.plannedInput, old.plannedInput);
  assert.equal(getTask(r.project.db, old.id)!.status, 'collected');
  assert.throws(() => regenerateTask(r.project.db, again.id), /planned/);
  await runGeneration(r.project, gate, { ...r.deps, pid: process.pid });
  assert.equal(r.img.submits.length, 35, '只多提交了重新生成的那一条');
  r.cleanup();
});

test('重新查询：未知的任务人指定供应商 id → 补记并查询下载；下载失败的再查一次就入库；都不提交', async () => {
  const bad = new Set(['https://fake/dashscope-1.png']);
  const r = rig(bad);
  const gate = confirmGate(r.project, { 'image:keyframe': [DUKO.ep1] });
  planGeneration(r.project.db, gate, PRICES);
  const summary = await runGeneration(r.project, gate, { ...r.deps, pid: process.pid });
  const stuck = summary.downloadFailed[0]!;
  bad.clear();
  assert.equal((await requeryTask(r.project, stuck, r.deps)).status, 'collected');

  const extra = await r.img.submit({ prompt: '人去控制台核对过的', size: '1*1', refs: [] });
  const t = listTasks(r.project.db, { paidGateId: gate.id })[1]!;
  regenerateTask(r.project.db, t.id);
  const lost = listTasks(r.project.db, { paidGateId: gate.id, status: ['planned'] })[0]!;
  markSubmitting(r.project.db, lost.id, 999_999_999);
  transition(r.project.db, lost.id, 'unknown', { error: '对出多个' });
  const fixed = await requeryTask(r.project, lost.id, { ...r.deps, providerTaskId: extra.providerTaskId });
  assert.equal(fixed.status, 'collected');
  assert.equal(r.img.submits.length, 35, '重新查询不提交');
  r.cleanup();
});

test('命令行：generate 计划 + 执行并输出汇总；tasks 列表；tasks resume 先对账再只查询', async () => {
  const r = rig();
  const gate = confirmGate(r.project, { 'image:keyframe': [DUKO.ep1] });
  const gen = await generateCommand('generate', [r.dir], { gate: String(gate.id) }, r.deps);
  assert.ok(gen);
  assert.equal(gen.exitCode, 0);
  assert.equal((gen.output as { counts: Record<string, number> }).counts['collected'], 34);
  const list = await generateCommand('tasks', [r.dir], { status: 'collected' }, r.deps);
  assert.equal((list!.output as unknown[]).length, 34);
  const resume = await generateCommand('tasks', ['resume', r.dir], {}, r.deps);
  assert.deepEqual((resume!.output as { recovered: { matched: number[] } }).recovered.matched, []);
  assert.equal(r.img.submits.length, 34);
  assert.equal(await generateCommand('other', [], {}, r.deps), null);
  r.cleanup();
});

test('命令行：没有已确认的确认单就报错说明', async () => {
  const r = rig();
  await assert.rejects(generateCommand('generate', [r.dir], {}, r.deps), /没有已确认的付费确认单/);
  r.cleanup();
});

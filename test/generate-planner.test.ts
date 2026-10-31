// 付费生成的计划：从已确认的确认单展开成任务，数量口径与估算一致（每角色 5 视图、每切 1 帧、每段 1 段视频），只建勾了的、只补没建的。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planGeneration } from '../src/generate/planner.ts';
import { createPaidGate } from '../src/repo/paid-gates.ts';
import { listTasks } from '../src/repo/tasks.ts';
import { DUKO } from './helpers.ts';
import { confirmGate, genProject, PRICES } from './support/gen-fixture.ts';
import { testEstimate } from './support/server-harness.ts';

const SELECT_ALL = { 'image:character-refs': true as const, 'image:keyframe': [DUKO.ep1], 'video:segment': [DUKO.ep1] };

test('全勾第 1 集：4 个出图角色 × 5 视图、34 帧关键帧、10 段视频；模型取确认单里的估算', () => {
  const { project, cleanup } = genProject();
  const gate = confirmGate(project, SELECT_ALL);
  const tasks = planGeneration(project.db, gate, PRICES);
  const count = (node: string) => tasks.filter((t) => t.node === node).length;
  assert.equal(count('image:character-refs'), 20, '更夫是功能角色，不出图');
  assert.equal(count('image:keyframe'), 34);
  assert.equal(count('video:segment'), 10);
  assert.ok(tasks.every((t) => t.status === 'planned' && t.paidGateId === gate.id && t.currency === 'CNY'));
  const kf = tasks.find((t) => t.node === 'image:keyframe')!;
  assert.equal(kf.provider, 'dashscope');
  assert.equal(kf.model, 'qwen-image-3.0');
  assert.equal(tasks.find((t) => t.node === 'video:segment')!.model, 'MiniMax-H3-Lite');
  cleanup();
});

test('计划输入：锚点不挂参考、其余视图依赖锚点；关键帧挂出场角色的锚点并说明想挂但没有的场景；视频挂各切关键帧、时长 = max(4, Σ切秒)', () => {
  const { project, cleanup } = genProject();
  const tasks = planGeneration(project.db, confirmGate(project, SELECT_ALL), PRICES);
  const input = (label: string) => tasks.find((t) => t.label === label)!.plannedInput as Record<string, unknown>;
  assert.deepEqual(input('C01:front-full')['deps'], []);
  assert.deepEqual(input('C01:side-full')['deps'], ['image:character-refs|C01:front-full']);
  assert.equal(input('C01:side-full')['size'], '832*1248');

  const firstCut = tasks.find((t) => t.node === 'image:keyframe')!;
  const kf = firstCut.plannedInput as Record<string, unknown>;
  assert.deepEqual(kf['deps'], ['image:character-refs|C01:front-full']);
  assert.equal(kf['size'], '1280*720', '分镜画幅 16:9');
  assert.match(String(kf['prompt']), /^参考图 1 是「沈知微」/);
  assert.ok((kf['unavailable'] as string[]).some((x) => x.startsWith('场景')), '场景图本阶段没有来源，记下来');

  const seg = tasks.find((t) => t.label === DUKO.seg1)!.plannedInput as Record<string, unknown>;
  assert.equal(seg['duration'], 15, '3+3+4+5 = 15 秒');
  assert.equal((seg['deps'] as string[]).length, 4);
  assert.ok((seg['deps'] as string[]).every((d) => d.startsWith('image:keyframe|ct_')));
  assert.equal(seg['ratio'], '16:9');
  assert.equal(seg['resolution'], '480P');
  cleanup();
});

test('预估费用（人民币）：图片按张 + 参考图，视频按秒；汇率取确认单估算里的', () => {
  const { project, cleanup } = genProject();
  const tasks = planGeneration(project.db, confirmGate(project, SELECT_ALL), PRICES);
  const cost = (label: string) => tasks.find((t) => t.label === label)!.costEstimate!;
  assert.ok(Math.abs(cost('C01:front-full') - 0.03 * 7) < 1e-9);
  assert.ok(Math.abs(cost('C01:side-full') - (0.03 + 0.003) * 7) < 1e-9);
  assert.ok(Math.abs(cost(DUKO.seg1) - 15 * 0.025 * 7) < 1e-9);
  cleanup();
});

test('幂等：同一张确认单再计划一次不新增；只勾的集才建；没确认的确认单拒绝', () => {
  const { project, cleanup } = genProject();
  const gate = confirmGate(project, { 'image:keyframe': [DUKO.ep1] });
  assert.equal(planGeneration(project.db, gate, PRICES).length, 34);
  assert.equal(planGeneration(project.db, gate, PRICES).length, 34);
  assert.equal(listTasks(project.db).length, 34);
  const pending = createPaidGate(project.db, { orchestrationId: null, estimate: testEstimate(project.db) });
  assert.throws(() => planGeneration(project.db, pending, PRICES), /还没确认/);
  cleanup();
});

test('只勾关键帧不勾参考图、以前也没出过锚点：关键帧不挂参考，记下缺的角色；只勾视频又没有关键帧：报错说明', () => {
  const { project, cleanup } = genProject();
  const tasks = planGeneration(project.db, confirmGate(project, { 'image:keyframe': [DUKO.ep1] }), PRICES);
  const kf = tasks[0]!.plannedInput as Record<string, unknown>;
  assert.deepEqual(kf['deps'], []);
  assert.ok((kf['unavailable'] as string[]).some((x) => x.includes('沈知微')));
  assert.throws(() => planGeneration(project.db, confirmGate(project, { 'video:segment': [DUKO.ep1] }), PRICES), /关键帧/);
  cleanup();
});

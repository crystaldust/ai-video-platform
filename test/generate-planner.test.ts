// 付费生成的计划：从已确认的确认单展开成任务，数量口径与估算一致（每角色 5 视图、每切 1 帧、每段 1 段视频），只建勾了的、只补没建的。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planGeneration } from '../src/generate/planner.ts';
import { createPaidGate } from '../src/repo/paid-gates.ts';
import { listTasks } from '../src/repo/tasks.ts';
import { importArtifact } from '../src/import/import-artifact.ts';
import { DUKO, loadFixture } from './helpers.ts';
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
  assert.deepEqual(input('C01:face-front')['deps'], ['image:character-refs|C01:front-full']);
  assert.equal(input('C01:side-full')['size'], '1344*2016', '默认 2k 档（2:3）');
  assert.equal(input('C01:face-front')['size'], '1440*1792', '大头照 4:5');
  // 角色视图的提示词、反向词逐字取角色卡里 character-refs 生成的那份
  const refs = loadFixture('cast').characters[0].characterRefs.views;
  for (const view of ['front-full', 'face-front', 'side-full', 'back-full', 'face-45']) {
    assert.equal(input(`C01:${view}`)['prompt'], refs[view].prompt, view);
    assert.equal(input(`C01:${view}`)['negativePrompt'], refs[view].negative, view);
  }

  const firstCut = tasks.find((t) => t.node === 'image:keyframe')!;
  const kf = firstCut.plannedInput as Record<string, unknown>;
  assert.deepEqual(kf['deps'], ['image:character-refs|C01:front-full']);
  assert.equal(kf['size'], '2048*1152', '分镜画幅 16:9，默认 2k 档');
  assert.match(String(kf['prompt']), /^参考图 1 是「沈知微」/);
  assert.match(String(kf['prompt']), /A real photograph, a still from a live-action period drama/);
  assert.match(String(kf['negativePrompt']), /^CGI, 3D render/);
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

test('角色卡没有 characterRefs（旧项目、没重跑角色阶段）：计划报错，说明先重跑角色阶段；缺某个视图也报错', () => {
  const { project, cleanup } = genProject();
  const cast = loadFixture('cast');
  const without = { ...cast, characters: cast.characters.map((c: Record<string, unknown>, i: number) => (i === 0 ? { ...c, characterRefs: undefined } : c)) };
  importArtifact(project, 'cast', without);
  assert.throws(() => planGeneration(project.db, confirmGate(project, { 'image:character-refs': true }), PRICES), /角色卡「沈知微」（C01）没有出图提示词：先重跑角色阶段/);
  const { 'face-45': _gone, ...views } = cast.characters[0].characterRefs.views;
  const partial = { ...cast, characters: cast.characters.map((c: Record<string, any>, i: number) => (i === 0 ? { ...c, characterRefs: { ...c.characterRefs, views } } : c)) };
  importArtifact(project, 'cast', partial);
  assert.throws(() => planGeneration(project.db, confirmGate(project, { 'image:character-refs': true }), PRICES), /缺视图 face-45/);
  cleanup();
});

test('确认单的估算显式选了 1k：用 1k 档尺寸', () => {
  const { project, cleanup } = genProject();
  const gate = confirmGate(project, { 'image:character-refs': true });
  const oneK = { ...gate, estimate: { ...gate.estimate, nodes: gate.estimate.nodes.map((n) => (n.node === 'image:character-refs' ? { ...n, params: { ...n.params, size: '1k' } } : n)) } };
  const t = planGeneration(project.db, oneK, PRICES).find((x) => x.label === 'C01:front-full')!;
  assert.equal((t.plannedInput as Record<string, unknown>)['size'], '832*1248');
  cleanup();
});

// 跨确认单去重：同样的计划输入以前已经入库就不再建任务、不再付钱；改了提示词就是新指纹，照常出。
// 派生视图照常建，跑的时候引用以前确认单的锚点。预览（只算、不写库）的跳过数与金额和真计划一致。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ImageRequest } from '../src/model/media-model.ts';
import { planGate, previewGeneration } from '../src/generate/planner.ts';
import { runGeneration, type GenerateOptions } from '../src/generate/runner.ts';
import { regenerateTask } from '../src/generate/manage.ts';
import { listTasks } from '../src/repo/tasks.ts';
import type { Project } from '../src/project.ts';
import { importArtifact } from '../src/import/import-artifact.ts';
import { loadFixture } from './helpers.ts';
import { FakeMediaModel, fakeDownload } from './support/fake-media.ts';
import { confirmGate, genProject, PRICES } from './support/gen-fixture.ts';

const REFS = { 'image:character-refs': true as const };

function models() {
  const img = new FakeMediaModel<ImageRequest>('dashscope', 'qwen-image-3.0', 'image');
  const opts: GenerateOptions = { modelFor: () => img, download: fakeDownload().download, prices: PRICES, sleep: async () => {}, pollMs: 0, pid: process.pid };
  return { img, opts };
}

/** 确认单 A 只出 C01 的锚点（其余留 planned），模拟冒烟里到预算就停的情况。 */
async function anchorOnly(project: Project, m = models()) {
  const a = confirmGate(project, REFS);
  planGate(project.db, a, PRICES);
  for (const t of listTasks(project.db, { paidGateId: a.id }).filter((x) => x.label !== 'C01:front-full')) project.db.prepare("UPDATE generation_task SET status = 'cancelled' WHERE id = ?").run(t.id);
  await runGeneration(project, a, m.opts);
  return { a, anchor: listTasks(project.db, { paidGateId: a.id }).find((t) => t.label === 'C01:front-full')! };
}

test('新确认单跳过已出过的锚点：不建任务、记下沿用哪条；派生视图照常建，跑完引用的是旧单的锚点', async () => {
  const { project, cleanup } = genProject();
  const m = models();
  const { anchor } = await anchorOnly(project, m);
  const before = m.img.submits.length;
  const b = confirmGate(project, REFS);
  const plan = planGate(project.db, b, PRICES);
  assert.deepEqual(plan.skipped.map((s) => [s.label, s.reuse]), [['C01:front-full', anchor.id]]);
  assert.ok(plan.skipped[0]!.costCny! > 0);
  assert.equal(plan.tasks.length, 19);
  assert.ok(!plan.tasks.some((t) => t.label === 'C01:front-full'));
  const summary = await runGeneration(project, b, m.opts);
  assert.equal(summary.counts['collected'], 19);
  assert.equal(m.img.submits.length - before, 19, '锚点没再提交');
  const side = m.img.submits.slice(before).find((s) => s.prompt === loadFixture('cast').characters[0].characterRefs.views['side-full'].prompt)!;
  assert.equal(side.refs.length, 1, '派生视图挂上了旧单的锚点');
  cleanup();
});

test('同一张确认单再计划：跳过清单稳定，不重复建', async () => {
  const { project, cleanup } = genProject();
  await anchorOnly(project);
  const b = confirmGate(project, REFS);
  const first = planGate(project.db, b, PRICES);
  const second = planGate(project.db, b, PRICES);
  assert.equal(second.tasks.length, first.tasks.length);
  assert.deepEqual(second.skipped, first.skipped);
  cleanup();
});

test('改了 characterRefs 的提示词：新指纹，照常重建', async () => {
  const { project, cleanup } = genProject();
  await anchorOnly(project);
  const cast = loadFixture('cast');
  const changed = { ...cast, characters: cast.characters.map((c: Record<string, any>, i: number) => (i === 0 ? { ...c, characterRefs: { ...c.characterRefs, views: { ...c.characterRefs.views, 'front-full': { ...c.characterRefs.views['front-full'], prompt: `${c.characterRefs.views['front-full'].prompt} Changed.` } } } } : c)) };
  importArtifact(project, 'cast', changed);
  const plan = planGate(project.db, confirmGate(project, REFS), PRICES);
  assert.equal(plan.skipped.length, 0);
  assert.ok(plan.tasks.some((t) => t.label === 'C01:front-full'));
  cleanup();
});

test('预览：不写库，跳过数和金额与真计划一致；没确认的确认单也能算', async () => {
  const { project, cleanup } = genProject();
  await anchorOnly(project);
  const b = confirmGate(project, REFS);
  const before = listTasks(project.db).length;
  const preview = previewGeneration(project.db, { id: b.id, estimate: b.estimate, selection: REFS }, PRICES);
  assert.equal(listTasks(project.db).length, before, '预览不建任务');
  const plan = planGate(project.db, b, PRICES);
  assert.equal(preview.create, plan.tasks.length);
  assert.deepEqual(preview.skipped, plan.skipped);
  cleanup();
});

test('重新生成不经过去重：同样的输入照样新建一条', async () => {
  const { project, cleanup } = genProject();
  const { anchor } = await anchorOnly(project);
  const again = regenerateTask(project.db, anchor.id);
  assert.equal(again.attemptOf, anchor.id);
  assert.equal(again.contentFingerprint, listTasks(project.db).find((t) => t.id === anchor.id)!.contentFingerprint);
  cleanup();
});

test('别的确认单里还在途的也算付过钱：新确认单跳过；派生视图等它出来，不判死；两张都跑完每条只提交一次', async () => {
  const { project, cleanup } = genProject();
  const img = new FakeMediaModel<ImageRequest>('dashscope', 'qwen-image-3.0', 'image', { pollsToFinish: 99 });
  const opts: GenerateOptions = { modelFor: () => img, download: fakeDownload().download, prices: PRICES, sleep: async () => {}, pollMs: 0, pid: process.pid };
  const a = confirmGate(project, REFS);
  planGate(project.db, a, PRICES);
  // 只提交锚点就停：派生视图在等锚点，锚点在供应商那边一直在跑
  const stop = new AbortController();
  await runGeneration(project, a, { ...opts, onProgress: (e) => e.status === 'submitted' && stop.abort(), signal: stop.signal });
  const inFlight = listTasks(project.db, { paidGateId: a.id }).filter((t) => t.status === 'submitted');
  assert.ok(inFlight.length > 0);
  const b = confirmGate(project, REFS);
  const plan = planGate(project.db, b, PRICES);
  for (const t of inFlight) {
    const s = plan.skipped.find((x) => x.label === t.label)!;
    assert.equal(s.reuse, t.id);
    assert.equal(s.reuseStatus, 'submitted');
  }
  const before = img.submits.length;
  const sb = await runGeneration(project, b, { ...opts, submit: true });
  assert.equal(sb.blocked.length, 0, '在等，不判死');
  // 锚点没出来：B 里依赖它的视图一条也没提交
  const waiting = listTasks(project.db, { paidGateId: b.id }).filter((t) => t.status === 'planned');
  assert.ok(waiting.length > 0);
  assert.ok(img.submits.slice(before).every((r) => r.refs.length === 0), 'B 只提交了不挂参考的');
  cleanup();
});

test('换了模型不沿用：同样的输入，模型不同照常建', async () => {
  const { project, cleanup } = genProject();
  await anchorOnly(project);
  const b = confirmGate(project, REFS);
  project.db.prepare("UPDATE generation_task SET model = 'qwen-image-other' WHERE label = 'C01:front-full'").run();
  const plan = planGate(project.db, b, PRICES);
  assert.equal(plan.skipped.length, 0);
  assert.ok(plan.tasks.some((t) => t.label === 'C01:front-full'));
  cleanup();
});

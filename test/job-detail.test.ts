// 后台任务的说明给人看：阶段用中文名、集用集号；页面上因为有任务在跑而置灰的按钮，用它说明原因。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProject } from '../src/project.ts';
import { latestArtifactDoc } from '../src/repo/artifacts.ts';
import { busyReason } from '../web/src/generation.ts';
import { importAll } from './helpers.ts';
import { setupNovel } from './support/novel-pack.ts';
import { startHarness, type Harness } from './support/server-harness.ts';

const ID = '渡口';
const p = (path: string) => encodeURI(`/api/p/${ID}${path}`);

async function setup(h: Harness): Promise<void> {
  const project = createProject(join(h.app.config.projectsRoot, ID), ID);
  await setupNovel(project);
  importAll(project);
  project.close();
}

test('打回的任务说明：阶段中文名 + 集号；不选集写「全部集」', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await setup(h);
  const one = await h.call('POST', p('/reject'), { body: { stage: 'script', episode: '2', note: '汽笛提前' } });
  assert.equal(one.status, 200, one.text);
  assert.equal(one.body.data.detail, '打回剧本（第 02 集）');
  await h.app.jobs.settled(ID);
  const all = await h.call('POST', p('/reject'), { body: { stage: 'outline', note: '节奏再紧一点' } });
  assert.equal(all.body.data.detail, '打回大纲（全部集）');
  await h.app.jobs.settled(ID);
});

test('单阶段重跑的任务说明：「重跑角色阶段」，整份重写加注', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await setup(h);
  const r = await h.call('POST', p('/go'), { body: { only: 'cast' } });
  assert.equal(r.body.data.detail, '重跑角色阶段');
  await h.app.jobs.settled(ID);
  const f = await h.call('POST', p('/go'), { body: { only: 'cast', fresh: true } });
  assert.equal(f.body.data.detail, '重跑角色阶段（整份重写）');
  await h.app.jobs.settled(ID);
});

test('置灰原因：有任务时说正在跑什么、等它跑完；没任务为 null', () => {
  assert.equal(busyReason({ kind: 'reject', detail: '打回分镜（第 02 集）' }), '「打回分镜（第 02 集）」正在跑，等它跑完再操作');
  assert.equal(busyReason({ kind: 'generate', detail: '付费生成 #2' }), '「付费生成 #2」正在跑，等它跑完再操作（生成任务页可以停止）');
  assert.equal(busyReason(null), null);
});

test('补出图提示词：POST /refs 开后台任务「补出图提示词」，跑完角色卡带 characterRefs，待处理不增加；没有角色卡时 400', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await setup(h);
  const before = (await h.call('GET', p('/overview'))).body.data.pending.length;
  const r = await h.call('POST', p('/refs'));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.detail, '补出图提示词');
  await h.app.jobs.settled(ID);
  const o = (await h.call('GET', p('/overview'))).body.data;
  assert.equal(o.pending.length, before, '外形没变：不新增需复核');
  const cast = await h.app.withProject(ID, (pr) => {
    return latestArtifactDoc(pr.db, 'cast')!.doc as { characters: { characterRefs?: unknown }[] };
  });
  assert.ok(cast.characters.some((c) => c.characterRefs));

  const h2 = await startHarness();
  t.after(() => h2.close());
  createProject(join(h2.app.config.projectsRoot, ID), ID).close();
  assert.equal((await h2.call('POST', p('/refs'))).status, 400);
});

test('一次打回多集：POST /reject 带 episodes，任务说明列出集号，结束时带逐集结果；和 episode 同时给 400', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await setup(h);
  const bad = await h.call('POST', p('/reject'), { body: { stage: 'script', episode: '1', episodes: ['2'], note: 'x' } });
  assert.equal(bad.status, 400);
  assert.equal((await h.call('POST', p('/reject'), { body: { stage: 'outline', episodes: ['1'], note: 'x' } })).status, 400);
  const { collectEvents } = await import('./support/server-harness.ts');
  const events = collectEvents(h, p('/events'), (e) => e.type === 'job-end');
  for (let i = 0; i < 200 && h.app.bus.subscribers(ID) === 0; i++) await new Promise((r) => setTimeout(r, 5));
  const r = await h.call('POST', p('/reject'), { body: { stage: 'script', episodes: ['3', '1'], note: '汽笛提前' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.detail, '打回剧本（第 01、03 集）');
  await h.app.jobs.settled(ID);
  const end = (await events).find((e) => e.type === 'job-end')!;
  const result = end['result'] as { episodes: { ep: number; status: string }[] };
  assert.deepEqual(result.episodes.map((e) => [e.ep, e.status]), [[1, 'passed'], [3, 'passed']]);
});

test('任务结束事件带任务说明；单集打回的结果带没过的原因（通过时为 null），单阶段重跑的结果带没过的阶段', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await setup(h);
  const { collectEvents } = await import('./support/server-harness.ts');
  const ends = async (call: () => Promise<unknown>) => {
    const events = collectEvents(h, p('/events'), (e) => e.type === 'job-end');
    for (let i = 0; i < 200 && h.app.bus.subscribers(ID) === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await call();
    await h.app.jobs.settled(ID);
    return (await events).find((e) => e.type === 'job-end')!;
  };
  const one = await ends(() => h.call('POST', p('/reject'), { body: { stage: 'script', episode: '2', note: '汽笛提前' } }));
  assert.equal(one['detail'], '打回剧本（第 02 集）');
  const r = one['result'] as { status: string; message: unknown };
  assert.equal(r.status, 'passed');
  assert.ok('message' in r);
  assert.equal(r.message, null);
  const go = await ends(() => h.call('POST', p('/go'), { body: { only: 'cast' } }));
  assert.equal(go['detail'], '重跑角色阶段');
  assert.deepEqual((go['result'] as { stages: unknown[] }).stages, []);
});

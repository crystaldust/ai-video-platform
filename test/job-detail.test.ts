// 后台任务的说明给人看：阶段用中文名、集用集号；页面上因为有任务在跑而置灰的按钮，用它说明原因。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProject } from '../src/project.ts';
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

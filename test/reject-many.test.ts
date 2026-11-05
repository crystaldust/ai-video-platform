// 一次打回多集（backlog #36）：同一条意见，在一个后台任务里一集一集地跑；每集一条打回记录、一次运行；
// 某集失败（比如余额不足）记下原因、接着跑下一集；集去重、按集号排；整份负责的阶段、空列表报错。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProgressEvent } from '../src/executor/run-node.ts';
import { checkRejectMany, rejectMany } from '../src/orchestrate/revisions.ts';
import { importAll, tempProject } from './helpers.ts';
import { dukoModel } from './support/duko-model.ts';
import { setupNovel } from './support/novel-pack.ts';

const NOTE = '汽笛提前到陆行远掏砚之前';

test('剧本第 3、1、2 集一起打回：按集号依次跑，各一条打回记录、一次运行，都通过', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project);
  const r = await rejectMany(project, 'script', { model: dukoModel(), episodes: ['3', '1', '2', '1'], note: NOTE, prices: null });
  assert.deepEqual(r.episodes.map((e) => [e.ep, e.status]), [[1, 'passed'], [2, 'passed'], [3, 'passed']]);
  assert.equal(new Set(r.episodes.map((e) => e.runId)).size, 3);
  const reqs = project.db.prepare("SELECT episode_key FROM revision_request WHERE stage = 'script' ORDER BY id").all() as { episode_key: string }[];
  assert.equal(reqs.length, 3);
  cleanup();
});

test('第 2 集失败（模型 402）：记下原因，第 1、3 集照样跑完', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project);
  let runs = 0;
  const duko = dukoModel();
  const model = {
    id: duko.id,
    complete: async (req: Parameters<typeof duko.complete>[0]) => {
      if (runs === 2) throw new Error('deepseek 拒绝了请求（HTTP 402）：Insufficient Balance');
      return duko.complete(req);
    },
  };
  const onProgress = (e: ProgressEvent) => {
    if (e.type === 'run-start') runs += 1;
  };
  const r = await rejectMany(project, 'script', { model, episodes: ['1', '2', '3'], note: NOTE, prices: null, onProgress });
  assert.deepEqual(r.episodes.map((e) => [e.ep, e.status]), [[1, 'passed'], [2, 'failed'], [3, 'passed']]);
  assert.match(r.episodes[1]!.error ?? '', /402/);
  cleanup();
});

test('checkRejectMany：整份负责的阶段、空列表、没写意见、不认识的集都拒绝', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project);
  assert.throws(() => checkRejectMany(project.db, 'outline', { episodes: ['1'], note: NOTE }), /整份负责/);
  assert.throws(() => checkRejectMany(project.db, 'script', { episodes: [], note: NOTE }), /至少选一集/);
  assert.throws(() => checkRejectMany(project.db, 'script', { episodes: ['1'], note: ' ' }), /意见/);
  assert.throws(() => checkRejectMany(project.db, 'script', { episodes: ['99'], note: NOTE }), /99/);
  const ok = checkRejectMany(project.db, 'script', { episodes: ['2', '1', '2'], note: NOTE });
  assert.equal(ok.episodes.length, 2);
  cleanup();
});

test('同样的错连着出两次（比如余额不足）：不再试剩下的集，标为没再试', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project);
  const model = { id: 'scripted:broke', complete: async () => { throw new Error('deepseek 拒绝了请求（HTTP 402）：Insufficient Balance'); } };
  const r = await rejectMany(project, 'script', { model, episodes: ['1', '2', '3', '4'], note: NOTE, prices: null });
  assert.deepEqual(r.episodes.map((e) => e.status), ['failed', 'failed', 'skipped', 'skipped']);
  assert.match(r.episodes[2]!.error ?? '', /没再试/);
  cleanup();
});

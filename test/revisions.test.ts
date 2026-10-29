// 打回与单集重跑：意见与底稿进提示词，只有这一集长新版本；下游受影响的集出现在需复核矩阵里，go --only-stale 清掉它。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { estimateProject } from '../src/estimate/estimate.ts';
import type { TextRequest } from '../src/model/text-model.ts';
import { orchestrate } from '../src/orchestrate/orchestrator.ts';
import { reject, resolveEpisode } from '../src/orchestrate/revisions.ts';
import { pendingCells } from '../src/orchestrate/review-matrix.ts';
import { BUILTIN_PRESET_DIR } from '../src/presets/presets.ts';
import { loadPriceSources } from '../src/pricing/prices.ts';
import { latestArtifactDoc } from '../src/repo/artifacts.ts';
import { listVersions } from '../src/repo/entities.ts';
import { getRun, listAttempts } from '../src/repo/runs.ts';
import { DUKO, importAll, loadFixture, tempProject } from './helpers.ts';
import { dukoModel } from './support/duko-model.ts';
import { setupNovel } from './support/novel-pack.ts';
import { fenced, promptSection } from './support/scripted-model.ts';

const NONE = '/nonexistent-avp';
const estimate = (db: DatabaseSync) => estimateProject(db, { prices: loadPriceSources(NONE), fx: { usdToCny: 7, checkedAt: '2026-10-29', source: 'test' }, presetDirs: { builtin: BUILTIN_PRESET_DIR, user: NONE } });
/** 第 3 集第 1 场 */
const SC31 = 'sc_bmg7t4yn';
const NOTE = '汽笛提前到陆行远掏砚之前';

/** 剧本第 3 集按意见改了第一拍 */
const revisedEp3 = (req: TextRequest) => {
  if (!req.user.includes('补全 scenes')) return undefined;
  const ep3 = loadFixture('script').episodes.find((e: { ep: number }) => e.ep === 3);
  ep3.scenes[0].flow[0] = { ...ep3.scenes[0].flow[0], action: `汽笛先响。${ep3.scenes[0].flow[0].action}` };
  return fenced({ episodes: [ep3] });
};

test('集号、集 id 都能认；不在当前大纲里的报错', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline']);
  assert.equal(resolveEpisode(project.db, '3'), DUKO.ep3);
  assert.equal(resolveEpisode(project.db, DUKO.ep3), DUKO.ep3);
  assert.throws(() => resolveEpisode(project.db, '9'), /当前大纲里没有第 9 集/);
  assert.throws(() => resolveEpisode(project.db, 'ep_zzzzzzzz'), /没有第 ep_zzzzzzzz 集/);
  cleanup();
});

test('打回剧本第 3 集：意见与底稿进提示词，只有第 3 集长新版本；站位第 3 集需复核；only-stale 后清空', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project);
  const ep1Scene = listVersions(project.db, 'script_scene', DUKO.sc11, 'script').length;
  const model = dukoModel(revisedEp3);
  const r = await reject(project, 'script', { model, episode: '3', note: NOTE, prices: null });

  assert.equal(r.outcome.status, 'passed', `${r.outcome.message}\n${r.outcome.violations?.join('\n')}`);
  assert.deepEqual(listAttempts(project.db, r.outcome.runId).map((a) => a.step), ['episodes:3-3']);
  const user = model.requests[0]!.user;
  assert.match(promptSection(user, '作者意见') ?? '', new RegExp(NOTE));
  assert.match(promptSection(user, '底稿') ?? '', new RegExp(DUKO.ep3));
  assert.equal(listVersions(project.db, 'script_scene', DUKO.sc11, 'script').length, ep1Scene, '第 1 集的场次版本不变');
  assert.equal(listVersions(project.db, 'script_scene', SC31, 'script').length, 2, '第 3 集改了的那场长出新版本');
  const run = getRun(project.db, r.outcome.runId)!;
  assert.equal(run.revisionRequestId, r.request.id);
  assert.equal(run.episodeKey, DUKO.ep3);
  const doc = latestArtifactDoc(project.db, 'script')?.doc as { episodes: unknown[] };
  assert.equal(doc.episodes.length, 6, '产物版本存整份');
  assert.deepEqual(r.pending.map((c) => `${c.stage}/${c.episode}`), [`staging/${DUKO.ep3}`]);

  const stale = await orchestrate(project, { modelFor: () => dukoModel(), mode: 'only-stale', estimate, run: { prices: null } });
  assert.equal(stale.status, 'done', JSON.stringify(stale.stages));
  const ran = stale.stages.filter((s) => s.status !== 'skipped');
  assert.deepEqual(ran.map((s) => [s.stage, s.episodes]), [['staging', [DUKO.ep3]]]);
  assert.deepEqual(pendingCells(project.db), [], '只重跑受影响的部分后矩阵清空');
  cleanup();
});

test('整份负责的阶段带 --ep 拒绝；没写意见、还没产物都拒绝', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline']);
  await assert.rejects(reject(project, 'art', { model: dukoModel(), note: 'x' }), /art 还没有产物/);
  await assert.rejects(reject(project, 'outline', { model: dukoModel(), episode: '3', note: 'x' }), /outline 是整份负责的/);
  await assert.rejects(reject(project, 'outline', { model: dukoModel(), note: '  ' }), /打回要写意见/);
  cleanup();
});

test('整阶段打回美术：意见进场景、道具两遍，底稿是当前的场景与道具', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline', 'cast', 'art']);
  const model = dukoModel();
  const r = await reject(project, 'art', { model, note: '渡船船舱再暗一些', prices: null });
  assert.equal(r.outcome.status, 'passed', r.outcome.message);
  for (const req of model.requests) {
    assert.match(promptSection(req.user, '作者意见') ?? '', /渡船船舱再暗一些/);
    assert.ok(promptSection(req.user, '底稿'), '每一遍都有底稿');
  }
  cleanup();
});

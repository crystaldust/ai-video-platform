// 编排器：真实 skill 副本 + 按提示词作答的模型（吐渡口样例），一键跑六个文本阶段。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { estimateProject } from '../src/estimate/estimate.ts';
import type { TextRequest } from '../src/model/text-model.ts';
import { orchestrate, planStage, type OrchestrateEvent, type OrchestrateOptions } from '../src/orchestrate/orchestrator.ts';
import { pendingCells } from '../src/orchestrate/review-matrix.ts';
import { importArtifact } from '../src/import/import-artifact.ts';
import { BUILTIN_PRESET_DIR } from '../src/presets/presets.ts';
import { loadPriceSources } from '../src/pricing/prices.ts';
import type { Project } from '../src/project.ts';
import { getOrchestration } from '../src/repo/orchestrations.ts';
import { listPaidGates } from '../src/repo/paid-gates.ts';
import { listRuns } from '../src/repo/runs.ts';
import { DUKO, importAll, loadFixture, tempProject } from './helpers.ts';
import { dukoModel, storyboardEpisodes } from './support/duko-model.ts';
import { fenced } from './support/scripted-model.ts';
import { novelManifest, setupNovel } from './support/novel-pack.ts';

const NONE = '/nonexistent-avp';
const FX = { usdToCny: 7, checkedAt: '2026-10-29', source: 'test' };
/** 估算只读仓库内置的预设和价格，不碰本机配置目录 */
const estimate = (db: DatabaseSync) => estimateProject(db, { prices: loadPriceSources(NONE), fx: FX, presetDirs: { builtin: BUILTIN_PRESET_DIR, user: NONE } });

function go(project: Project, model: ReturnType<typeof dukoModel>, extra: Partial<OrchestrateOptions> = {}) {
  const events: OrchestrateEvent[] = [];
  const done = orchestrate(project, { modelFor: () => model, estimate, run: { prices: null }, onProgress: (e) => events.push(e), ...extra });
  return { done, events };
}

const statuses = (r: { stages: readonly { stage: string; status: string }[] }) => Object.fromEntries(r.stages.map((s) => [s.stage, s.status]));

test('一键全过：六个阶段按层跑完，角色、美术、剧本并发，停在付费前生成确认单', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  const { done, events } = go(project, dukoModel());
  const result = await done;

  assert.equal(result.status, 'done', JSON.stringify(result.stages, null, 2));
  assert.deepEqual(statuses(result), { outline: 'passed', cast: 'passed', art: 'passed', script: 'passed', staging: 'passed', storyboard: 'passed' });
  assert.deepEqual(events.filter((e) => e.type === 'layer').map((e) => (e as { stages: readonly string[] }).stages), [['outline'], ['cast', 'art', 'script'], ['staging'], ['storyboard']]);
  // 同层并发：三个阶段都开始了，才有第一个结束
  const runEvents = events.flatMap((e) => (e.type === 'run' ? [e.event] : []));
  const firstEnd = runEvents.findIndex((e) => e.type === 'run-end' && e.runId > 1);
  const starts = runEvents.slice(0, firstEnd).filter((e) => e.type === 'run-start').map((e) => (e as { stage: string }).stage);
  assert.deepEqual(starts.slice(1).sort(), ['art', 'cast', 'script']);

  assert.ok(listRuns(project.db).every((r) => r.orchestrationId === result.id), '运行都记在这次编排上');
  const gate = result.paidGate!;
  assert.equal(gate.status, 'awaiting_confirmation');
  const video = gate.estimate.nodes.find((n) => n.node === 'video:segment')!;
  assert.match(video.assumptions.join(' '), /分镜各段秒数之和/, '估算用上了刚出的分镜');
  assert.equal(getOrchestration(project.db, result.id)?.status, 'done');
  cleanup();
});

const always = (match: string, reply: (req: TextRequest) => string) => (req: TextRequest) => (req.user.includes(match) ? reply(req) : undefined);

test('分镜一直违规：转人工、编排 blocked，付费确认单照样生成并标出未完成阶段', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  const head = { source: '渡口', aspectRatio: '16:9' };
  const model = dukoModel((req) => {
    if (req.user.includes('每切写 beatIds')) return fenced({ episodes: storyboardEpisodes(req.user, false) });
    if (req.user.includes('整份 storyboard.json')) return fenced({ ...head, episodes: storyboardEpisodes(req.user, false) });
    return undefined;
  });
  const result = await go(project, model).done;

  assert.equal(result.status, 'blocked');
  assert.equal(statuses(result)['storyboard'], 'needs_human');
  assert.ok(result.paidGate, '文本部分已到头，确认单照样生成');
  assert.deepEqual((getOrchestration(project.db, result.id)?.summary as { unfinished: string[] }).unfinished, ['storyboard']);
  cleanup();
});

test('剧本失败：站位、分镜不跑（上游未通过），角色、美术照常', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  const model = dukoModel(always('补全 scenes', () => {
    throw new Error('供应商 500');
  }));
  const result = await go(project, model).done;

  assert.equal(result.status, 'failed');
  assert.deepEqual(statuses(result), { outline: 'passed', cast: 'passed', art: 'passed', script: 'failed', staging: 'blocked', storyboard: 'blocked' });
  assert.equal(result.stages.find((s) => s.stage === 'staging')?.message, '上游 script 未通过');
  assert.equal(listRuns(project.db).filter((r) => r.stage === 'staging').length, 0, '被阻断的阶段没有运行记录');
  cleanup();
});

test('断点续跑：第一次在站位失败，第二次跳过已通过的四个阶段', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  const first = await go(project, dukoModel(always('给 places 里每个人填', () => {
    throw new Error('网络断了');
  }))).done;
  assert.equal(statuses(first)['staging'], 'failed');

  const second = await go(project, dukoModel()).done;
  assert.equal(second.status, 'done', JSON.stringify(second.stages));
  assert.deepEqual(statuses(second), { outline: 'skipped', cast: 'skipped', art: 'skipped', script: 'skipped', staging: 'passed', storyboard: 'passed' });
  assert.equal(listPaidGates(project.db).filter((g) => g.status === 'awaiting_confirmation').length, 1, '旧确认单作废');
  cleanup();
});

test('同一项目同时两条编排：第二条报「已有编排在运行」；没有输入不能开跑', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  const first = go(project, dukoModel()).done;
  await assert.rejects(go(project, dukoModel()).done, /已有编排在运行/);
  await first;

  const other = tempProject();
  await assert.rejects(orchestrate(other.project, { modelFor: () => dukoModel() }), /还没有项目输入/);
  other.cleanup();
  cleanup();
});

test('站位没挂载：报「还没有挂载」并阻断分镜；--only 只跑一个阶段、不出确认单', async () => {
  const manifest = novelManifest();
  const partial = tempProject();
  await setupNovel(partial.project, { ...manifest, skills: manifest.skills.filter((s) => s.name !== 'novel-staging') });
  const result = await go(partial.project, dukoModel()).done;
  assert.equal(statuses(result)['staging'], 'failed');
  assert.match(result.stages.find((s) => s.stage === 'staging')?.message ?? '', /还没有挂载/);
  assert.equal(statuses(result)['storyboard'], 'blocked');
  partial.cleanup();

  const { project, cleanup } = tempProject();
  await setupNovel(project);
  const only = await go(project, dukoModel(), { only: 'outline' }).done;
  assert.deepEqual(statuses(only), { outline: 'passed' });
  assert.equal(only.paidGate, null);
  assert.equal(getOrchestration(project.db, only.id)?.mode, 'single');
  cleanup();
});

test('上游删掉了一集：指向它的需复核格子不重跑（会一直失败），其余集照常按集重跑', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project);
  // 大纲删掉第 6 集、改了女主：剧本各集场次都引用女主，第 6 集也标需复核
  const outline = loadFixture('outline');
  outline.episodes = outline.episodes.filter((e: { id: string }) => e.id !== DUKO.ep6);
  outline.beats = outline.beats.map((b: { episodeRef?: string }) => (b.episodeRef === DUKO.ep6 ? { ...b, episodeRef: DUKO.ep1 } : b));
  outline.characters[0].arc = `${outline.characters[0].arc}（改）`;
  importArtifact(project, 'outline', outline);
  assert.ok(pendingCells(project.db).some((c) => c.stage === 'script' && c.episode === DUKO.ep6));
  const plan = planStage(project, 'script', { modelFor: () => dukoModel() });
  const action = plan.action as { episodes: string[] };
  assert.ok(action.episodes.length > 0 && !action.episodes.includes(DUKO.ep6), JSON.stringify(plan));
  assert.match(plan.note ?? '', new RegExp(`已没有 ${DUKO.ep6}`));
  cleanup();
});

test('某阶段解析模型就出错：只算这个阶段失败，同层其余阶段照跑完', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  const model = dukoModel();
  const result = await go(project, model, {
    modelFor: (stage) => {
      if (stage === 'art') throw new Error('预设里 text:art 的模型不存在');
      return model;
    },
  }).done;
  assert.deepEqual(statuses(result), { outline: 'passed', cast: 'passed', art: 'failed', script: 'passed', staging: 'blocked', storyboard: 'blocked' });
  assert.match(result.stages.find((s) => s.stage === 'art')?.message ?? '', /模型不存在/);
  cleanup();
});

test('--only 已有产物的阶段：从头重跑，不带底稿和「上游有改动」', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline', 'cast']);
  const model = dukoModel();
  const result = await go(project, model, { only: 'art' }).done;
  assert.deepEqual(statuses(result), { art: 'passed' });
  assert.ok(model.requests.every((r) => !r.user.includes('【底稿') && !r.user.includes('【作者意见')));
  cleanup();
});

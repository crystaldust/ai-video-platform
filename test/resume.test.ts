// 断点续跑：剧本、分镜的运行中途失败（进程中断、供应商报错）后再跑，输入没变就沿用上一次已写好的集，只写剩下的。
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runNode, type ProgressEvent } from '../src/executor/run-node.ts';
import { importArtifact } from '../src/import/import-artifact.ts';
import type { TextModel } from '../src/model/text-model.ts';
import { RUNS_DIR, type Project } from '../src/project.ts';
import { addInput, currentInput } from '../src/repo/inputs.ts';
import { failInterruptedRuns, listAttempts } from '../src/repo/runs.ts';
import { importAll, loadFixture, tempProject } from './helpers.ts';
import { latestArtifactDoc } from '../src/repo/artifacts.ts';
import { dukoModel, storyboardEpisodes } from './support/duko-model.ts';
import { setupNovel } from './support/novel-pack.ts';
import { fenced, promptSection } from './support/scripted-model.ts';
import { contiguousBatches, episodeKey, passedEpisodes, type RepairSplit } from '../src/executor/recipe-kit.ts';

const steps = (project: Project, runId: number) => listAttempts(project.db, runId).map((a) => a.step);

/** 写到这几集就报供应商错误（运行 failed）；其余照渡口样例答。 */
const failingAt = (range: string) =>
  dukoModel((req) => {
    if ((promptSection(req.user, '只写这几集') ?? '').includes(range)) throw new Error('供应商 500');
    return undefined;
  });

/** 剧本、站位只留前 2 集（渡口分镜样例只有第 1 集，第 2 集由模型写成空的也没关系，这里只看从哪一集开始写）。 */
async function twoEpisodes(): Promise<{ project: Project; cleanup: () => void }> {
  const t = tempProject();
  await setupNovel(t.project);
  importAll(t.project, ['outline', 'cast', 'art']);
  const script = loadFixture('script');
  importArtifact(t.project, 'script', { ...script, episodes: script.episodes.filter((e: { ep: number }) => e.ep <= 2) });
  const staging = loadFixture('staging');
  importArtifact(t.project, 'staging', { ...staging, scenes: staging.scenes.filter((x: { ep: number }) => x.ep <= 2) });
  return t;
}

const notices = (events: ProgressEvent[]) => events.flatMap((e) => (e.type === 'notice' ? [e.message] : []));

test('分镜写到第 2 集时供应商报错 → 再跑直接从第 2 集写，沿用第 1 集，并发提示', async () => {
  const { project, cleanup } = await twoEpisodes();
  const first = await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  assert.equal(first.status, 'failed');

  const events: ProgressEvent[] = [];
  const second = await runNode(project, 'storyboard', { model: dukoModel(), onProgress: (e) => events.push(e) });
  assert.equal(steps(project, second.runId)[0], 'episodes:2-2', '第 1 集不再重写');
  assert.ok(notices(events).some((m) => new RegExp(`沿用上一次（run ${first.runId}）中断前已写好的 1 集`).test(m)));
  cleanup();
});

test('进程中断（serve 退出）后再跑也能接上', async () => {
  const { project, cleanup } = await twoEpisodes();
  const first = await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  // 模拟进程被杀：运行停在 running、进程已不在，重开项目时被标为「进程中断」
  project.db.prepare(`UPDATE node_run SET status = 'running', error = NULL, pid = 999999999 WHERE id = ?`).run(first.runId);
  assert.equal(failInterruptedRuns(project.db, () => false), 1);

  const second = await runNode(project, 'storyboard', { model: dukoModel() });
  assert.equal(steps(project, second.runId)[0], 'episodes:2-2');
  cleanup();
});

test('剧本 6 集每批 3 集：第 4–6 集那批报错 → 再跑只写 4–6，最后整份过门入库', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline', 'cast', 'art']);
  const first = await runNode(project, 'script', { model: failingAt('第 4–6 集') });
  assert.equal(first.status, 'failed');

  const second = await runNode(project, 'script', { model: dukoModel() });
  assert.equal(second.status, 'passed', `${second.message}\n${second.violations?.join('\n')}`);
  assert.deepEqual(steps(project, second.runId), ['episodes:4-6']);
  cleanup();
});

test('输入变了（剧本改过、换了模型）或上一次转人工却没留下可沿用的集：不沿用，从头写', async () => {
  const { project, cleanup } = await twoEpisodes();
  await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  const script = loadFixture('script');
  script.episodes[0].scenes[0].flow[0].action = '汽笛提前响了。';
  importArtifact(project, 'script', { ...script, episodes: script.episodes.filter((e: { ep: number }) => e.ep <= 2) });
  const changed = await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  assert.equal(steps(project, changed.runId)[0], 'episodes:1-1', '剧本改过');

  const other: TextModel = { ...dukoModel(), id: 'scripted:other', complete: (req) => dukoModel().complete(req) };
  const switched = await runNode(project, 'storyboard', { model: other });
  assert.equal(steps(project, switched.runId)[0], 'episodes:1-1', '换了模型');

  const again = await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  project.db.prepare(`UPDATE node_run SET status = 'needs_human' WHERE id = ?`).run(again.runId);
  const afterHuman = await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  assert.equal(steps(project, afterHuman.runId)[0], 'episodes:1-1', '转人工时没留下过门的集（这里是手改的状态）');
  cleanup();
});

test('上一次的进度文件坏了：不报错，从头写', async () => {
  const { project, cleanup } = await twoEpisodes();
  const first = await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  writeFileSync(join(project.dir, RUNS_DIR, String(first.runId), 'out', 'storyboard.partial.json'), '{"episodes": [');
  const second = await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  assert.equal(steps(project, second.runId)[0], 'episodes:1-1');
  cleanup();
});

test('项目参数变了（换了画幅）：不沿用', async () => {
  const { project, cleanup } = await twoEpisodes();
  await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  const input = currentInput(project.db)!;
  addInput(project.db, { kind: input.kind, text: input.text, params: { ...input.params, aspect: '9:16' } });
  const second = await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  assert.equal(steps(project, second.runId)[0], 'episodes:1-1');
  cleanup();
});

test('接力：续跑的那次还没写出新进度就又中断了，下一次仍能接上最早写好的集', async () => {
  const { project, cleanup } = await twoEpisodes();
  await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  // 第二次：沿用第 1 集，一开始写第 2 集就又报错（没写出任何新进度）
  const second = await runNode(project, 'storyboard', { model: failingAt('第 2–2 集') });
  assert.deepEqual(steps(project, second.runId), ['episodes:2-2']);
  const third = await runNode(project, 'storyboard', { model: dukoModel() });
  assert.equal(steps(project, third.runId)[0], 'episodes:2-2', '第 1 集还在');
  cleanup();
});

test('上一次所有集都写好了、在修复时出错：再跑不再写，直接过门修复', async () => {
  const t = tempProject();
  await setupNovel(t.project);
  importAll(t.project, ['outline', 'cast', 'art']);
  const script = loadFixture('script');
  importArtifact(t.project, 'script', { ...script, episodes: script.episodes.filter((e: { ep: number }) => e.ep === 1) });
  const staging = loadFixture('staging');
  importArtifact(t.project, 'staging', { ...staging, scenes: staging.scenes.filter((x: { ep: number }) => x.ep === 1) });
  // 写的时候不照抄开场走位（要修复），修复时供应商报错
  const writeOnly = dukoModel((req) => {
    if (req.user.includes('【上一次的违规')) throw new Error('供应商 500');
    if (req.user.includes('每切写 beatIds')) return fenced({ episodes: storyboardEpisodes(req.user, false) });
    return undefined;
  });
  const first = await runNode(t.project, 'storyboard', { model: writeOnly });
  assert.equal(first.status, 'failed');
  const fixer = dukoModel((req) => (req.user.includes('【上一次的违规') ? fenced({ episodes: storyboardEpisodes(req.user) }) : undefined));
  const second = await runNode(t.project, 'storyboard', { model: fixer });
  assert.equal(second.status, 'passed', `${second.message}\n${second.violations?.join('\n')}`);
  assert.deepEqual(steps(t.project, second.runId), ['repair:validate:ep1']);
  const doc = latestArtifactDoc(t.project.db, 'storyboard')?.doc as { aspectRatio?: string; source?: string };
  assert.ok(doc.aspectRatio && doc.source, '顶层字段来自沿用的那份');
  t.cleanup();
});

/** 第 2 集怎么写都过不了门：拿第 1 集的分镜改个集号交上来（场次对不上剧本第 2 集），修复时也一样。 */
const badSecond = () =>
  dukoModel((req) => {
    if (!req.user.includes('第 2–2 集')) return undefined;
    const e = storyboardEpisodes(req.user.replace(/第 2–2 集/g, '第 1–1 集'))[0]!;
    const segments = (e['segments'] as Record<string, unknown>[]).map(({ id: _g, ...g }) => ({ ...g, cuts: (g['cuts'] as Record<string, unknown>[]).map(({ id: _c, ...c }) => c) }));
    return fenced({ episodes: [{ ...e, ep: 2, segments }] });
  });

test('修复用尽转人工、违规只落在第 2 集：再跑沿用过了门的第 1 集，只重写第 2 集', async () => {
  const { project, cleanup } = await twoEpisodes();
  const first = await runNode(project, 'storyboard', { model: badSecond() });
  assert.equal(first.status, 'needs_human');

  const events: ProgressEvent[] = [];
  const second = await runNode(project, 'storyboard', { model: badSecond(), onProgress: (e) => events.push(e) });
  assert.equal(steps(project, second.runId)[0], 'episodes:2-2', '第 1 集不再重写');
  assert.ok(notices(events).some((m) => m.includes(`沿用上一次（run ${first.runId}）转人工时留下的 1 集`)), notices(events).join('\n'));
  cleanup();
});

test('过了门的集：违规都落得到集上才算，落不到、没法分份或全被点到时不沿用', () => {
  const doc = { source: 's', episodes: [{ ep: 1 }, { ep: 2 }, { ep: 3 }] };
  const split: RepairSplit = { keysOf: (v) => [...v.matchAll(/E(\d+)/g)].map((m) => episodeKey(Number(m[1]))), part: () => Promise.reject(new Error('不用')) };
  assert.deepEqual(passedEpisodes(doc, ['E02 不对', 'E03 也不对'], split), { source: 's', episodes: [{ ep: 1 }] });
  assert.equal(passedEpisodes(doc, ['E02 不对', '整份的问题'], split), null, '有一条落不到集上');
  assert.equal(passedEpisodes(doc, ['E02 不对'], undefined), null, '没法分份');
  assert.equal(passedEpisodes(doc, ['E01', 'E02', 'E03'], split), null, '全被点到');
});

test('分批不跨过缺口：要写的集不连续时（如只剩第 3、14 集），每批只含连续的集号', () => {
  assert.deepEqual(contiguousBatches([3, 14], 3), [[1, 1], [2, 2]]);
  assert.deepEqual(contiguousBatches([1, 2, 3, 4, 7, 8], 3), [[1, 3], [4, 4], [5, 6]]);
  assert.deepEqual(contiguousBatches([], 3), []);
});

test('第 2 集拆到单场仍撞输出上限转人工：再跑沿用已写好的第 1 集', async () => {
  const { project, cleanup } = await twoEpisodes();
  const inner = dukoModel();
  const truncating: TextModel = {
    ...inner,
    complete: (req) => (req.user.includes('第 2–2 集') ? Promise.resolve({ text: '', finishReason: 'length' as const, usage: { inputTokens: 1000, outputTokens: 8192 } }) : inner.complete(req)),
  };
  const first = await runNode(project, 'storyboard', { model: truncating });
  assert.equal(first.status, 'needs_human', first.message);
  const second = await runNode(project, 'storyboard', { model: dukoModel() });
  assert.equal(steps(project, second.runId)[0], 'episodes:2-2');
  cleanup();
});

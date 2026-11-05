// 只补出图提示词（backlog #33）：拿现有角色卡只跑 character-refs，只写 characterRefs，不重写角色卡；
// 分镜不读 characterRefs（需复核按内容判断，#34），补完不冒出需复核，也不写复核确认；原来就需复核的不动；估算不被补提示词的小用量拉低。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateUsage } from '../src/estimate/usage.ts';
import { runNode } from '../src/executor/run-node.ts';
import { importArtifact } from '../src/import/import-artifact.ts';
import { fillCharacterRefs } from '../src/orchestrate/refs-only.ts';
import { acknowledge, pendingCells } from '../src/orchestrate/review-matrix.ts';
import type { Project } from '../src/project.ts';
import { latestArtifactDoc } from '../src/repo/artifacts.ts';
import { listAttempts } from '../src/repo/runs.ts';
import { importAll, loadFixture, tempProject } from './helpers.ts';
import { dukoModel } from './support/duko-model.ts';
import { setupNovel } from './support/novel-pack.ts';

type Card = Record<string, unknown>;
const cards = (project: Project): Card[] => (latestArtifactDoc(project.db, 'cast')!.doc as { characters: Card[] }).characters;
const withoutRefs = (cs: readonly Card[]) => cs.map(({ characterRefs: _r, ...rest }) => rest);

async function oldProject(): Promise<ReturnType<typeof tempProject>> {
  const t = tempProject();
  await setupNovel(t.project);
  importAll(t.project);
  const cast = loadFixture('cast');
  importArtifact(t.project, 'cast', { ...cast, characters: cast.characters.map((c: Card) => ({ ...c, characterRefs: undefined })) });
  // 旧项目的样子：角色卡没有出图提示词，但下游都已经复核过（没有待处理）
  for (const c of pendingCells(t.project.db)) acknowledge(t.project.db, c.stage, c.episode, '旧项目');
  return t;
}

test('refsOnly：角色卡正文逐字不变，只补上 characterRefs；模型只被问 intake（refs: 步骤）', async () => {
  const { project, cleanup } = await oldProject();
  const before = withoutRefs(cards(project));
  const model = dukoModel();
  const out = await runNode(project, 'cast', { model, refsOnly: true, prices: null });
  assert.equal(out.status, 'passed', out.message);
  const after = cards(project);
  assert.deepEqual(withoutRefs(after), before, '角色卡其余字段不变');
  const drawn = (loadFixture('outline').characters as Card[]).filter((c) => c['tier'] !== 'functional').map((c) => c['name']);
  for (const c of after) assert.equal(Boolean(c['characterRefs']), drawn.includes(c['name']), `${String(c['name'])} 的 characterRefs`);
  const steps = listAttempts(project.db, out.runId).map((a) => a.step);
  assert.ok(steps.length > 0 && steps.every((s) => s.startsWith('refs:')), steps.join(','));
  cleanup();
});

test('refsOnly 只对角色阶段有效；还没有角色卡时报错', async () => {
  const { project, cleanup } = await oldProject();
  await assert.rejects(runNode(project, 'art', { model: dukoModel(), refsOnly: true, prices: null }), /只对角色阶段有效/);
  cleanup();
  const t = tempProject();
  await setupNovel(t.project);
  importAll(t.project, ['outline']);
  await assert.rejects(runNode(t.project, 'cast', { model: dukoModel(), refsOnly: true, prices: null }), /还没有角色卡/);
  t.cleanup();
});

test('fillCharacterRefs：没有待处理的项目，补完仍然没有，也不写复核确认（分镜不读出图提示词）', async () => {
  const { project, cleanup } = await oldProject();
  assert.equal(pendingCells(project.db).length, 0);
  const acks = () => (project.db.prepare('SELECT COUNT(*) AS n FROM review_ack').get() as { n: number }).n;
  const before = acks();
  const r = await fillCharacterRefs(project, { model: dukoModel(), prices: null });
  assert.equal(r.outcome.status, 'passed', r.outcome.message);
  assert.equal(pendingCells(project.db).length, 0);
  assert.equal(acks(), before, '没有自动确认');
  cleanup();
});

test('fillCharacterRefs：原来就需复核的格子不被顺手确认', async () => {
  const { project, cleanup } = await oldProject();
  const script = loadFixture('script');
  script.episodes[0].scenes[0].flow[0].action = '汽笛提前响了。';
  importArtifact(project, 'script', script);
  const stale = pendingCells(project.db).map((c) => `${c.stage}|${c.episode}`);
  assert.ok(stale.length > 0);
  await fillCharacterRefs(project, { model: dukoModel(), prices: null });
  for (const k of stale) assert.ok(pendingCells(project.db).some((c) => `${c.stage}|${c.episode}` === k), `${k} 还需复核`);
  cleanup();
});

test('估算：补提示词的运行不当成整个角色阶段的用量', async () => {
  const { project, cleanup } = await oldProject();
  const full = await runNode(project, 'cast', { model: dukoModel(), prices: null });
  assert.equal(full.status, 'passed');
  const castUsage = () => estimateUsage(project.db).find((n) => n.node === 'text:cast')!;
  const measured = JSON.stringify(castUsage());
  await runNode(project, 'cast', { model: dukoModel(), refsOnly: true, prices: null });
  assert.equal(JSON.stringify(castUsage()), measured, '仍取整跑那次的用量');
  cleanup();
});

// 角色配方里的 character-refs 一遍：intake 不过校验就带违规重问（最多 3 次）、没注册 character-refs 就报错、打回重跑时旧 intake 当底稿。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_INTAKE_TRIES } from '../src/executor/character-refs.ts';
import { runNode } from '../src/executor/run-node.ts';
import type { Project } from '../src/project.ts';
import { listAttempts } from '../src/repo/runs.ts';
import { importAll, loadFixture, tempProject } from './helpers.ts';
import { dukoIntakes, dukoModel } from './support/duko-model.ts';
import { novelManifest, setupNovel } from './support/novel-pack.ts';
import { fenced, promptSection } from './support/scripted-model.ts';

const steps = (project: Project, runId: number) => listAttempts(project.db, runId).map((a) => a.step);
const isIntakeAsk = (user: string, name: string) => user.includes('只输出这个角色的 intake') && (promptSection(user, '角色卡') ?? '').includes(`"name": "${name}"`);
/** 沈知微的 intake 写进了画风词：intake-check 拦 */
const styled = () => {
  const x = dukoIntakes()['沈知微']!;
  return { ...x, face: { ...x.face, en: `${x.face.en}, anime style` } };
};

test('intake 不过校验：带上一次的违规和那份 intake 重问，step 是 refs:C01:repair，修好后入库', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline']);
  const model = dukoModel((req) => (isIntakeAsk(req.user, '沈知微') && !req.user.includes('【上一次的违规') ? fenced(styled()) : undefined));
  const out = await runNode(project, 'cast', { model });
  assert.equal(out.status, 'passed', out.message);
  assert.deepEqual(steps(project, out.runId).filter((x) => x.startsWith('refs:C01')), ['refs:C01', 'refs:C01:repair']);
  const repair = model.requests.find((r) => r.user.includes('【上一次的违规') && isIntakeAsk(r.user, '沈知微'))!;
  assert.match(promptSection(repair.user, '上一次的违规') ?? '', /画风词（anime）/);
  assert.match(promptSection(repair.user, '上一次的 intake') ?? '', /anime style/);
  cleanup();
});

test(`intake 改了 ${MAX_INTAKE_TRIES} 次还不过：角色阶段失败，信息里带违规`, async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline']);
  const model = dukoModel((req) => (isIntakeAsk(req.user, '沈知微') ? fenced(styled()) : undefined));
  const out = await runNode(project, 'cast', { model });
  assert.equal(out.status, 'failed');
  assert.match(out.message ?? '', /沈知微.*3 次.*character-refs/s);
  assert.match(out.message ?? '', /画风词/);
  assert.equal(steps(project, out.runId).filter((s) => s.startsWith('refs:C01')).length, MAX_INTAKE_TRIES);
  cleanup();
});

test('包里没有 character-refs：角色阶段失败，说明要重新注册', async () => {
  const { project, cleanup } = tempProject();
  const manifest = novelManifest();
  await setupNovel(project, { ...manifest, skills: manifest.skills.filter((s) => s.name !== 'character-refs') });
  importAll(project, ['outline']);
  const out = await runNode(project, 'cast', { model: dukoModel() });
  assert.equal(out.status, 'failed');
  assert.match(out.message ?? '', /没有注册 character-refs/);
  cleanup();
});

test('打回重跑：旧角色卡的 intake 当底稿；角色卡那一遍的底稿不带 characterRefs', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline', 'cast']);
  const model = dukoModel();
  const out = await runNode(project, 'cast', { model, revise: { note: '沈知微的辫子改成一条' } });
  assert.equal(out.status, 'passed', out.message);
  const card = model.requests.find((r) => r.user.includes('这一个角色的完整角色卡') && r.user.includes('"name": "沈知微"'))!;
  assert.doesNotMatch(promptSection(card.user, '底稿') ?? '', /characterRefs/);
  const refs = model.requests.find((r) => isIntakeAsk(r.user, '沈知微'))!;
  assert.deepEqual(JSON.parse(promptSection(refs.user, '底稿') ?? 'null'), loadFixture('cast').characters[0].characterRefs.intake);
  cleanup();
});

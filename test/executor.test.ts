// 执行器集成测试：脚本化模型 + 上游 skill 副本（test/fixtures/skills），不出网、不花钱。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_ATTEMPTS, runNode, type ProgressEvent } from '../src/executor/run-node.ts';
import { RECIPE_NAMES } from '../src/executor/recipes.ts';
import { latestArtifactDoc } from '../src/repo/artifacts.ts';
import { addInput } from '../src/repo/inputs.ts';
import { createRun, getRun, listAttempts, unlockRun } from '../src/repo/runs.ts';
import { currentMount, registerPack } from '../src/repo/skills.ts';
import type { Project } from '../src/project.ts';
import { importAll, loadFixture, tempProject } from './helpers.ts';
import { fenced, ScriptedTextModel } from './support/scripted-model.ts';

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills');

const PACK = {
  name: 'novel',
  requires: { major: 3 },
  skills: [
    { name: 'novel-outline', stage: 'outline', script: 'scripts/novel-outline.mjs', recipe: 'novel-outline' },
    { name: 'novel-script', stage: 'script', script: 'scripts/novel-script.mjs', recipe: 'novel-script' },
  ],
};

async function setup(project: Project, withInput = true) {
  await registerPack(project.db, PACK, SKILLS, RECIPE_NAMES);
  if (withInput) addInput(project.db, { kind: 'synopsis', text: '民国年间，一条无名河上的老渡船……', params: { episodes: 6, seconds: 60, genre: '悬疑' } });
}

/** 大纲骨架：渡口大纲去掉分集与爽点归属（模型不写 id）。 */
function skeleton() {
  const { episodes: _e, ...rest } = loadFixture('outline');
  return { ...rest, beats: rest.beats.map(({ episodeRef: _r, ...b }: Record<string, unknown>) => b) };
}
const outlineEpisodes = () => ({ episodes: loadFixture('outline').episodes.map(({ id: _id, ...e }: Record<string, unknown>) => e) });

test('大纲一次通过：骨架 → 分集 → 补 id → 校验 → 平台门 → 入库', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const model = new ScriptedTextModel([fenced(skeleton()), fenced(outlineEpisodes())]);
  const events: ProgressEvent[] = [];
  const out = await runNode(project, 'outline', { model, onProgress: (e) => events.push(e) });

  assert.equal(out.status, 'passed', out.message);
  assert.equal(out.artifactV, 1);
  const doc = latestArtifactDoc(project.db, 'outline')?.doc as { episodes: { id: string }[] };
  assert.ok(doc.episodes.every((e) => /^ep_[0-9a-z]{8}$/.test(e.id)), '集 id 由 ids 补上');
  assert.deepEqual(listAttempts(project.db, out.runId).map((a) => a.step), ['skeleton', 'episodes:1-6']);
  assert.match(model.requests[0]!.user, /【本遍任务】/);
  assert.match(model.requests[0]!.system, /不要输出任何 id 字段/);
  assert.match(model.requests[0]!.user, /题材：悬疑/);
  assert.equal(getRun(project.db, out.runId)?.skippedHumanGates.length, 1, '一键模式跳过的「用户拍板」要记下来');
  assert.ok(events.some((e) => e.type === 'run-end' && e.status === 'passed'));
  cleanup();
});

test('骨架违规后带原文修复', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const broken = { ...skeleton(), beats: [] };
  const model = new ScriptedTextModel([fenced(broken), fenced(skeleton()), fenced(outlineEpisodes())]);
  const out = await runNode(project, 'outline', { model });

  assert.equal(out.status, 'passed', out.message);
  const repair = model.requests[1]!.user;
  assert.match(repair, /【上一次的违规/);
  assert.match(repair, /【当前版本（需要修正）】/);
  assert.deepEqual(listAttempts(project.db, out.runId).map((a) => a.step), ['skeleton', 'repair:validate:beats', 'episodes:1-6']);
  cleanup();
});

test('输出不是 JSON 时带违规重问', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const model = new ScriptedTextModel(['我觉得这个故事很有意思。', fenced(skeleton()), fenced(outlineEpisodes())]);
  const out = await runNode(project, 'outline', { model });

  assert.equal(out.status, 'passed', out.message);
  const first = listAttempts(project.db, out.runId)[0]!;
  assert.match(first.violations[0] ?? '', /输出不是合法 JSON/);
  assert.match(model.requests[1]!.user, /输出不是合法 JSON/);
  cleanup();
});

test('重试用尽转人工：留下最后一版与违规，库里没有产物', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const noHook = () => {
    const eps = outlineEpisodes();
    eps.episodes[0].hook = '';
    return eps;
  };
  const badFull = () => {
    const d = { ...skeleton(), episodes: noHook().episodes };
    return fenced(d);
  };
  const model = new ScriptedTextModel([fenced(skeleton()), fenced(noHook()), ...Array.from({ length: DEFAULT_MAX_ATTEMPTS }, badFull)]);
  const out = await runNode(project, 'outline', { model });

  assert.equal(out.status, 'needs_human');
  assert.ok(out.violations?.some((v) => v.includes('钩子')));
  assert.ok(existsSync(join(out.dir, 'out', 'outline.json')));
  assert.match(readFileSync(join(out.dir, 'violations.txt'), 'utf8'), /钩子/);
  assert.equal(latestArtifactDoc(project.db, 'outline'), null);
  assert.equal(getRun(project.db, out.runId)?.status, 'needs_human');
  cleanup();
});

test('没有项目输入时拒绝跑大纲，不建运行记录', async () => {
  const { project, cleanup } = tempProject();
  await setup(project, false);
  await assert.rejects(runNode(project, 'outline', { model: new ScriptedTextModel([]) }), /先用 input 提供梗概/);
  assert.equal(project.db.prepare('SELECT COUNT(*) AS n FROM node_run').get()?.['n'], 0);
  cleanup();
});

test('剧本缺上游大纲时拒绝', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  await assert.rejects(runNode(project, 'script', { model: new ScriptedTextModel([]) }), /先跑或导入 outline/);
  cleanup();
});

test('剧本按批 seed → 写 → 补场次 id → 校验通过入库', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  importAll(project, ['outline', 'art']);
  const script = loadFixture('script');
  const batch = (from: number, to: number) => () =>
    fenced({
      episodes: script.episodes
        .filter((e: { ep: number }) => e.ep >= from && e.ep <= to)
        .map((e: { scenes: Record<string, unknown>[] }) => ({ ...e, scenes: e.scenes.map(({ id: _id, ...sc }) => sc) })),
    });
  const model = new ScriptedTextModel([batch(1, 3), batch(4, 6)]);
  const out = await runNode(project, 'script', { model });

  assert.equal(out.status, 'passed', `${out.message}\n${out.violations?.join('\n')}`);
  assert.deepEqual(listAttempts(project.db, out.runId).map((a) => a.step), ['episodes:1-3', 'episodes:4-6']);
  const doc = latestArtifactDoc(project.db, 'script')?.doc as { episodes: { id: string; scenes: { id: string }[] }[] };
  assert.ok(doc.episodes.flatMap((e) => e.scenes).every((sc) => /^sc_/.test(sc.id)), '场次 id 由 ids 补上');
  assert.equal(doc.episodes[0]!.id, script.episodes[0].id, '集 id 照抄大纲');
  assert.match(model.requests[0]!.user, /【骨架（seed 预填）】/);
  cleanup();
});

test('平台门：只有提示词的 skill 输出结构不对时，投影问题当违规修复', async () => {
  const { project, cleanup } = tempProject();
  await registerPack(project.db, { name: 'mini', skills: [{ name: 'prompt-only', stage: 'storyboard', script: null, recipe: 'single-pass' }] }, SKILLS, RECIPE_NAMES);
  importAll(project, ['outline', 'art', 'script', 'staging']);
  const good = loadFixture('storyboard');
  const model = new ScriptedTextModel([fenced({ aspectRatio: '9:16' }), fenced(good)]);
  const out = await runNode(project, 'storyboard', { model });

  assert.equal(out.status, 'passed', out.message);
  const attempts = listAttempts(project.db, out.runId);
  assert.deepEqual(attempts.map((a) => a.step), ['single', 'repair:platform']);
  assert.match(model.requests[1]!.user, /缺少数组字段 episodes/);
  cleanup();
});

test('模型命令出错时运行记为 failed', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const model = { id: 'broken', complete: async () => Promise.reject(new Error('网络断了')) };
  const out = await runNode(project, 'outline', { model });
  assert.equal(out.status, 'failed');
  assert.match(out.message ?? '', /网络断了/);
  cleanup();
});

test('进程中断留下的 running 运行会被收尾为 failed', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const skillId = currentMount(project.db, 'outline')!.id;
  const stale = createRun(project.db, { stage: 'outline', skillId, model: 'x', inputId: null, maxAttempts: 1 });
  project.db.prepare('UPDATE node_run SET pid = NULL WHERE id = ?').run(stale);
  const model = new ScriptedTextModel([fenced(skeleton()), fenced(outlineEpisodes())]);
  const out = await runNode(project, 'outline', { model });
  assert.equal(out.status, 'passed');
  assert.equal(getRun(project.db, stale)?.status, 'failed');
  assert.equal(getRun(project.db, stale)?.error, '进程中断');
  cleanup();
});

test('同一阶段有别的活着的进程在跑时拒绝再开；runs unlock 能解开', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const skillId = currentMount(project.db, 'outline')!.id;
  const other = createRun(project.db, { stage: 'outline', skillId, model: 'x', inputId: null, maxAttempts: 1 });
  project.db.prepare('UPDATE node_run SET pid = ? WHERE id = ?').run(process.ppid, other);
  await assert.rejects(runNode(project, 'outline', { model: new ScriptedTextModel([]) }), /已有运行中的任务.*runs unlock/);
  unlockRun(project.db, other);
  assert.equal(getRun(project.db, other)?.error, '人工解锁');
  assert.throws(() => unlockRun(project.db, other), /不需要解锁/);
  const out = await runNode(project, 'outline', { model: new ScriptedTextModel([fenced(skeleton()), fenced(outlineEpisodes())]) });
  assert.equal(out.status, 'passed');
  cleanup();
});

test('本进程里残留的 running 记录（不在执行名单里）会被收尾，不会把阶段锁死', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const skillId = currentMount(project.db, 'outline')!.id;
  const leftover = createRun(project.db, { stage: 'outline', skillId, model: 'x', inputId: null, maxAttempts: 1 });
  const out = await runNode(project, 'outline', { model: new ScriptedTextModel([fenced(skeleton()), fenced(outlineEpisodes())]) });
  assert.equal(out.status, 'passed');
  assert.equal(getRun(project.db, leftover)?.status, 'failed');
  cleanup();
});

const GATED = { name: 'gated', skills: [{ name: 'gated-storyboard', stage: 'storyboard', script: 'scripts/gated.mjs', recipe: 'single-pass' }] };

test('平台门修复后：重新补 id，并复查 skill 自己的质量门（修复不能把内容改坏后照样入库）', async () => {
  const { project, cleanup } = tempProject();
  await registerPack(project.db, GATED, SKILLS, RECIPE_NAMES);
  importAll(project, ['outline', 'art', 'script', 'staging']);
  const good = loadFixture('storyboard');
  // 1) 结构不对（平台门不过）；2) 结构修好了但把内容改坏（bad），且没带章；3) 改好
  const model = new ScriptedTextModel([fenced({ aspectRatio: '9:16' }), fenced({ ...good, bad: true }), fenced(good)]);
  const out = await runNode(project, 'storyboard', { model });

  assert.equal(out.status, 'passed', `${out.message} ${out.violations?.join(' / ')}`);
  assert.equal(model.requests.length, 3, '第二次修复后不该因为缺章再多问一次：修复后要先补 id');
  assert.match(model.requests[2]!.user, /bad 字段不能为 true/, '平台门复查了 skill 的 validate');
  const doc = latestArtifactDoc(project.db, 'storyboard')?.doc as { stamped?: boolean; bad?: boolean };
  assert.equal(doc.stamped, true);
  assert.equal(doc.bad, undefined);
  cleanup();
});

test('修复时模型一直给不出 JSON：交给人的是最后一版能解析的文档，原始输出另存', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const eps = outlineEpisodes();
  eps.episodes[0].hook = '';
  const model = new ScriptedTextModel([fenced(skeleton()), fenced(eps), ...Array.from({ length: DEFAULT_MAX_ATTEMPTS }, () => '抱歉，我改不了。')]);
  const out = await runNode(project, 'outline', { model });

  assert.equal(out.status, 'needs_human');
  const kept = JSON.parse(readFileSync(join(out.dir, 'out', 'outline.json'), 'utf8')) as { episodes: unknown[] };
  assert.equal(kept.episodes.length, 6, 'out/outline.json 是上一版能用的文档');
  assert.equal(readFileSync(join(out.dir, 'out', 'outline.raw.txt'), 'utf8'), '抱歉，我改不了。');
  assert.ok(out.violations?.some((v) => v.includes('钩子')), '违规里保留原来的质量门问题');
  assert.ok(out.violations?.some((v) => v.includes('输出不是合法 JSON')));
  cleanup();
});

test('建好运行记录之后任何一步出错（如进度回调抛错）都会收尾，不会卡在 running', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const out = await runNode(project, 'outline', {
    model: new ScriptedTextModel([]),
    onProgress: (e) => {
      if (e.type === 'run-start') throw new Error('界面断开了');
    },
  });
  assert.equal(out.status, 'failed');
  assert.match(out.message ?? '', /界面断开了/);
  assert.equal(getRun(project.db, out.runId)?.status, 'failed');
  const again = await runNode(project, 'outline', { model: new ScriptedTextModel([fenced(skeleton()), fenced(outlineEpisodes())]) });
  assert.equal(again.status, 'passed', '同一进程里马上能再跑');
  cleanup();
});

const truncatedModel = (texts: (string | { length: true })[]) => {
  const requests: string[] = [];
  return {
    requests,
    id: 'deepseek:deepseek-flash',
    async complete(req: { user: string }) {
      requests.push(req.user);
      const next = texts.shift();
      if (next === undefined) throw new Error('没有更多预设输出');
      return typeof next === 'string'
        ? { text: next, finishReason: 'stop' as const, usage: { inputTokens: 1000, outputTokens: 500 } }
        : { text: '', finishReason: 'length' as const, usage: { inputTokens: 1000, outputTokens: 8192, reasoningTokens: 8192 } };
    },
  };
};

const PRICES = {
  user: [],
  cache: [],
  cacheFetchedAt: null,
  builtin: [
    { model: 'deepseek:deepseek-flash', unit: 'token_in' as const, price: 0.3, currency: 'USD', source: 't', checkedAt: '2026-10-29', verified: false },
    { model: 'deepseek:deepseek-flash', unit: 'token_out' as const, price: 1.2, currency: 'USD', source: 't', checkedAt: '2026-10-29', verified: false },
  ],
};

test('截断：不原样重试，把分集批次对半拆开再写；每次尝试记下费用与结束原因', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const all = outlineEpisodes().episodes;
  const part = (from: number, to: number) => fenced({ episodes: all.filter((e: { ep: number }) => e.ep >= from && e.ep <= to) });
  // 骨架；1–6 集一批被截断 → 拆成 1–3、4–6
  const model = truncatedModel([fenced(skeleton()), { length: true }, part(1, 3), part(4, 6)]);
  const out = await runNode(project, 'outline', { model, prices: PRICES });

  assert.equal(out.status, 'passed', out.message);
  const attempts = listAttempts(project.db, out.runId);
  assert.deepEqual(attempts.map((a) => a.step), ['skeleton', 'episodes:1-6', 'episodes:1-3', 'episodes:4-6']);
  assert.match(attempts[1]!.violations[0] ?? '', /输出被截断.*已用 8192 tokens，其中推理 8192/);
  const rows = project.db.prepare('SELECT finish_reason, cost, cost_currency FROM node_attempt WHERE run_id = ? ORDER BY id').all(out.runId) as { finish_reason: string; cost: number; cost_currency: string }[];
  assert.deepEqual(rows.map((r) => r.finish_reason), ['stop', 'length', 'stop', 'stop']);
  assert.equal(rows[0]!.cost, (1000 * 0.3 + 500 * 1.2) / 1e6);
  assert.equal(rows[0]!.cost_currency, 'USD');
  cleanup();
});

test('截断：拆到一集还截断就转人工并说明原因；没有价格时费用记 null', async () => {
  const { project, cleanup } = tempProject();
  addInput(project.db, { kind: 'synopsis', text: 'x', params: { episodes: 1, seconds: 60, genre: '悬疑' } });
  await registerPack(project.db, PACK, SKILLS, RECIPE_NAMES);
  const model = truncatedModel([fenced(skeleton()), { length: true }]);
  const out = await runNode(project, 'outline', { model, prices: null });
  assert.equal(out.status, 'needs_human');
  assert.match(out.message ?? '', /episodes:1-1：输出被截断.*已拆到最小批次，需要更大的输出上限或换模型/);
  const costs = project.db.prepare('SELECT cost FROM node_attempt WHERE run_id = ?').all(out.runId) as { cost: number | null }[];
  assert.ok(costs.every((c) => c.cost === null));
  cleanup();
});

test('评审修复：不分批的步骤截断时如实说「这一步不分批」；缓存命中有单价就按它计；模型没单价时提示', async () => {
  const { project, cleanup } = tempProject();
  await setup(project);
  const events: ProgressEvent[] = [];
  const out = await runNode(project, 'outline', { model: truncatedModel([{ length: true }]), prices: PRICES, onProgress: (e) => events.push(e) });
  assert.match(out.message ?? '', /skeleton：输出被截断.*这一步不分批/);
  const cachedPrices = { ...PRICES, builtin: [...PRICES.builtin, { model: 'deepseek:deepseek-flash', unit: 'token_in_cached' as const, price: 0.03, currency: 'USD', source: 't', checkedAt: '2026-10-29', verified: false }] };
  const { attemptCost } = await import('../src/executor/run-node.ts');
  const c = attemptCost('deepseek:deepseek-flash', { text: '', usage: { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 800 } }, cachedPrices);
  assert.equal(c?.amount, (200 * 0.3 + 800 * 0.03) / 1e6);
  const none = { ...PRICES, builtin: [] };
  const ev2: ProgressEvent[] = [];
  await runNode(project, 'outline', { model: truncatedModel([{ length: true }]), prices: none, onProgress: (e) => ev2.push(e) });
  assert.ok(ev2.some((e) => e.type === 'notice' && /没有单价，本次不记费用/.test(e.message)));
  cleanup();
});

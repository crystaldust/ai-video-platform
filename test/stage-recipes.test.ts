// 角色、美术、站位、分镜的专用配方：真实 skill 副本 + 按提示词作答的模型（吐渡口样例），不出网。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBlocking, stagingCarryViolations } from '../src/executor/gates/staging-carry.ts';
import { runNode } from '../src/executor/run-node.ts';
import { mergeScoped } from '../src/executor/scoped.ts';
import { importArtifact } from '../src/import/import-artifact.ts';
import type { Project } from '../src/project.ts';
import { latestArtifactDoc } from '../src/repo/artifacts.ts';
import { listVersions } from '../src/repo/entities.ts';
import { getRun, listAttempts } from '../src/repo/runs.ts';
import { DUKO, importAll, loadFixture, tempProject } from './helpers.ts';
import { dukoModel, storyboardEpisodes } from './support/duko-model.ts';
import { setupNovel } from './support/novel-pack.ts';
import { fenced, promptSection } from './support/scripted-model.ts';

const steps = (project: Project, runId: number) => listAttempts(project.db, runId).map((a) => a.step);

test('角色卡：seed 名单 → 每人一张卡 → 故事摘要 → validate（引文对原文）→ 入库', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline']);
  const model = dukoModel();
  const out = await runNode(project, 'cast', { model });

  assert.equal(out.status, 'passed', `${out.message}\n${out.violations?.join('\n')}`);
  assert.deepEqual(steps(project, out.runId), ['card:C01', 'card:C02', 'card:C03', 'card:C04', 'card:C05', 'summary']);
  const doc = latestArtifactDoc(project.db, 'cast')?.doc as { characters: { id: string; name: string; seedNote?: string }[] };
  assert.deepEqual(doc.characters.map((c) => c.id), ['C01', 'C02', 'C03', 'C04', 'C05'], '角色码照抄大纲，名单以大纲为准');
  assert.ok(doc.characters.every((c) => c.seedNote === undefined), 'seedNote 不进成品');
  assert.match(promptSection(model.requests[0]!.user, '同批其他角色') ?? '', /陆行远/);
  assert.match(model.requests[0]!.user, /【原文】/);
  cleanup();
});

test('角色卡：validate 不过（出图提示词带人名）时整份修复', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline']);
  const named = (card: Record<string, any>) => ({ ...card, image: { ...card.image, prompt: `沈知微, ${card.image.prompt}` } });
  const model = dukoModel((req) => {
    if (req.user.includes('【上一次的违规')) return fenced(loadFixture('cast'));
    if (req.user.includes('这一个角色的完整角色卡') && req.user.includes('"name": "沈知微"')) return fenced(named(loadFixture('cast').characters[0]));
    return undefined;
  });
  const out = await runNode(project, 'cast', { model });
  assert.equal(out.status, 'passed', out.message);
  assert.deepEqual(steps(project, out.runId).slice(-1), ['repair:validate']);
  assert.match(promptSection(model.requests.at(-1)!.user, '上一次的违规') ?? '', /沈知微/);
  cleanup();
});

test('美术：seed → 场景一遍 → 道具一遍 → validate --cast → 入库', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline', 'cast']);
  const out = await runNode(project, 'art', { model: dukoModel() });
  assert.equal(out.status, 'passed', `${out.message}\n${out.violations?.join('\n')}`);
  assert.deepEqual(steps(project, out.runId), ['scenes', 'props']);
  const doc = latestArtifactDoc(project.db, 'art')?.doc as { scenes: unknown[]; props: unknown[] };
  assert.equal(doc.scenes.length, 3);
  assert.equal(doc.props.length, 2);
  cleanup();
});

test('站位：认图一遍 → 每批 ≤3 集排位 → validate → 入库', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline', 'cast', 'art', 'script']);
  const model = dukoModel();
  const out = await runNode(project, 'staging', { model });
  assert.equal(out.status, 'passed', `${out.message}\n${out.violations?.join('\n')}`);
  assert.deepEqual(steps(project, out.runId), ['read', 'episodes:1-3', 'episodes:4-6']);
  const doc = latestArtifactDoc(project.db, 'staging')?.doc as { scenes: { sceneRef: string }[] };
  assert.deepEqual(doc.scenes.map((s) => s.sceneRef), loadFixture('staging').scenes.map((s: { sceneRef: string }) => s.sceneRef));
  const batch = model.requests[1]!.user;
  assert.match(batch, /【认图结果（站位只能落在这些东西上）】/);
  assert.doesNotMatch(promptSection(batch, '上游 script.json') ?? '', /"ep": 4/, '每批只给这几集的剧本');
  cleanup();
});

test('站位只重跑第 3 集：沿用已有认图，提示词带意见与底稿；导入只动第 3 集，产物版本存整份', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline', 'cast', 'art', 'script', 'staging']);
  const before = listVersions(project.db, 'script_scene', DUKO.sc11, 'staging').length;
  const changed = (req: { user: string }) => {
    if (!req.user.includes('给 places 里每个人填')) return undefined;
    const scenes = loadFixture('staging').scenes.filter((s: { ep: number }) => s.ep === 3);
    return fenced({ scenes: scenes.map((s: Record<string, unknown>) => ({ ...s, why: '按意见改：老周退到船尾' })) });
  };
  const model = dukoModel(changed);
  const out = await runNode(project, 'staging', { model, episodes: [DUKO.ep3], revise: { note: '老周退到船尾' } });

  assert.equal(out.status, 'passed', `${out.message}\n${out.violations?.join('\n')}`);
  assert.deepEqual(steps(project, out.runId), ['episodes:3-3'], '认图沿用底稿，不重认');
  const user = model.requests[0]!.user;
  assert.match(promptSection(user, '作者意见') ?? '', /老周退到船尾/);
  assert.match(promptSection(user, '底稿') ?? '', /"ep": 3/);
  assert.doesNotMatch(promptSection(user, '底稿') ?? '', /"ep": 2/, '底稿只给这一集');
  const doc = latestArtifactDoc(project.db, 'staging')?.doc as { scenes: { ep: number; why: string }[] };
  assert.equal(doc.scenes.length, 9, '产物版本是并回后的整份');
  assert.equal(doc.scenes.find((s) => s.ep === 3)?.why, '按意见改：老周退到船尾');
  assert.equal(listVersions(project.db, 'script_scene', DUKO.sc11, 'staging').length, before, '第 1 集的站位不长新版本');
  assert.equal(getRun(project.db, out.runId)?.episodeKey, DUKO.ep3);
  cleanup();
});

test('整份负责的阶段不能按集重跑；按集重跑的集 id 要在上游里', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline', 'cast', 'art', 'script', 'staging']);
  await assert.rejects(runNode(project, 'art', { model: dukoModel(), episodes: [DUKO.ep3] }), /art 是整份负责的/);
  await assert.rejects(runNode(project, 'staging', { model: dukoModel(), episodes: ['ep_zzzzzzzz'] }), /上游 script 里没有这些集：ep_zzzzzzzz/);
  cleanup();
});

/** 只有第 1 集的剧本与站位（渡口分镜样例只有第 1 集）。 */
function importEp1(project: Project): void {
  importAll(project, ['outline', 'cast', 'art']);
  const script = loadFixture('script');
  importArtifact(project, 'script', { ...script, episodes: script.episodes.filter((e: { ep: number }) => e.ep === 1) });
  const staging = loadFixture('staging');
  importArtifact(project, 'staging', { ...staging, scenes: staging.scenes.filter((s: { ep: number }) => s.ep === 1) });
}

test('分镜：取站位的开场走位句 → 每批 ≤2 集切镜 → 补 id → validate + staging-carry → 入库', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importEp1(project);
  const model = dukoModel();
  const out = await runNode(project, 'storyboard', { model });

  assert.equal(out.status, 'passed', `${out.message}\n${out.violations?.join('\n')}`);
  assert.deepEqual(steps(project, out.runId), ['episodes:1-1']);
  assert.match(promptSection(model.requests[0]!.user, '开场走位') ?? '', new RegExp(`${DUKO.sc11}：沈知微站在岸端土坡上`));
  const doc = latestArtifactDoc(project.db, 'storyboard')?.doc as { episodes: { segments: { id: string; blocking: string }[] }[] };
  assert.match(doc.episodes[0]!.segments[0]!.blocking, /^沈知微站在岸端土坡上/);
  cleanup();
});

test('分镜没照抄开场走位：staging-carry 违规进修复循环', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importEp1(project);
  const head = (({ episodes: _e, ...rest }) => rest)(loadFixture('storyboard'));
  const model = dukoModel((req) => {
    if (req.user.includes('【上一次的违规')) return fenced({ ...head, episodes: storyboardEpisodes(req.user) });
    if (req.user.includes('每切写 beatIds')) return fenced({ episodes: storyboardEpisodes(req.user, false) });
    return undefined;
  });
  const out = await runNode(project, 'storyboard', { model });
  assert.equal(out.status, 'passed', `${out.message}\n${out.violations?.join('\n')}`);
  assert.deepEqual(steps(project, out.runId), ['episodes:1-1', 'repair:validate']);
  const violations = promptSection(model.requests[1]!.user, '上一次的违规') ?? '';
  assert.match(violations, /blocking 没有照抄站位的开场走位：『沈知微站在岸端土坡上/);
  assert.equal(violations.split('\n').length, 2, '两场各一条');
  cleanup();
});

test('staging-carry：解析 blocking 输出；空白差异不算违规；行数对不上报错', () => {
  const staging = { scenes: [{ sceneRef: 'sc_aaaaaaaa' }, { sceneRef: 'sc_bbbbbbbb' }] };
  const opening = parseBlocking('第 1 集第 1 场\t甲站在桥上。\n第 1 集第 2 场\t乙坐着。\n', staging);
  assert.deepEqual([...opening], [['sc_aaaaaaaa', '甲站在桥上。'], ['sc_bbbbbbbb', '乙坐着。']]);
  assert.throws(() => parseBlocking('只有一行\tx\n', staging), /输出 1 行，站位有 2 场/);
  assert.throws(() => parseBlocking('没有制表符\n第二行\tx', staging), /没有制表符/);
  const board = {
    episodes: [{ segments: [
      { id: 'sg_1', sceneRef: 'sc_aaaaaaaa', blocking: '甲 站在 桥上。 随后转身' },
      { id: 'sg_2', sceneRef: 'sc_aaaaaaaa', blocking: '第二段不查' },
      { id: 'sg_3', sceneRef: 'sc_bbbbbbbb', blocking: '乙站着。' },
      { id: 'sg_4', sceneRef: 'sc_cccccccc', blocking: '没有站位的场次不查' },
    ] }],
  };
  assert.deepEqual(stagingCarryViolations(board, opening), ['段 sg_3的 blocking 没有照抄站位的开场走位：『乙坐着。』（场次 sc_bbbbbbbb 第一段的 blocking 要以这句开头）']);
});

test('并回整份：剧本、分镜按集 id 换集；站位按集号换场次、认图按地点合并', () => {
  const script = { source: 'x', episodes: [{ id: 'ep_a', ep: 1, v: 1 }, { id: 'ep_b', ep: 2, v: 1 }] };
  assert.deepEqual(mergeScoped('script', script, { episodes: [{ id: 'ep_b', ep: 2, v: 2 }] }).episodes, [{ id: 'ep_a', ep: 1, v: 1 }, { id: 'ep_b', ep: 2, v: 2 }]);
  const staging = { locations: [{ sceneId: 'S01', n: 1 }], scenes: [{ ep: 1, scene: 1, x: 1 }, { ep: 2, scene: 1, x: 1 }, { ep: 2, scene: 2, x: 1 }] };
  const merged = mergeScoped('staging', staging, { locations: [{ sceneId: 'S02', n: 1 }], scenes: [{ ep: 2, scene: 1, x: 2 }] });
  assert.deepEqual(merged.scenes, [{ ep: 1, scene: 1, x: 1 }, { ep: 2, scene: 1, x: 2 }], '第 2 集删掉的场次跟着消失');
  assert.deepEqual(merged.locations, [{ sceneId: 'S01', n: 1 }, { sceneId: 'S02', n: 1 }]);
  assert.deepEqual(mergeScoped('script', null, { episodes: [] }), { episodes: [] });
  assert.throws(() => mergeScoped('outline', {}, {}), /整份负责/);
});

test('一次重跑几集时按剧本里的集顺序分批（给的顺序乱了也不会拼出倒着的区间）', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline', 'cast', 'art', 'script', 'staging']);
  const model = dukoModel();
  const ep5 = loadFixture('script').episodes[4].id;
  const out = await runNode(project, 'staging', { model, episodes: [ep5, DUKO.ep2], revise: {} });
  assert.equal(out.status, 'passed', `${out.message}\n${out.violations?.join('\n')}`);
  assert.deepEqual(steps(project, out.runId), ['episodes:2-5']);
  const draft = promptSection(model.requests[0]!.user, '站位骨架') ?? '';
  assert.deepEqual([...new Set([...draft.matchAll(/"ep": (\d+)/g)].map((m) => Number(m[1])))], [2, 5], '骨架只有这两集');
  assert.equal(getRun(project.db, out.runId)?.episodeKey, `${DUKO.ep2},${ep5}`);
  cleanup();
});

test('只给 episodes 不给 revise：也带底稿，跨集共用的认图照样沿用、不重认', async () => {
  const { project, cleanup } = tempProject();
  await setupNovel(project);
  importAll(project, ['outline', 'cast', 'art', 'script', 'staging']);
  const model = dukoModel();
  const out = await runNode(project, 'staging', { model, episodes: [DUKO.ep3] });
  assert.equal(out.status, 'passed', out.message);
  assert.deepEqual(steps(project, out.runId), ['episodes:3-3']);
  assert.ok(promptSection(model.requests[0]!.user, '底稿'));
  assert.equal(promptSection(model.requests[0]!.user, '作者意见'), null, '没有意见就不出现意见段');
  cleanup();
});

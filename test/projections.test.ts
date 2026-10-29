// 投影单测：渡口样例全部无问题、数量对得上；每条拦截规则都配一个故意改坏的反例。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntityKind, Projection, ProjectionContext, Stage } from '../src/domain/types.ts';
import { STAGES } from '../src/domain/types.ts';
import { PROJECTIONS } from '../src/import/projections/index.ts';
import { DUKO, loadFixture } from './helpers.ts';

/** 剧本样例里的「场次 id → 集 id」，相当于剧本已经导入。 */
const SCENE_EPISODE = new Map<string, string>(
  loadFixture('script').episodes.flatMap((e: any) => e.scenes.map((sc: any) => [sc.id, e.id] as const)),
);

const CTX: ProjectionContext = {
  characterKeyByName: new Map([
    ['沈知微', 'C01'],
    ['陆行远', 'C02'],
    ['老周', 'C03'],
    ['胡二爷', 'C04'],
    ['岸上挑灯的更夫', 'C05'],
  ]),
  ambiguousNames: new Set(),
  sceneEpisode: SCENE_EPISODE,
};

const project = (stage: Stage, doc: unknown = loadFixture(stage), ctx = CTX): Projection => PROJECTIONS[stage](doc, ctx);

function countByKind(p: Projection): Partial<Record<EntityKind, number>> {
  return p.entities.reduce<Partial<Record<EntityKind, number>>>((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
}

test('outline 渡口：6 集 5 人 3 景 2 道具 4 爽点，无问题', () => {
  const p = project('outline');
  assert.deepEqual(p.problems, []);
  assert.deepEqual(countByKind(p), { character: 5, location: 3, prop: 2, beat: 4, episode: 6 });
  assert.equal(p.entities.find((e) => e.key === 'C01')?.title, '沈知微');
  assert.equal(p.entities.find((e) => e.kind === 'episode' && e.key === DUKO.ep1)?.title, '第1集', '集按 id 定键，集号只拼显示名');
  const b01 = p.refs.find((r) => r.from.key === 'B01' && r.role === 'episode');
  assert.equal(b01?.to.key, DUKO.ep1, '爽点按 episodeRef 指向集');
});

test('cast 渡口：4 张卡按名字对上 C01–C04', () => {
  const p = project('cast');
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.entities.map((e) => e.key), ['C01', 'C02', 'C03', 'C04']);
  assert.ok(p.entities.every((e) => e.facet === 'cast'));
});

test('cast 名字和别名都对不上时拒绝，并点名', () => {
  const doc = loadFixture('cast');
  doc.characters[0].name = '张三';
  doc.characters[0].aliases = [];
  const p = project('cast', doc);
  assert.equal(p.problems.length, 1);
  assert.match(p.problems[0] ?? '', /张三/);
});

test('cast 碰上大纲重名人物时拒绝，不猜', () => {
  const ctx: ProjectionContext = { ...CTX, ambiguousNames: new Set(['沈知微']) };
  assert.match(project('cast', loadFixture('cast'), ctx).problems.join('\n'), /重名/);
});

test('cast 按别名也能对上', () => {
  const doc = loadFixture('cast');
  doc.characters[0].name = '沈小姐';
  doc.characters[0].aliases = ['沈知微'];
  assert.deepEqual(project('cast', doc).problems, []);
});

test('art 渡口：3 景 2 道具，S03 是 S02 的变体', () => {
  const p = project('art');
  assert.deepEqual(p.problems, []);
  assert.deepEqual(countByKind(p), { location: 3, prop: 2 });
  const variant = p.refs.find((r) => r.role === 'variant-of');
  assert.deepEqual([variant?.from.key, variant?.to.key], ['S03', 'S02']);
});

test('script 渡口：6 集 9 场，场次按上游 id 定键并记下所属集', () => {
  const p = project('script');
  assert.deepEqual(p.problems, []);
  assert.deepEqual(countByKind(p), { episode: 6, script_scene: 9 });
  const scenes = p.entities.filter((e) => e.kind === 'script_scene');
  assert.deepEqual(scenes.map((e) => e.key), [...SCENE_EPISODE.keys()]);
  assert.ok(scenes.every((e) => e.episode === SCENE_EPISODE.get(e.key)));
  const ep1 = p.entities.find((e) => e.kind === 'episode' && e.key === DUKO.ep1);
  const payload = ep1?.payload as Record<string, unknown>;
  assert.equal(payload['scenes'], undefined, '集侧面去掉了 scenes');
  assert.deepEqual(payload['sceneKeys'], [DUKO.sc11, DUKO.sc12], '场次顺序由集侧面表达');
  assert.equal(ep1?.episode, DUKO.ep1);
  assert.equal((scenes[0]?.payload as Record<string, unknown>)['index'], undefined, '场次 payload 不带位置');
  assert.deepEqual(p.covers.map((c) => c.episodes), [[...new Set(SCENE_EPISODE.values())], [...new Set(SCENE_EPISODE.values())]]);
});

test('staging 渡口：3 个地点 + 9 场站位', () => {
  const p = project('staging');
  assert.deepEqual(p.problems, []);
  assert.deepEqual(countByKind(p), { location: 3, script_scene: 9 });
  assert.ok(p.refs.filter((r) => r.role === 'read-from').every((r) => r.optional));
  const staged = p.entities.filter((e) => e.kind === 'script_scene');
  assert.ok(staged.every((e) => e.episode === SCENE_EPISODE.get(e.key)), '站位场次的集从剧本查');
  assert.ok(p.entities.filter((e) => e.kind === 'location').every((e) => e.episode === undefined), '认图跨集共用，不记集');
});

test('staging 的场次在剧本里找不到时拦下（要先导入剧本）', () => {
  const p = project('staging', loadFixture('staging'), { ...CTX, sceneEpisode: new Map() });
  assert.match(p.problems.join('\n'), new RegExp(`${DUKO.sc11}）在项目的剧本里找不到`));
});

test('storyboard 渡口：10 段 34 切，段和切都按上游 id 定键', () => {
  const p = project('storyboard');
  assert.deepEqual(p.problems, []);
  assert.deepEqual(countByKind(p), { segment: 10, cut: 34 });
  assert.equal(p.entities.find((e) => e.kind === 'cut')?.key, DUKO.cut11);
  assert.ok(p.entities.every((e) => e.episode === DUKO.ep1));
  const seg = p.entities.find((e) => e.key === DUKO.seg1)?.payload as Record<string, unknown>;
  assert.equal(seg['cuts'], undefined);
  assert.equal((seg['cutKeys'] as string[])[0], DUKO.cut11, '切的顺序由段侧面表达');
  const scene = p.refs.find((r) => r.from.key === DUKO.seg1 && r.role === 'scene');
  assert.equal(scene?.to.key, DUKO.sc11, '段按 sceneRef 指向剧本场次');
});

test('storyboard 的 sceneRef 不是合法场次 id 时拦下', () => {
  const doc = loadFixture('storyboard');
  doc.episodes[0].segments[0].sceneRef = 'E01-SC01';
  assert.match(project('storyboard', doc).problems.join('\n'), /sceneRef 不是合法的剧本场次 id：E01-SC01/);
});

test('storyboard 的段指向别的集的场次时拦下', () => {
  const doc = loadFixture('storyboard');
  doc.episodes[0].segments[0].sceneRef = DUKO.sc62;
  assert.match(project('storyboard', doc).problems.join('\n'), new RegExp(`场次 ${DUKO.sc62} 属于集 ${DUKO.ep6}，不是第1集`));
});

test('缺少必填数组字段时记问题而不是抛错', () => {
  const doc = loadFixture('script');
  delete doc.episodes;
  assert.match(project('script', doc).problems.join('\n'), /缺少数组字段 episodes/);
});

test('同一份文档里编号重复时拦下', () => {
  const doc = loadFixture('outline');
  doc.characters[1].id = 'C01';
  assert.match(project('outline', doc).problems.join('\n'), /C01 在同一份文档里出现了不止一次/);
});

test('编号格式不对时拦下', () => {
  const doc = loadFixture('script');
  doc.episodes[0].scenes[0].sceneId = 'X1';
  assert.match(project('script', doc).problems.join('\n'), /格式不对的location编号：X1/);
});

test('非对象输入一律返回问题，不抛错', () => {
  for (const stage of STAGES) {
    for (const bad of [null, [], 'x', 42]) {
      const p = project(stage, bad);
      assert.equal(p.entities.length, 0);
      assert.match(p.problems[0] ?? '', /不是对象/);
    }
  }
});

test('数组里混进非对象条目、缺编号时逐条报问题，不抛错', () => {
  const cases: [Stage, (d: any) => void, RegExp][] = [
    ['outline', (d) => d.characters.push(42), /人物表第 6 条不是对象/],
    ['outline', (d) => (d.beats[0].episodeRef = 1), /爽点 B01 的 episodeRef 不是合法的集 id：1/],
    ['outline', (d) => d.episodes.push({ ep: 7 }), /分集第 7 条缺少合法的集 id/],
    ['outline', (d) => (d.props = 'P01'), /props 应该是数组/],
    ['cast', (d) => d.characters.push('老周'), /角色卡第 5 张不是对象/],
    ['art', (d) => (d.scenes[2].variantOf = 'X'), /variantOf 格式不对/],
    ['script', (d) => d.episodes.push(null), /剧本第 7 集缺少合法的集 id/],
    ['script', (d) => d.episodes[0].scenes.push(1), /第1集（ep_mtg51p27）第 3 场缺少合法的场次 id/],
    ['staging', (d) => d.locations.push({ sceneId: 'bad' }), /站位地点第 4 条缺少合法的 sceneId/],
    ['staging', (d) => d.scenes.push({ ep: 1, scene: 3 }), /站位场次第 10 条缺少合法的 sceneRef/],
    ['storyboard', (d) => d.episodes.push({ ep: 2 }), /分镜第 2 集缺少合法的集 id/],
    ['storyboard', (d) => d.episodes[0].segments.push({ id: 'x' }), /第1集（ep_mtg51p27）第 11 段缺少合法的段 id/],
    ['storyboard', (d) => d.episodes[0].segments[0].cuts.push(null), /段 sg_x96b305w 第 5 切缺少合法的切 id/],
  ];
  for (const [stage, breakIt, expected] of cases) {
    const doc = loadFixture(stage);
    breakIt(doc);
    assert.match(project(stage, doc).problems.join('\n'), expected, `${stage}: ${expected}`);
  }
});

test('投影不改动入参', () => {
  for (const stage of STAGES) {
    const doc = loadFixture(stage);
    const before = structuredClone(doc);
    project(stage, doc);
    assert.deepEqual(doc, before, `${stage} 投影改动了入参`);
  }
});

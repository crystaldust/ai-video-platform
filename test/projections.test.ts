// 投影单测：渡口样例全部无问题、数量对得上；每条拦截规则都配一个故意改坏的反例。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntityKind, Projection, ProjectionContext, Stage } from '../src/domain/types.ts';
import { STAGES } from '../src/domain/types.ts';
import { PROJECTIONS } from '../src/import/projections/index.ts';
import { loadFixture } from './helpers.ts';

const CTX: ProjectionContext = {
  characterKeyByName: new Map([
    ['沈知微', 'C01'],
    ['陆行远', 'C02'],
    ['老周', 'C03'],
    ['胡二爷', 'C04'],
    ['岸上挑灯的更夫', 'C05'],
  ]),
  ambiguousNames: new Set(),
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

test('script 渡口：6 集 9 场，场次键按集内顺序', () => {
  const p = project('script');
  assert.deepEqual(p.problems, []);
  assert.deepEqual(countByKind(p), { episode: 6, script_scene: 9 });
  const keys = p.entities.filter((e) => e.kind === 'script_scene').map((e) => e.key);
  assert.deepEqual(keys, ['E01-SC01', 'E01-SC02', 'E02-SC01', 'E03-SC01', 'E04-SC01', 'E05-SC01', 'E05-SC02', 'E06-SC01', 'E06-SC02']);
  const ep1 = p.entities.find((e) => e.kind === 'episode' && e.key === 'E01')?.payload as Record<string, unknown>;
  assert.equal(ep1['scenes'], undefined, '集侧面去掉了 scenes');
  assert.deepEqual(ep1['sceneKeys'], ['E01-SC01', 'E01-SC02']);
});

test('staging 渡口：3 个地点 + 9 场站位', () => {
  const p = project('staging');
  assert.deepEqual(p.problems, []);
  assert.deepEqual(countByKind(p), { location: 3, script_scene: 9 });
  assert.ok(p.refs.filter((r) => r.role === 'read-from').every((r) => r.optional));
});

test('storyboard 渡口：10 段 34 个分镜，键形如 E01-01.c1', () => {
  const p = project('storyboard');
  assert.deepEqual(p.problems, []);
  assert.deepEqual(countByKind(p), { segment: 10, cut: 34 });
  assert.equal(p.entities.find((e) => e.kind === 'cut')?.key, 'E01-01.c1');
  const seg = p.entities.find((e) => e.key === 'E01-01')?.payload as Record<string, unknown>;
  assert.equal(seg['cuts'], undefined);
  assert.equal((seg['cutKeys'] as string[]).length, 4);
});

test('storyboard 的 sceneIndex 不是正整数时拦下', () => {
  const doc = loadFixture('storyboard');
  doc.episodes[0].segments[0].sceneIndex = 0;
  assert.match(project('storyboard', doc).problems.join('\n'), /sceneIndex 必须是正整数/);
});

test('storyboard 的段号不属于所在集时拦下', () => {
  const doc = loadFixture('storyboard');
  doc.episodes[0].segments[0].id = 'E02-01';
  assert.match(project('storyboard', doc).problems.join('\n'), /不属于第 1 集/);
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
    ['outline', (d) => (d.beats[0].episode = 0), /爽点 B01 的 episode 必须是正整数/],
    ['outline', (d) => d.episodes.push({ ep: 'x' }), /分集第 7 条缺少正整数 ep/],
    ['outline', (d) => (d.props = 'P01'), /props 应该是数组/],
    ['cast', (d) => d.characters.push('老周'), /角色卡第 5 张不是对象/],
    ['art', (d) => (d.scenes[2].variantOf = 'X'), /variantOf 格式不对/],
    ['script', (d) => d.episodes.push(null), /剧本第 7 集缺少正整数 ep/],
    ['script', (d) => d.episodes[0].scenes.push(1), /第 1 集第 3 场（E01-SC03）不是对象/],
    ['staging', (d) => d.locations.push({ sceneId: 'bad' }), /站位地点第 4 条缺少合法的 sceneId/],
    ['staging', (d) => d.scenes.push({ ep: 1 }), /站位场次第 10 条缺少正整数 ep \/ scene/],
    ['storyboard', (d) => d.episodes.push({}), /分镜第 2 集缺少正整数 ep/],
    ['storyboard', (d) => d.episodes[0].segments.push({ id: 'x' }), /第 1 集第 11 段缺少合法的段号/],
    ['storyboard', (d) => d.episodes[0].segments[0].cuts.push(null), /分镜 E01-01.c5不是对象/],
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

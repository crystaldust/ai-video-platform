import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importArtifact } from '../src/import/import-artifact.ts';
import { findStaleRefs, getLineage } from '../src/repo/lineage.ts';
import { DUKO, importAll, loadFixture, tempProject } from './helpers.ts';

const has = (nodes: ReturnType<typeof getLineage>, kind: string, key: string, facet: string) =>
  nodes.some((n) => n.kind === kind && n.key === key && n.facet === facet);

test('分镜切能追到段、场次、集、场景、角色、道具', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const nodes = getLineage(project.db, 'cut', DUKO.cut11);
  for (const [kind, key, facet] of [
    ['segment', DUKO.seg1, 'storyboard'],
    ['script_scene', DUKO.sc11, 'script'],
    ['episode', DUKO.ep1, 'script'],
    ['location', 'S02', 'art'],
    ['character', 'C01', 'cast'],
    ['prop', 'P01', 'art'],
  ] as const) {
    assert.ok(has(nodes, kind, key, facet), `缺 ${kind}/${key}/${facet}`);
  }
  assert.ok(nodes.every((n) => n.isCurrent), '刚导入时都是当前版本');
  assert.ok(Math.max(...nodes.map((n) => n.depth)) >= 2);
  assert.equal(nodes.find((n) => n.key === DUKO.seg1)?.depth, 1);
  cleanup();
});

test('同一版本只出现一次，取最近的一跳', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const nodes = getLineage(project.db, 'cut', DUKO.cut11);
  const ids = nodes.map((n) => n.versionId);
  assert.equal(new Set(ids).size, ids.length);
  cleanup();
});

test('maxDepth 限制追溯深度', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const nodes = getLineage(project.db, 'cut', DUKO.cut11, { maxDepth: 1 });
  assert.ok(nodes.length > 0 && nodes.every((n) => n.depth === 1));
  cleanup();
});

test('按侧面限定起点', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const fromStaging = getLineage(project.db, 'location', 'S02', { facet: 'staging' });
  assert.deepEqual(fromStaging.map((n) => [n.key, n.facet, n.role]), [['S02', 'art', 'read-from']]);
  assert.deepEqual(getLineage(project.db, 'location', 'S02', { facet: 'outline' }), []);
  cleanup();
});

test('改了角色卡后，分镜的追溯里能看到它用的是旧版', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const cast = loadFixture('cast');
  cast.characters[0].oneLiner = `${cast.characters[0].oneLiner}（改）`;
  importArtifact(project, 'cast', cast);
  const c01 = getLineage(project.db, 'cut', DUKO.cut11).find((n) => n.key === 'C01');
  assert.deepEqual([c01?.facet, c01?.v, c01?.isCurrent], ['cast', 1, false]);
  cleanup();
});

test('全量导入后没有过期引用', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  assert.deepEqual(findStaleRefs(project.db), []);
  cleanup();
});

function changeS02Art(project: Parameters<typeof importArtifact>[0]) {
  const art = loadFixture('art');
  const s02 = art.scenes.find((s: { id: string }) => s.id === 'S02');
  s02.anchors[0].desc = `${s02.anchors[0].desc}（改）`;
  importArtifact(project, 'art', art);
}

const staleLabels = (db: Parameters<typeof findStaleRefs>[0]) =>
  findStaleRefs(db).map((s) => `${s.from.kind}/${s.from.key}/${s.from.facet}:${s.role}`).sort();

test('改了 S02 的美术，过期引用恰好来自下游引用它的 3 个对象', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  changeS02Art(project);

  const stale = findStaleRefs(project.db);
  assert.ok(stale.every((s) => s.to.kind === 'location' && s.to.key === 'S02' && s.to.facet === 'art'));
  assert.ok(stale.every((s) => s.pinnedV === 1 && s.currentV === 2));
  // S03 的 variant-of 在同一份 art 里，随这次导入一起复核，不算过期
  assert.deepEqual(
    staleLabels(project.db),
    ['location/S02/staging:read-from', `script_scene/${DUKO.sc11}/script:location`, `script_scene/${DUKO.sc62}/script:location`].sort(),
  );
  cleanup();
});

test('下游重新导入（内容不变）即视为复核：过期引用消失', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  changeS02Art(project);
  importArtifact(project, 'script', loadFixture('script'));
  assert.deepEqual(staleLabels(project.db), ['location/S02/staging:read-from']);
  importArtifact(project, 'staging', loadFixture('staging'));
  assert.deepEqual(findStaleRefs(project.db), []);
  const sc = getLineage(project.db, 'script_scene', DUKO.sc11, { facet: 'script' }).filter((n) => n.key === 'S02');
  assert.deepEqual(sc.map((n) => [n.facet, n.v]), [['art', 2]], '追溯只走最新的钉版本');
  cleanup();
});

test('大纲改了人名：同一份大纲里的分集不会对自己报过期', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline']);
  const outline = loadFixture('outline');
  outline.characters[0].arc = `${outline.characters[0].arc}（改）`;
  importArtifact(project, 'outline', outline);
  assert.deepEqual(findStaleRefs(project.db), []);
  cleanup();
});

test('引用目标从大纲侧面换到角色卡侧面后，复核能清掉全部过期', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline', 'art', 'script', 'storyboard']); // 还没有角色卡：人物引用钉大纲
  importAll(project, ['cast', 'storyboard']); // 复核：人物引用改钉角色卡
  const outline = loadFixture('outline');
  outline.characters[0].arc = `${outline.characters[0].arc}（改）`;
  importArtifact(project, 'outline', outline);
  importAll(project, ['script', 'storyboard']);
  assert.deepEqual(findStaleRefs(project.db), []);
  // 只看分镜自己直接引用的人物；剧本场次那一跳钉大纲侧面是正常的
  const direct = getLineage(project.db, 'cut', DUKO.cut11, { maxDepth: 1 }).filter((n) => n.key === 'C01');
  assert.deepEqual(direct.map((n) => n.facet), ['cast'], '同一身份只认最新钉住的那个侧面');
  cleanup();
});

test('先导站位后导美术，重新导入站位会补上之前缺的可选引用', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline', 'script', 'staging']);
  assert.deepEqual(getLineage(project.db, 'location', 'S02', { facet: 'staging' }), []);
  importAll(project, ['art', 'staging']);
  const nodes = getLineage(project.db, 'location', 'S02', { facet: 'staging' });
  assert.deepEqual(nodes.map((n) => [n.key, n.facet, n.role]), [['S02', 'art', 'read-from']]);
  cleanup();
});

test('不存在的对象追溯为空', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  assert.deepEqual(getLineage(project.db, 'cut', 'ct_zzzzzzzz'), []);
  cleanup();
});

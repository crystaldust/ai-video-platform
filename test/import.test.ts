import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImportError, importArtifact } from '../src/import/import-artifact.ts';
import { countArtifacts } from '../src/repo/artifacts.ts';
import { currentVersion, listVersions } from '../src/repo/entities.ts';
import { findStaleRefs } from '../src/repo/lineage.ts';
import { importAll, loadFixture, tempProject } from './helpers.ts';

const refTargets = (db: import('node:sqlite').DatabaseSync, fromVersionId: number, role: string) =>
  db
    .prepare(
      `SELECT e.kind, e.key, ev.facet, ev.v FROM ref r JOIN entity_version ev ON ev.id = r.to_version_id
       JOIN entity e ON e.id = ev.entity_id WHERE r.from_version_id = ? AND r.role = ? ORDER BY e.key`,
    )
    .all(fromVersionId, role)
    .map((x) => ({ ...x }));

test('渡口 6 个阶段全量导入，每阶段都是产物 v1', () => {
  const { project, cleanup } = tempProject();
  const results = importAll(project);
  assert.deepEqual(results.map((r) => [r.stage, r.artifactV, r.unchanged]), [
    ['outline', 1, false],
    ['cast', 1, false],
    ['art', 1, false],
    ['script', 1, false],
    ['staging', 1, false],
    ['storyboard', 1, false],
  ]);
  const counts = project.db.prepare('SELECT kind, COUNT(*) AS n FROM entity GROUP BY kind ORDER BY kind').all();
  assert.deepEqual(Object.fromEntries(counts.map((r) => [r['kind'], r['n']])), {
    beat: 4,
    character: 5,
    cut: 34,
    episode: 6,
    location: 3,
    prop: 2,
    script_scene: 9,
    segment: 10,
  });
  cleanup();
});

test('同一份产物重复导入不产生新版本', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const again = importArtifact(project, 'script', loadFixture('script'));
  assert.equal(again.unchanged, true);
  assert.equal(countArtifacts(project.db, 'script'), 1);
  assert.equal(listVersions(project.db, 'script_scene', 'E01-SC01', 'script').length, 1);
  cleanup();
});

test('改一句台词只让那一场长出 v2，其余场次不动', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const doc = loadFixture('script');
  const beat = doc.episodes[0].scenes[0].flow.find((b: { line?: string }) => typeof b.line === 'string');
  beat.line = `${beat.line}（改）`;
  const result = importArtifact(project, 'script', doc);
  assert.deepEqual([result.artifactV, result.created], [2, 1]);
  assert.equal(currentVersion(project.db, 'script_scene', 'E01-SC01', 'script')?.v, 2);
  assert.equal(currentVersion(project.db, 'script_scene', 'E01-SC02', 'script')?.v, 1);
  cleanup();
});

test('新版本的引用钉在被引用方当时的当前版本上', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const sc = currentVersion(project.db, 'script_scene', 'E01-SC01', 'script');
  assert.ok(sc);
  assert.deepEqual(refTargets(project.db, sc.id, 'location'), [{ kind: 'location', key: 'S02', facet: 'art', v: 1 }]);
  assert.deepEqual(
    refTargets(project.db, sc.id, 'cast').map((x) => x['key']),
    ['C01', 'C03', 'C04'],
  );
  cleanup();
});

test('引用了不存在的场景时整体回滚，并点名', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline', 'cast', 'art']);
  const doc = loadFixture('script');
  doc.episodes[1].scenes[0].sceneId = 'S09';
  assert.throws(
    () => importArtifact(project, 'script', doc),
    (e: unknown) => e instanceof ImportError && e.problems.some((p) => p.includes('S09')),
  );
  assert.equal(countArtifacts(project.db, 'script'), 0);
  assert.equal(currentVersion(project.db, 'script_scene', 'E01-SC01', 'script'), null, '其他场次也没有写进去');
  cleanup();
});

test('没导入 cast 时，分镜的人物引用回退到大纲侧面', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline', 'art', 'script', 'storyboard']);
  const cut = currentVersion(project.db, 'cut', 'E01-01.c1', 'storyboard');
  assert.ok(cut);
  assert.deepEqual(refTargets(project.db, cut.id, 'cast'), [{ kind: 'character', key: 'C01', facet: 'outline', v: 1 }]);
  assert.deepEqual(refTargets(project.db, cut.id, 'prop'), [{ kind: 'prop', key: 'P01', facet: 'art', v: 1 }]);
  cleanup();
});

test('没导入 staging 时，段的站位引用直接跳过', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline', 'art', 'script', 'storyboard']);
  const seg = currentVersion(project.db, 'segment', 'E01-01', 'storyboard');
  assert.ok(seg);
  assert.deepEqual(refTargets(project.db, seg.id, 'staging'), []);
  assert.equal(refTargets(project.db, seg.id, 'scene').length, 1);
  cleanup();
});

test('空项目先导入 cast 会被拒绝：大纲里找不到这些人', () => {
  const { project, cleanup } = tempProject();
  assert.throws(
    () => importArtifact(project, 'cast', loadFixture('cast')),
    (e: unknown) => e instanceof ImportError && e.problems.length === 4,
  );
  assert.equal(countArtifacts(project.db, 'cast'), 0);
  cleanup();
});

test('投影问题在写库之前就拦下', () => {
  const { project, cleanup } = tempProject();
  assert.throws(() => importArtifact(project, 'outline', null), ImportError);
  assert.equal(countArtifacts(project.db, 'outline'), 0);
  cleanup();
});

test('剧本删掉一场：那一场退役，引用它的段报过期', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const doc = loadFixture('script');
  doc.episodes[0].scenes.pop();
  const result = importArtifact(project, 'script', doc);
  assert.equal(result.retired, 1);
  assert.equal(currentVersion(project.db, 'script_scene', 'E01-SC02', 'script'), null);
  const versions = listVersions(project.db, 'script_scene', 'E01-SC02', 'script');
  assert.deepEqual(versions.map((v) => [v.v, v.retired]), [[1, false], [2, true]]);
  const stale = findStaleRefs(project.db).filter((s) => s.to.key === 'E01-SC02');
  assert.ok(stale.some((s) => s.from.kind === 'segment' && s.role === 'scene'), '引用被删场次的段要报出来');
  cleanup();
});

test('引用了已退役场次的分镜不能原样重新导入', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const doc = loadFixture('script');
  doc.episodes[0].scenes.pop();
  importArtifact(project, 'script', doc);
  assert.throws(
    () => importArtifact(project, 'storyboard', loadFixture('storyboard')),
    (e: unknown) => e instanceof ImportError && e.problems.some((p) => p.includes('E01-SC02')),
  );
  cleanup();
});

test('删掉的场次恢复后长出新的有效版本', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline', 'art', 'script']);
  const doc = loadFixture('script');
  doc.episodes[0].scenes.pop();
  importArtifact(project, 'script', doc);
  importArtifact(project, 'script', loadFixture('script'));
  assert.equal(currentVersion(project.db, 'script_scene', 'E01-SC02', 'script')?.v, 3);
  cleanup();
});

test('只含部分集的剧本批次不会让其他集退役', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline', 'art', 'script']);
  const batch = loadFixture('script');
  batch.episodes = batch.episodes.filter((e: { ep: number }) => e.ep === 1);
  batch.episodes[0].scenes[0].flow[0].action = '改过的开场动作。';
  const result = importArtifact(project, 'script', batch);
  assert.equal(result.retired, 0);
  assert.equal(currentVersion(project.db, 'script_scene', 'E06-SC02', 'script')?.v, 1);
  assert.equal(currentVersion(project.db, 'episode', 'E06', 'script')?.v, 1);
  cleanup();
});

test('显示名以大纲为准，美术和站位不覆盖', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline']);
  const art = loadFixture('art');
  art.scenes[0].name = '美术里的另一个叫法';
  importAll(project, ['art']);
  importArtifact(project, 'art', art);
  const row = project.db.prepare(`SELECT title FROM entity WHERE kind = 'location' AND key = ?`).get(art.scenes[0].id) as { title: string };
  assert.equal(row.title, loadFixture('outline').scenes.find((s: { id: string }) => s.id === art.scenes[0].id).name);
  cleanup();
});

test('未知阶段在库函数层也拦下', () => {
  const { project, cleanup } = tempProject();
  assert.throws(() => importArtifact(project, 'novel' as never, {}), /不认识的阶段/);
  cleanup();
});

test('引用计数只数真正写入的', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline']);
  const again = importArtifact(project, 'outline', loadFixture('outline'));
  assert.deepEqual([again.unchanged, again.refs], [true, 0]);
  cleanup();
});

test('产物原文按原样保存（保留键顺序），去重仍按内容', () => {
  const { project, cleanup } = tempProject();
  const doc = loadFixture('outline');
  importArtifact(project, 'outline', doc);
  const row = project.db.prepare('SELECT doc FROM artifact_version').get() as { doc: string };
  assert.equal(row.doc, JSON.stringify(doc));
  const reordered = Object.fromEntries(Object.entries(doc).reverse());
  assert.equal(importArtifact(project, 'outline', reordered).unchanged, true, '只是键序不同，不算新版本');
  cleanup();
});

test('记录 skill 与源文件路径', () => {
  const { project, cleanup } = tempProject();
  importArtifact(project, 'outline', loadFixture('outline'), { skill: 'novel-outline@1.0.0', sourcePath: '/x/渡口-outline.json' });
  const row = project.db.prepare('SELECT skill, source_path FROM artifact_version').get();
  assert.deepEqual({ ...row }, { skill: 'novel-outline@1.0.0', source_path: '/x/渡口-outline.json' });
  cleanup();
});

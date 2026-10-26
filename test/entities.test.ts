import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendArtifactVersion, countArtifacts } from '../src/repo/artifacts.ts';
import {
  appendEntityVersion,
  characterKeyIndex,
  countRefsFrom,
  currentVersion,
  ensureEntity,
  insertRef,
  listVersions,
  retireEntityVersion,
} from '../src/repo/entities.ts';
import { tempProject } from './helpers.ts';

test('同样内容追加两次只有 v1；改内容出现 v2，v1 仍可读', () => {
  const { project, cleanup } = tempProject();
  const { db } = project;
  const id = ensureEntity(db, 'character', 'C01', '沈知微');
  const first = appendEntityVersion(db, { entityId: id, facet: 'outline', payload: { name: '沈知微', tier: 'lead' }, artifactVersionId: null });
  const again = appendEntityVersion(db, { entityId: id, facet: 'outline', payload: { tier: 'lead', name: '沈知微' }, artifactVersionId: null });
  assert.deepEqual([first.v, first.created, again.v, again.created], [1, true, 1, false]);

  const second = appendEntityVersion(db, { entityId: id, facet: 'outline', payload: { name: '沈知微', tier: 'support' }, artifactVersionId: null });
  assert.equal(second.v, 2);
  const versions = listVersions(db, 'character', 'C01', 'outline');
  assert.deepEqual(versions.map((x) => x.v), [1, 2]);
  assert.deepEqual(versions[0]?.payload, { name: '沈知微', tier: 'lead' });
  assert.equal(currentVersion(db, 'character', 'C01', 'outline')?.v, 2);
  cleanup();
});

test('不同侧面的版本号各自独立', () => {
  const { project, cleanup } = tempProject();
  const { db } = project;
  const id = ensureEntity(db, 'location', 'S01', '渡船船舱');
  appendEntityVersion(db, { entityId: id, facet: 'outline', payload: { a: 1 }, artifactVersionId: null });
  appendEntityVersion(db, { entityId: id, facet: 'outline', payload: { a: 2 }, artifactVersionId: null });
  const art = appendEntityVersion(db, { entityId: id, facet: 'art', payload: { a: 1 }, artifactVersionId: null });
  assert.equal(art.v, 1);
  assert.equal(listVersions(db, 'location', 'S01').length, 3);
  assert.equal(currentVersion(db, 'location', 'S01', 'staging'), null);
  cleanup();
});

test('ensureEntity 幂等；只有权威来源能改已有的显示名，空名谁都能补', () => {
  const { project, cleanup } = tempProject();
  const { db } = project;
  const a = ensureEntity(db, 'prop', 'P01', '');
  const b = ensureEntity(db, 'prop', 'P01', '皮箱');
  ensureEntity(db, 'prop', 'P01', '美术叫法');
  assert.equal(a, b);
  assert.equal(currentVersion(db, 'prop', 'P01', 'outline'), null);
  appendEntityVersion(db, { entityId: a, facet: 'outline', payload: {}, artifactVersionId: null });
  assert.equal(listVersions(db, 'prop', 'P01')[0]?.title, '皮箱');
  ensureEntity(db, 'prop', 'P01', '旧皮箱', true);
  assert.equal(listVersions(db, 'prop', 'P01')[0]?.title, '旧皮箱');
  cleanup();
});

test('产物版本按阶段只追加，内容相同时标 unchanged', () => {
  const { project, cleanup } = tempProject();
  const { db } = project;
  const v1 = appendArtifactVersion(db, { stage: 'outline', doc: { a: 1 } });
  const same = appendArtifactVersion(db, { stage: 'outline', doc: { a: 1 } });
  const v2 = appendArtifactVersion(db, { stage: 'outline', doc: { a: 2 }, skill: 'novel-outline@1', sourcePath: 'x.json' });
  const other = appendArtifactVersion(db, { stage: 'script', doc: { a: 1 } });
  assert.deepEqual([v1.v, same.unchanged, v2.v, other.v], [1, true, 2, 1]);
  assert.equal(countArtifacts(db, 'outline'), 2);
  cleanup();
});

test('引用重复插入只记一条；人名索引来自大纲侧面', () => {
  const { project, cleanup } = tempProject();
  const { db } = project;
  const c = ensureEntity(db, 'character', 'C01', '沈知微');
  const cv = appendEntityVersion(db, { entityId: c, facet: 'outline', payload: { name: '沈知微' }, artifactVersionId: null });
  const s = ensureEntity(db, 'script_scene', 'E01-SC01', '');
  const sv = appendEntityVersion(db, { entityId: s, facet: 'script', payload: {}, artifactVersionId: null });
  insertRef(db, sv.id, 'cast', cv.id);
  insertRef(db, sv.id, 'cast', cv.id);
  assert.equal(countRefsFrom(db, sv.id), 1);
  assert.deepEqual([...characterKeyIndex(db).byName], [['沈知微', 'C01']]);
  cleanup();
});

test('大纲重名人物进歧义名单，不进人名索引', () => {
  const { project, cleanup } = tempProject();
  const { db } = project;
  for (const key of ['C01', 'C02']) {
    const id = ensureEntity(db, 'character', key, '更夫');
    appendEntityVersion(db, { entityId: id, facet: 'outline', payload: { name: '更夫' }, artifactVersionId: null });
  }
  const index = characterKeyIndex(db);
  assert.deepEqual([[...index.byName], [...index.ambiguous]], [[], ['更夫']]);
  cleanup();
});

test('退役后当前版本视为没有；内容恢复时长出新版本', () => {
  const { project, cleanup } = tempProject();
  const { db } = project;
  const id = ensureEntity(db, 'prop', 'P01', '皮箱');
  appendEntityVersion(db, { entityId: id, facet: 'art', payload: { a: 1 }, artifactVersionId: null });
  retireEntityVersion(db, id, 'art', null);
  assert.equal(currentVersion(db, 'prop', 'P01', 'art'), null);
  const back = appendEntityVersion(db, { entityId: id, facet: 'art', payload: { a: 1 }, artifactVersionId: null });
  assert.deepEqual([back.v, back.created], [3, true]);
  cleanup();
});

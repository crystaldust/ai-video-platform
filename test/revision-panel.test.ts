// 全貌上没落实的打回：「带同样意见再打回」的请求体、「放弃」的路径与提示语。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dismissPath, repeatRejectBody, revisionLabel } from '../web/src/revision.ts';

const rev = { id: 7, note: '汽笛提前', episode: 'ep_aaaaaaaa', ep: 3 };

test('带同样意见再打回：阶段、意见原样带上；意见只针对一集时带那一集，整个阶段不带 episode', () => {
  assert.deepEqual(repeatRejectBody('script', rev), { stage: 'script', note: '汽笛提前', episode: 'ep_aaaaaaaa' });
  assert.deepEqual(repeatRejectBody('script', { ...rev, episode: null, ep: null }), { stage: 'script', note: '汽笛提前' });
});

test('放弃的接口路径带编号；说明里点名是哪一集的哪个阶段', () => {
  assert.equal(dismissPath(7), '/revisions/7/dismiss');
  assert.equal(revisionLabel('script', rev), '第 03 集的剧本');
  assert.equal(revisionLabel('staging', { ...rev, episode: null, ep: null }), '站位');
});

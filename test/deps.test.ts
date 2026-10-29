// 阶段依赖图：分层、下游、环检测。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downstreamOf, layers, STAGE_DEPS } from '../src/orchestrate/deps.ts';

test('六个文本阶段分四层：角色、美术、剧本同层并发', () => {
  assert.deepEqual(layers(), [['outline'], ['cast', 'art', 'script'], ['staging'], ['storyboard']]);
});

test('只排给定的阶段，不在里面的上游视为已就绪', () => {
  assert.deepEqual(layers(['storyboard', 'staging']), [['staging'], ['storyboard']]);
  assert.deepEqual(layers(['cast', 'storyboard']), [['cast', 'storyboard']]);
});

test('下游：剧本没过阻断站位和分镜；角色卡不阻断任何阶段', () => {
  assert.deepEqual(downstreamOf('script'), ['staging', 'storyboard']);
  assert.deepEqual(downstreamOf('outline'), ['cast', 'art', 'script', 'staging', 'storyboard']);
  assert.deepEqual(downstreamOf('cast'), []);
  assert.deepEqual(downstreamOf('art'), ['staging', 'storyboard']);
});

test('依赖有环时报错', () => {
  const cyclic = { ...STAGE_DEPS, outline: { needs: ['storyboard' as const], optional: [] } };
  assert.throws(() => layers(undefined, cyclic), /阶段依赖有环/);
});

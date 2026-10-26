import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_PATTERNS, cutKey, episodeKey, isValidKey, scriptSceneKey } from '../src/domain/keys.ts';
import { ENTITY_KINDS } from '../src/domain/types.ts';

test('集号补齐两位，100 集以上原样', () => {
  assert.equal(episodeKey(1), 'E01');
  assert.equal(episodeKey(12), 'E12');
  assert.equal(episodeKey(123), 'E123');
});

test('剧本场次键 = 集 + 两位场序', () => {
  assert.equal(scriptSceneKey(1, 2), 'E01-SC02');
});

test('分镜键 = 段号 + 段内序号', () => {
  assert.equal(cutKey('E01-01', 1), 'E01-01.c1');
});

test('非正整数的集号、场序、分镜序号都拦下', () => {
  assert.throws(() => episodeKey(0), /集号必须是正整数/);
  assert.throws(() => episodeKey('1'), /集号必须是正整数/);
  assert.throws(() => scriptSceneKey(1, 1.5), /场次序号必须是正整数/);
  assert.throws(() => cutKey('E01-01', 0), /分镜序号必须是正整数/);
});

test('段号格式不对时分镜键拒绝生成', () => {
  assert.throws(() => cutKey('E1-1', 1), /段号格式不对/);
});

test('每个 kind 都有正则，合法键通过、非法键不通过', () => {
  const samples = {
    episode: ['E01', 'E1'],
    character: ['C01', 'C1'],
    location: ['S01', 'X01'],
    prop: ['P01', 'P'],
    beat: ['B01', 'b01'],
    script_scene: ['E01-SC01', 'E01-S01'],
    segment: ['E01-01', 'E01-1'],
    cut: ['E01-01.c1', 'E01-01.c'],
  } as const;
  for (const kind of ENTITY_KINDS) {
    assert.ok(KEY_PATTERNS[kind], `${kind} 缺正则`);
    const [good, bad] = samples[kind];
    assert.equal(isValidKey(kind, good), true, `${kind} 应接受 ${good}`);
    assert.equal(isValidKey(kind, bad), false, `${kind} 应拒绝 ${bad}`);
  }
  assert.equal(isValidKey('character', 1), false, '非字符串不通过');
});

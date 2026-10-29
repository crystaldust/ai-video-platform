import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_PATTERNS, isValidKey } from '../src/domain/keys.ts';
import { ENTITY_KINDS } from '../src/domain/types.ts';

test('每个 kind 都有正则，合法键通过、非法键不通过', () => {
  const samples = {
    episode: ['ep_mtg51p27', 'E01'],
    character: ['C01', 'C1'],
    location: ['S01', 'X01'],
    prop: ['P01', 'P'],
    beat: ['B01', 'b01'],
    script_scene: ['sc_x3xq2c82', 'E01-SC01'],
    segment: ['sg_x96b305w', 'E01-01'],
    cut: ['ct_dfg1t316', 'E01-01.c1'],
  } as const;
  for (const kind of ENTITY_KINDS) {
    assert.ok(KEY_PATTERNS[kind], `${kind} 缺正则`);
    const [good, bad] = samples[kind];
    assert.equal(isValidKey(kind, good), true, `${kind} 应接受 ${good}`);
    assert.equal(isValidKey(kind, bad), false, `${kind} 应拒绝 ${bad}`);
  }
  assert.equal(isValidKey('character', 1), false, '非字符串不通过');
});

test('稳定 id 只认对应前缀、8 位 Crockford base32（无 i l o u、全小写）', () => {
  assert.equal(isValidKey('episode', 'sc_x3xq2c82'), false, '前缀不对');
  assert.equal(isValidKey('episode', 'ep_mtg51p2'), false, '少一位');
  assert.equal(isValidKey('episode', 'ep_mtg51p277'), false, '多一位');
  for (const ch of ['i', 'l', 'o', 'u', 'M']) {
    assert.equal(isValidKey('cut', `ct_dfg1t31${ch}`), false, `不该接受 ${ch}`);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, contentHash, sha256 } from '../src/domain/hash.ts';

test('键序不同、内容相同的对象哈希相同', () => {
  assert.equal(contentHash({ a: 1, b: [1, 2], c: { y: 1, x: 2 } }), contentHash({ c: { x: 2, y: 1 }, b: [1, 2], a: 1 }));
});

test('数组顺序不同则哈希不同', () => {
  assert.notEqual(contentHash([1, 2]), contentHash([2, 1]));
});

test('undefined 字段被丢弃，与没有这个字段等价', () => {
  assert.equal(contentHash({ a: 1, b: undefined }), contentHash({ a: 1 }));
});

test('数组里的 undefined 按 JSON 规则变成 null', () => {
  assert.equal(canonicalJson([1, undefined]), '[1,null]');
});

test('标量与 null 也能算指纹', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson('渡口'), '"渡口"');
});

test('sha256 输出 64 位十六进制', () => {
  assert.match(sha256('x'), /^[0-9a-f]{64}$/);
});

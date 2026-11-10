// 需复核原因写明变了哪些字段（backlog #38）：字段差异、上游名字、原因写法。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedFields, entityName } from '../src/domain/reads.ts';
import { staleReasonText } from '../src/server/views/common.ts';

test('changedFields：顶层键不同的才记下，查不到中文名的原样写键名，b 的键在前', () => {
  assert.deepEqual(changedFields({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }), ['b', 'c']);
  assert.deepEqual(changedFields({ a: 1, gone: 2 }, { a: 1 }), ['gone']);
});

test('changedFields：两边都是对象时下一层，人设里的外貌写成「外貌」', () => {
  const a = { name: '沈知微', persona: { gender: '女', appearance: '清瘦' } };
  const b = { name: '沈知微', persona: { gender: '女', appearance: '左眉一道新疤' } };
  assert.deepEqual(changedFields(a, b), ['外貌']);
});

test('changedFields：数组整体比，别名加一项写「别名」；只下一层', () => {
  assert.deepEqual(changedFields({ aliases: ['知微'] }, { aliases: ['知微', '沈家姑娘'] }), ['别名']);
  assert.deepEqual(changedFields({ persona: { x: { y: 1 } } }, { persona: { x: { y: 2 } } }), ['x']);
});

test('changedFields：同名中文去重；不都是对象时返回空', () => {
  assert.deepEqual(changedFields({ props: [1], propIds: [1] }, { props: [2], propIds: [2] }), ['道具']);
  assert.deepEqual(changedFields('a', 'b'), []);
  assert.deepEqual(changedFields(null, { a: 1 }), []);
  assert.deepEqual(changedFields([1], [2]), []);
});

test('changedFields：不改入参', () => {
  const a = Object.freeze({ persona: Object.freeze({ appearance: '1' }) });
  const b = Object.freeze({ persona: Object.freeze({ appearance: '2' }) });
  assert.deepEqual(changedFields(a, b), ['外貌']);
});

test('entityName：有名字用名字，集写「第 N 集」，否则 null', () => {
  assert.equal(entityName({ name: '沈知微' }), '沈知微');
  assert.equal(entityName({ ep: 3, synopsis: '…' }), '第 3 集');
  assert.equal(entityName({ name: '' }), null);
  assert.equal(entityName({}), null);
  assert.equal(entityName(null), null);
});

const ref = (over: Partial<Parameters<typeof staleReasonText>[0]>): Parameters<typeof staleReasonText>[0] => ({
  to: { kind: 'character', key: 'C01', facet: 'cast' },
  toName: '沈知微',
  changed: ['外貌', '别名'],
  retired: false,
  pinnedV: 3,
  currentV: 4,
  ...over,
});

test('staleReasonText：名字 · 阶段：字段（版本）', () => {
  assert.equal(staleReasonText(ref({})), '沈知微 · 角色：外貌、别名（v3 → v4）');
});

test('staleReasonText：超过 3 个字段写「等 N 项」', () => {
  assert.equal(staleReasonText(ref({ changed: ['外貌', '别名', '身份', '性别', '年龄段'] })), '沈知微 · 角色：外貌、别名、身份等 5 项（v3 → v4）');
  assert.equal(staleReasonText(ref({ changed: ['外貌', '别名', '身份'] })), '沈知微 · 角色：外貌、别名、身份（v3 → v4）');
});

test('staleReasonText：已删除不写版本号', () => {
  assert.equal(staleReasonText(ref({ retired: true, changed: [] })), '沈知微 · 角色：已删除');
});

test('staleReasonText：没名字用编号，没字段写「内容有变」', () => {
  assert.equal(staleReasonText(ref({ toName: null, changed: [], pinnedV: 1, currentV: 2 })), 'C01 · 角色：内容有变（v1 → v2）');
});

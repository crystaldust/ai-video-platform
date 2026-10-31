// 「重跑」的整份重写选项：不勾就照旧只带 only，勾了先确认再带 fresh。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rerunRequest } from '../web/src/rerun.ts';

test('不勾整份重写：不用确认，请求体只有 only', () => {
  assert.deepEqual(rerunRequest('script', false), { confirm: null, body: { only: 'script' } });
});

test('勾了整份重写：先确认并点名阶段，请求体带 fresh', () => {
  const r = rerunRequest('storyboard', true);
  assert.deepEqual(r.body, { only: 'storyboard', fresh: true });
  assert.equal(r.confirm, '会把分镜全部集从头重写，不沿用之前已写好、已过门的集。确定？');
});

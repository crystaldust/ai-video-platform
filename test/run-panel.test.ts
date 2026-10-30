// 「正在进行」面板每次尝试的状态：库里一开调就插了尝试行（violations 是 []、ended_at 为空），没结束的不能显示成「通过」。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attemptState, callNo } from '../web/src/format.ts';

test('还没结束的尝试是进行中，不是通过', () => {
  assert.equal(attemptState({ violations: [], endedAt: null }), 'running');
});

test('结束且没有违规的是通过，有违规的是没过', () => {
  assert.equal(attemptState({ violations: [], endedAt: '2026-10-30T07:44:02.890Z' }), 'ok');
  assert.equal(attemptState({ violations: ['E14-05#1 台词装不进'], endedAt: '2026-10-30T07:44:02.890Z' }), 'err');
});

test('第几次调用：正在调的那次库里已有行就不再加一', () => {
  const done = { violations: [], endedAt: '2026-10-30T07:44:02.890Z' };
  assert.equal(callNo([]), 1);
  assert.equal(callNo([done]), 2);
  assert.equal(callNo([done, { violations: [], endedAt: null }]), 2);
});

// 全貌下半部分的「分集全貌 / 运行记录」两个 tab：默认跟着有没有任务在跑，手动点过就听人的。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overviewTab, sidePanel } from '../web/src/overview-tabs.ts';

test('没点过：运行中看运行记录，空闲看分集全貌', () => {
  assert.equal(overviewTab(null, true), 'log');
  assert.equal(overviewTab(null, false), 'episodes');
});

test('点过就听人的，运行中也能切去看分集', () => {
  assert.equal(overviewTab('episodes', true), 'episodes');
  assert.equal(overviewTab('log', false), 'log');
});

test('右侧：运行记录且在跑时是「正在进行」，其余都是详情面板', () => {
  assert.equal(sidePanel('log', true), 'current');
  assert.equal(sidePanel('log', false), 'detail');
  assert.equal(sidePanel('episodes', true), 'detail');
});

// 编排、付费确认单、打回与复核确认的读写。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db/connection.ts';
import { failInterruptedOrchestrations, finishOrchestration, getOrchestration, listOrchestrations, startOrchestration } from '../src/repo/orchestrations.ts';
import { createPaidGate, decidePaidGate, listPaidGates } from '../src/repo/paid-gates.ts';
import { addReviewAck, addRevisionRequest, cellKey, latestReviewAcks } from '../src/repo/revisions.ts';
import type { ProjectEstimate } from '../src/estimate/estimate.ts';

const ESTIMATE = { preset: 'budget', nodes: [], total: { low: 1, high: 2 }, incomplete: false, currency: 'USD', fx: { CNY: 7.1 }, note: '' } as unknown as ProjectEstimate;

test('同一时刻只允许一条 running 的编排；结束后可以再开', () => {
  const db = openDb(':memory:');
  const id = startOrchestration(db, 'all');
  assert.throws(() => startOrchestration(db, 'only-stale'), /已有编排在运行（orchestration 1）/);
  finishOrchestration(db, id, 'done', { stages: [] });
  assert.equal(getOrchestration(db, id)?.status, 'done');
  assert.deepEqual(getOrchestration(db, id)?.summary, { stages: [] });
  assert.equal(startOrchestration(db, 'single'), 2);
  assert.equal(listOrchestrations(db).length, 2);
  db.close();
});

test('进程中断的编排标为失败；本进程登记在跑的不动', () => {
  const db = openDb(':memory:');
  const a = startOrchestration(db, 'all');
  assert.equal(failInterruptedOrchestrations(db, (id) => id === a), 0);
  assert.equal(failInterruptedOrchestrations(db, () => false), 1);
  assert.equal(getOrchestration(db, a)?.status, 'failed');
  assert.deepEqual(getOrchestration(db, a)?.summary, { error: '进程中断' });
  db.close();
});

test('新的付费确认单作废之前还在等确认的旧单', () => {
  const db = openDb(':memory:');
  const first = createPaidGate(db, { orchestrationId: null, estimate: ESTIMATE });
  assert.equal(first.status, 'awaiting_confirmation');
  assert.equal(first.currency, 'USD');
  createPaidGate(db, { orchestrationId: null, estimate: ESTIMATE });
  assert.deepEqual(listPaidGates(db).map((g) => g.status), ['cancelled', 'awaiting_confirmation']);
  assert.deepEqual(listPaidGates(db)[1]!.estimate.total, { low: 1, high: 2 });
  db.close();
});

test('打回意见与复核确认：同一格取最新一条', () => {
  const db = openDb(':memory:');
  const r = addRevisionRequest(db, { stage: 'script', episodeKey: 'ep_aaaaaaaa', note: '汽笛提前', baseArtifactVersionId: null });
  assert.equal(r.note, '汽笛提前');
  addReviewAck(db, { stage: 'staging', episodeKey: 'ep_aaaaaaaa', snapshot: { 'script_scene/sc_x/script': 1 }, note: '' });
  addReviewAck(db, { stage: 'staging', episodeKey: 'ep_aaaaaaaa', snapshot: { 'script_scene/sc_x/script': 2 }, note: '看过了' });
  const acks = latestReviewAcks(db);
  assert.equal(acks.size, 1);
  assert.deepEqual(acks.get(cellKey('staging', 'ep_aaaaaaaa'))?.snapshot, { 'script_scene/sc_x/script': 2 });
  db.close();
});

test('付费确认单：确认写入勾选与上限，定了就不能再改；上限要是正数', () => {
  const db = openDb(':memory:');
  const g = createPaidGate(db, { orchestrationId: null, estimate: ESTIMATE });
  assert.throws(() => decidePaidGate(db, g.id, { status: 'confirmed', budgetCap: -1 }), /单次上限要是正数/);
  const done = decidePaidGate(db, g.id, { status: 'confirmed', selection: { 'video:segment': ['ep_a'] }, budgetCap: 50, currency: 'CNY' });
  assert.equal(done.status, 'confirmed');
  assert.deepEqual(done.selection, { 'video:segment': ['ep_a'] });
  assert.equal(done.budgetCap, 50);
  assert.equal(done.currency, 'CNY');
  assert.throws(() => decidePaidGate(db, g.id, { status: 'cancelled' }), /已经是 confirmed/);
  assert.throws(() => decidePaidGate(db, 99, { status: 'cancelled' }), /没有这张/);
  db.close();
});

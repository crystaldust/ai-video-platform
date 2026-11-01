// 付费任务与候选的读写：提交前先落库（planned → submitting 是原子的），每次转移都留事件，非法转移、重复的供应商 id 都拒绝。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addMediaFile } from '../src/repo/media.ts';
import { currentVersion } from '../src/repo/entities.ts';
import { addCandidate, candidatesOf, nextLabel } from '../src/repo/candidates.ts';
import { createTask, getTask, listTasks, markSubmitting, recordProviderId, taskEvents, transition } from '../src/repo/tasks.ts';
import { DUKO, importAll, tempProject } from './helpers.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function setup() {
  const t = tempProject();
  importAll(t.project);
  const version = currentVersion(t.project.db, 'segment', DUKO.seg1, 'storyboard')!;
  const input = {
    targetVersionId: version.id,
    capability: 'video' as const,
    provider: 'minimax',
    model: 'MiniMax-H3-Lite',
    node: 'video:segment' as const,
    episodeKey: DUKO.ep1,
    label: DUKO.seg1,
    plannedInput: { prompt: 'p', refs: ['sha-a'] },
    costEstimate: 0.71,
    currency: 'CNY',
    paidGateId: null,
  };
  return { ...t, version, input };
}

test('建任务：planned，记计划输入与指纹；指纹只看计划输入', () => {
  const { project, input, cleanup } = setup();
  const a = createTask(project.db, input);
  assert.equal(a.status, 'planned');
  assert.deepEqual(a.plannedInput, input.plannedInput);
  assert.match(a.contentFingerprint ?? '', /^[0-9a-f]{64}$/);
  const b = createTask(project.db, { ...input, label: 'other' });
  assert.equal(b.contentFingerprint, a.contentFingerprint);
  assert.deepEqual(taskEvents(project.db, a.id).map((e) => e.status), ['planned']);
  cleanup();
});

test('提交前落库：planned → submitting 原子地记下进程号与时间；已经不是 planned 就拒绝（防两个进程重复提交）', () => {
  const { project, input, cleanup } = setup();
  const t = createTask(project.db, input);
  const s = markSubmitting(project.db, t.id, 4242);
  assert.equal(s.status, 'submitting');
  assert.equal(s.pid, 4242);
  assert.ok(s.submittedAt);
  assert.throws(() => markSubmitting(project.db, t.id, 4242), /不是 planned/);
  cleanup();
});

test('记下供应商 id → submitted；同一供应商 id 不能记在两条任务上', () => {
  const { project, input, cleanup } = setup();
  const a = createTask(project.db, input);
  markSubmitting(project.db, a.id, 1);
  const got = recordProviderId(project.db, a.id, 'mm-1', { model: 'MiniMax-H3-Lite', duration: 6 });
  assert.equal(got.status, 'submitted');
  assert.equal(got.providerTaskId, 'mm-1');
  assert.deepEqual(got.actualInput, { model: 'MiniMax-H3-Lite', duration: 6 });
  const b = createTask(project.db, input);
  markSubmitting(project.db, b.id, 1);
  assert.throws(() => recordProviderId(project.db, b.id, 'mm-1'), /已经记在任务 \d+ 上/);
  cleanup();
});

test('转移：合法的写状态、补字段、留事件；非法的拒绝且不改库', () => {
  const { project, input, cleanup } = setup();
  const t = createTask(project.db, input);
  markSubmitting(project.db, t.id, 1);
  recordProviderId(project.db, t.id, 'mm-2');
  transition(project.db, t.id, 'running', { providerStatus: 'running' });
  const done = transition(project.db, t.id, 'succeeded', { providerStatus: 'succeeded', resultUrl: 'https://x/y.mp4', costActual: 0.6 }, { seconds: 6 });
  assert.equal(done.resultUrl, 'https://x/y.mp4');
  assert.equal(done.costActual, 0.6);
  assert.throws(() => transition(project.db, t.id, 'planned'), /不能从 succeeded 变成 planned/);
  assert.equal(getTask(project.db, t.id)!.status, 'succeeded');
  const events = taskEvents(project.db, t.id);
  assert.deepEqual(events.map((e) => e.status), ['planned', 'submitting', 'submitted', 'running', 'succeeded']);
  assert.deepEqual(events.at(-1)!.detail, { seconds: 6 });
  cleanup();
});

test('列表按状态、节点、确认单过滤', () => {
  const { project, input, cleanup } = setup();
  const a = createTask(project.db, input);
  createTask(project.db, { ...input, node: 'image:keyframe', capability: 'image', label: DUKO.cut11 });
  markSubmitting(project.db, a.id, 1);
  assert.equal(listTasks(project.db).length, 2);
  assert.deepEqual(listTasks(project.db, { status: ['submitting'] }).map((t) => t.id), [a.id]);
  assert.equal(listTasks(project.db, { node: 'image:keyframe' }).length, 1);
  assert.equal(listTasks(project.db, { paidGateId: 99 }).length, 0);
  cleanup();
});

test('候选：挂在任务目标的实体上，label 按前缀递增', async () => {
  const { project, input, version, dir, cleanup } = setup();
  const t = createTask(project.db, input);
  const src = join(dir, 'a.mp4');
  writeFileSync(src, 'fake video');
  const media = await addMediaFile(project, src);
  assert.equal(nextLabel(project.db, version.entityId, ''), 'v1');
  const c1 = addCandidate(project.db, { taskId: t.id, mediaFileId: media.id, label: nextLabel(project.db, version.entityId, '') });
  assert.equal(c1.targetEntityId, version.entityId);
  assert.equal(nextLabel(project.db, version.entityId, ''), 'v2');
  assert.equal(nextLabel(project.db, version.entityId, 'front-full '), 'front-full v1');
  assert.deepEqual(candidatesOf(project.db, version.entityId).map((c) => c.label), ['v1']);
  cleanup();
});

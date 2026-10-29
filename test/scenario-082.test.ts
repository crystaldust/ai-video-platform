// 082 场景：验证预留的任务 / 候选 / 审阅 / 选用 / 剪辑表能表达原始构想的关键验收案例——
// 082 旧版执行成功但连续性不合格；重做出新版并选用；081 不动；旧剪辑保持原样可对比。
// 只用 SQL 和现有仓储函数，不新增业务 API（那是 Phase 5–7 的事）。
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { currentVersion } from '../src/repo/entities.ts';
import { addMediaFile } from '../src/repo/media.ts';
import { DUKO, importAll, tempProject } from './helpers.ts';

const NOW = '2026-10-26T00:00:00.000Z';

const insertId = (db: DatabaseSync, sql: string, ...params: (string | number | null)[]): number =>
  Number(db.prepare(sql).run(...params).lastInsertRowid);

function insertTask(db: DatabaseSync, targetVersionId: number, providerTaskId: string): number {
  return insertId(
    db,
    `INSERT INTO generation_task (target_version_id, capability, provider, model, status, provider_task_id,
       planned_input, actual_input, cost_estimate, cost_actual, currency, created_at, updated_at)
     VALUES (?, 'video', 'minimax', 'h3', 'succeeded', ?, '{"refs":["f1","f2"]}', '{"refs":["f1"]}', 1.2, 1.1, 'CNY', ?, ?)`,
    targetVersionId,
    providerTaskId,
    NOW,
    NOW,
  );
}

test('082 旧版不合格、新版选用、081 不动，旧剪辑保持原样', async () => {
  const { dir, project, cleanup } = tempProject();
  const { db } = project;
  importAll(project);
  const seg81 = currentVersion(db, 'segment', DUKO.seg1, 'storyboard');
  const seg82 = currentVersion(db, 'segment', DUKO.seg2, 'storyboard');
  const ep1 = db.prepare(`SELECT id FROM entity WHERE kind = 'episode' AND key = ?`).get(DUKO.ep1) as { id: number };
  assert.ok(seg81 && seg82);

  const media = await Promise.all(
    ['081-v1', '082-v1', '082-v2'].map(async (name) => {
      const path = join(dir, `${name}.mp4`);
      writeFileSync(path, `fake ${name}`);
      return addMediaFile(project, path);
    }),
  );

  const t81 = insertTask(db, seg81.id, 'mm-081-a');
  const t82a = insertTask(db, seg82.id, 'mm-082-a');
  assert.throws(() => insertTask(db, seg82.id, 'mm-082-a'), /UNIQUE/, '同一供应商任务 ID 不能落库两次：防重复付费');
  const t82b = insertTask(db, seg82.id, 'mm-082-b');

  const addCandidate = (entityId: number, taskId: number, mediaId: number, label: string) =>
    insertId(db, 'INSERT INTO candidate (target_entity_id, task_id, media_file_id, label, created_at) VALUES (?, ?, ?, ?, ?)', entityId, taskId, mediaId, label, NOW);
  const c81 = addCandidate(seg81.entityId, t81, media[0]!.id, 'v1');
  const c82a = addCandidate(seg82.entityId, t82a, media[1]!.id, 'v1');
  const c82b = addCandidate(seg82.entityId, t82b, media[2]!.id, 'v2');

  insertId(db, `INSERT INTO review (candidate_id, verdict, at_seconds, note, created_at) VALUES (?, 'fail', 2.4, '这里多了一个贝内特', ?)`, c82a, NOW);
  insertId(db, `INSERT INTO review (candidate_id, verdict, at_seconds, note, created_at) VALUES (?, 'note', NULL, '光线偏冷', ?)`, c82b, NOW);
  const select = (entityId: number, candidateId: number) =>
    insertId(db, 'INSERT INTO selection (target_entity_id, candidate_id, created_at) VALUES (?, ?, ?)', entityId, candidateId, NOW);
  select(seg81.entityId, c81);
  select(seg82.entityId, c82a);
  select(seg82.entityId, c82b);

  const addEdit = (v: number, clips: readonly number[]) => {
    const editId = insertId(db, 'INSERT INTO edit_version (episode_entity_id, v, created_at) VALUES (?, ?, ?)', ep1.id, v, NOW);
    clips.forEach((candidateId, i) =>
      insertId(db, 'INSERT INTO edit_clip (edit_version_id, position, candidate_id, in_s, out_s) VALUES (?, ?, ?, 0, 4.5)', editId, i + 1, candidateId),
    );
    return editId;
  };
  const edit1 = addEdit(1, [c81, c82a]);
  const edit2 = addEdit(2, [c81, c82b]);

  const states = db
    .prepare('SELECT label, target_entity_id, exec_status, qc_status, selected FROM candidate_state ORDER BY candidate_id')
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(states, [
    { label: 'v1', target_entity_id: seg81.entityId, exec_status: 'succeeded', qc_status: 'unreviewed', selected: 1 },
    { label: 'v1', target_entity_id: seg82.entityId, exec_status: 'succeeded', qc_status: 'fail', selected: 0 },
    { label: 'v2', target_entity_id: seg82.entityId, exec_status: 'succeeded', qc_status: 'unreviewed', selected: 1 },
  ]);

  const clipsOf = (editId: number) =>
    (db.prepare('SELECT candidate_id FROM edit_clip WHERE edit_version_id = ? ORDER BY position').all(editId) as { candidate_id: number }[]).map(
      (r) => r.candidate_id,
    );
  assert.deepEqual(clipsOf(edit1), [c81, c82a], '旧剪辑仍引用旧版 082');
  assert.deepEqual(clipsOf(edit2), [c81, c82b], '新剪辑换了 082，081 原样复用');

  const plan = db.prepare('SELECT planned_input, actual_input FROM generation_task WHERE id = ?').get(t82b) as Record<string, string>;
  assert.notEqual(plan['planned_input'], plan['actual_input'], '计划输入与实际输入分开记录');
  cleanup();
});

test('剪辑片段的出点必须晚于入点', () => {
  const { project, cleanup } = tempProject();
  const { db } = project;
  importAll(project, ['outline']);
  const ep1 = db.prepare(`SELECT id FROM entity WHERE key = ?`).get(DUKO.ep1) as { id: number };
  const editId = insertId(db, 'INSERT INTO edit_version (episode_entity_id, v, created_at) VALUES (?, 1, ?)', ep1.id, NOW);
  db.exec('PRAGMA foreign_keys = OFF'); // 只测 CHECK，不备候选素材
  assert.throws(
    () => db.prepare('INSERT INTO edit_clip (edit_version_id, position, candidate_id, in_s, out_s) VALUES (?, 1, 1, 3, 3)').run(editId),
    /CHECK/,
  );
  db.exec('PRAGMA foreign_keys = ON');
  cleanup();
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db/connection.ts';
import { MIGRATIONS, migrate, schemaVersion } from '../src/db/migrations.ts';
import { SCHEMA_V1 } from '../src/db/schema-v1.ts';
import { withTransaction } from '../src/db/transaction.ts';

test('新库迁移到最新版本，重复迁移不报错', () => {
  const db = openDb(':memory:');
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.equal(migrate(db), MIGRATIONS.length);
  db.close();
});

test('外键约束生效：指向不存在对象的版本插不进去', () => {
  const db = openDb(':memory:');
  const insert = () =>
    db
      .prepare(`INSERT INTO entity_version (entity_id, facet, v, payload, content_hash, created_at) VALUES (999, 'outline', 1, '{}', 'h', 'now')`)
      .run();
  assert.throws(insert, /FOREIGN KEY/);
  db.close();
});

test('JSON 列拒绝非法 JSON', () => {
  const db = openDb(':memory:');
  const insert = () =>
    db
      .prepare(`INSERT INTO artifact_version (stage, v, doc, content_hash, created_at) VALUES ('outline', 1, 'not json', 'h', 'now')`)
      .run();
  assert.throws(insert, /CHECK/);
  db.close();
});

test('库版本比程序新时拒绝打开', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avp-mig-'));
  const path = join(dir, 'x.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openDb(path), /比程序支持的 \d+ 新/);
  rmSync(dir, { recursive: true, force: true });
});

test('事务内抛错会回滚', () => {
  const db = openDb(':memory:');
  assert.throws(() =>
    withTransaction(db, () => {
      db.prepare(`INSERT INTO project_meta (id, name, created_at) VALUES ('p', 'x', 'now')`).run();
      throw new Error('中途失败');
    }),
  /中途失败/);
  const row = db.prepare('SELECT COUNT(*) AS n FROM project_meta').get() as { n: number };
  assert.equal(row.n, 0);
  db.close();
});

test('v1 库升到最新：已有版本行保留，所属集为空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avp-mig-'));
  const path = join(dir, 'x.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA_V1);
  raw.exec(`INSERT INTO entity (kind, key, created_at) VALUES ('character', 'C01', 'now')`);
  raw.exec(`INSERT INTO entity_version (entity_id, facet, v, payload, content_hash, created_at) VALUES (1, 'outline', 1, '{}', 'h', 'now')`);
  raw.exec('PRAGMA user_version = 1');
  raw.close();
  const db = openDb(path);
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  const row = db.prepare('SELECT v, episode_key FROM entity_version').get();
  assert.deepEqual({ ...row }, { v: 1, episode_key: null });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('迁移到最新后节点协议的表都在，node_run 的状态受 CHECK 约束', () => {
  const db = openDb(':memory:');
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
  for (const t of ['project_input', 'skill_pack', 'skill', 'stage_mount', 'node_run', 'node_attempt']) assert.ok(tables.includes(t), `缺表 ${t}`);
  db.exec(`INSERT INTO skill_pack (name, root, manifest, registered_at) VALUES ('p', '/x', '{}', 'now')`);
  db.exec(`INSERT INTO skill (pack_id, name, version, dir, capabilities, skill_md_hash) VALUES (1, 's', '1.0.0', '/x', '{}', 'h')`);
  assert.throws(
    () => db.exec(`INSERT INTO node_run (stage, skill_id, model, status, max_attempts, started_at) VALUES ('outline', 1, 'm', 'weird', 3, 'now')`),
    /CHECK/,
  );
  db.close();
});

test('v5：编排、打回、复核、付费确认单的表都在；node_run 新列可写', () => {
  const db = openDb(':memory:');
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
  for (const t of ['orchestration', 'revision_request', 'review_ack', 'paid_gate']) assert.ok(tables.includes(t), `缺表 ${t}`);
  const cols = (db.prepare('PRAGMA table_info(node_run)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['orchestration_id', 'episode_key', 'revision_request_id']) assert.ok(cols.includes(c), `node_run 缺列 ${c}`);
  assert.throws(() => db.exec(`INSERT INTO orchestration (mode, status, started_at) VALUES ('weird', 'running', 'now')`), /CHECK/);
  assert.throws(() => db.exec(`INSERT INTO paid_gate (status, estimate, created_at) VALUES ('awaiting_confirmation', 'nope', 'now')`), /CHECK/);
  assert.throws(() => db.exec(`INSERT INTO revision_request (stage, note, base_artifact_version_id, created_at) VALUES ('script', 'x', 999, 'now')`), /FOREIGN KEY/);
  db.close();
});

test('v6：revision_request 有 dismissed_at 列（放弃的打回意见），v5 库升上来旧行为空', () => {
  const db = openDb(':memory:');
  assert.ok(MIGRATIONS.length >= 6);
  const cols = (db.prepare('PRAGMA table_info(revision_request)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('dismissed_at'), 'revision_request 缺列 dismissed_at');
  db.close();

  const dir = mkdtempSync(join(tmpdir(), 'avp-mig-'));
  const path = join(dir, 'x.sqlite');
  const raw = new DatabaseSync(path);
  for (const sql of MIGRATIONS.slice(0, 5)) raw.exec(sql);
  raw.exec(`INSERT INTO revision_request (stage, note, created_at) VALUES ('script', 'x', 'now')`);
  raw.exec('PRAGMA user_version = 5');
  raw.close();
  const upgraded = openDb(path);
  assert.equal(schemaVersion(upgraded), MIGRATIONS.length);
  assert.deepEqual({ ...(upgraded.prepare('SELECT dismissed_at FROM revision_request').get() as object) }, { dismissed_at: null });
  upgraded.close();
  rmSync(dir, { recursive: true, force: true });
});

test('v7：generation_task 重建——新状态与新列；v6 库里的任务、事件、候选、视图升上来都在', () => {
  const db = openDb(':memory:');
  assert.ok(MIGRATIONS.length >= 7);
  const cols = (db.prepare('PRAGMA table_info(generation_task)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['node', 'episode_key', 'label', 'content_fingerprint', 'paid_gate_id', 'attempt_of', 'pid', 'submitted_at', 'provider_status', 'result_url']) assert.ok(cols.includes(c), `generation_task 缺列 ${c}`);
  db.close();

  const dir = mkdtempSync(join(tmpdir(), 'avp-mig-'));
  const path = join(dir, 'x.sqlite');
  const raw = new DatabaseSync(path);
  for (const sql of MIGRATIONS.slice(0, 6)) raw.exec(sql);
  raw.exec(`
    INSERT INTO entity (id, kind, key, created_at) VALUES (1, 'segment', 'sg_aaaaaaaa', 'now');
    INSERT INTO entity_version (id, entity_id, facet, v, payload, content_hash, created_at) VALUES (1, 1, 'storyboard', 1, '{}', 'h', 'now');
    INSERT INTO media_file (id, sha256, rel_path, mime, bytes, created_at) VALUES (1, 'abc', 'media/ab/abc.mp4', 'video/mp4', 10, 'now');
    INSERT INTO generation_task (id, target_version_id, capability, provider, model, status, provider_task_id, planned_input, created_at, updated_at)
      VALUES (1, 1, 'video', 'minimax', 'MiniMax-H3-Lite', 'succeeded', 't-1', '{}', 'now', 'now');
    INSERT INTO task_event (task_id, status, at) VALUES (1, 'succeeded', 'now');
    INSERT INTO candidate (id, target_entity_id, task_id, media_file_id, label, created_at) VALUES (1, 1, 1, 1, 'v1', 'now');
  `);
  raw.exec('PRAGMA user_version = 6');
  raw.close();

  const up = openDb(path);
  assert.equal(schemaVersion(up), MIGRATIONS.length);
  const task = up.prepare('SELECT status, provider_task_id, node, pid FROM generation_task WHERE id = 1').get() as Record<string, unknown>;
  assert.deepEqual({ ...task }, { status: 'succeeded', provider_task_id: 't-1', node: null, pid: null });
  assert.deepEqual({ ...(up.prepare('SELECT exec_status, selected FROM candidate_state WHERE candidate_id = 1').get() as object) }, { exec_status: 'succeeded', selected: 0 });
  assert.equal((up.prepare('PRAGMA foreign_key_check').all() as unknown[]).length, 0, '重建后外键都还对得上');
  // 新状态能写、乱写的状态被拦；同一供应商任务 id 仍只能落库一次
  up.exec(`INSERT INTO generation_task (target_version_id, capability, provider, model, status, planned_input, created_at, updated_at) VALUES (1, 'video', 'minimax', 'm', 'submitting', '{}', 'now', 'now')`);
  assert.throws(() => up.exec(`INSERT INTO generation_task (target_version_id, capability, provider, model, status, planned_input, created_at, updated_at) VALUES (1, 'video', 'minimax', 'm', 'weird', '{}', 'now', 'now')`), /CHECK/);
  assert.throws(() => up.exec(`INSERT INTO generation_task (target_version_id, capability, provider, model, status, provider_task_id, planned_input, created_at, updated_at) VALUES (1, 'video', 'minimax', 'm', 'submitted', 't-1', '{}', 'now', 'now')`), /UNIQUE/);
  up.close();
  rmSync(dir, { recursive: true, force: true });
});

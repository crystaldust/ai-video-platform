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

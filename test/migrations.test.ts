import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db/connection.ts';
import { MIGRATIONS, migrate, schemaVersion } from '../src/db/migrations.ts';
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

// 迁移：按 PRAGMA user_version 记录跑到第几个。只追加新迁移，已发布的不改。
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_V1 } from './schema-v1.ts';
import { SCHEMA_V2 } from './schema-v2.ts';
import { SCHEMA_V3 } from './schema-v3.ts';
import { withTransaction } from './transaction.ts';

export const MIGRATIONS: readonly string[] = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3];

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function setSchemaVersion(db: DatabaseSync, v: number): void {
  // PRAGMA 不能参数化，只拼经过校验的整数
  if (!Number.isInteger(v) || v < 0) throw new Error(`非法的库版本号：${v}`);
  db.exec(`PRAGMA user_version = ${v}`);
}

export function migrate(db: DatabaseSync): number {
  const current = schemaVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(`项目库版本 ${current} 比程序支持的 ${MIGRATIONS.length} 新，请升级平台`);
  }
  if (current === MIGRATIONS.length) return current;
  withTransaction(db, () => {
    // 拿到写锁后重读：两个进程同时打开新库时，后到的那个不能把迁移再跑一遍
    for (const sql of MIGRATIONS.slice(schemaVersion(db))) db.exec(sql);
    setSchemaVersion(db, MIGRATIONS.length);
  });
  return MIGRATIONS.length;
}

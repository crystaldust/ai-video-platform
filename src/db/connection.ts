import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.ts';

export const BUSY_TIMEOUT_MS = 5000;

/** 打开项目库并迁移到最新。外键约束每个连接都要单独打开，否则静默失效。 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    // busy_timeout 放最前：切 WAL 本身也可能要等锁
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;`);
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

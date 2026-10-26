import type { DatabaseSync } from 'node:sqlite';

/**
 * 在一个写事务里执行 fn；抛错就回滚再原样抛出——导入、迁移都靠它保证"要么全写、要么不留痕"。
 * BEGIN IMMEDIATE：一开始就拿写锁，避免读到一半才发现别的连接在写。
 * 不支持嵌套：fn 里再开事务会直接报错，这是有意的——嵌套说明调用层次设计错了。
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // 磁盘满、IO 错误时 SQLite 可能已自动回滚；再 ROLLBACK 会抛错盖掉真正的原因
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

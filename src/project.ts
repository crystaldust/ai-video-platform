// 一个项目 = 一个目录：project.sqlite + media/。分享、归档按目录复制即可。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { openDb } from './db/connection.ts';
import { nowIso } from './domain/clock.ts';

export const DB_FILE = 'project.sqlite';
export const MEDIA_DIR = 'media';
/** 节点运行的工作目录：runs/<runId>/{in,work,out} */
export const RUNS_DIR = 'runs';
/** 库文件本身加 WAL 模式的两个伴随文件。 */
const DB_SIDE_FILES = ['', '-wal', '-shm'] as const;

export interface ProjectMeta {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface Project {
  readonly dir: string;
  readonly db: DatabaseSync;
  readonly meta: ProjectMeta;
  close(): void;
}

function readMeta(db: DatabaseSync, dir: string): ProjectMeta {
  const row = db.prepare('SELECT id, name, created_at FROM project_meta LIMIT 1').get() as
    | { id: string; name: string; created_at: string }
    | undefined;
  if (!row) throw new Error(`项目库缺少 project_meta：${dir}`);
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

const wrap = (dir: string, db: DatabaseSync, meta: ProjectMeta): Project => ({
  dir,
  db,
  meta,
  close: () => db.close(),
});

export function createProject(dirArg: string, nameArg: string): Project {
  const name = String(nameArg ?? '').trim();
  if (!name) throw new Error('项目名称不能为空');
  const dir = resolve(dirArg);
  const dbPath = join(dir, DB_FILE);
  if (existsSync(dbPath)) throw new Error(`这里已经有项目了：${dir}`);
  mkdirSync(join(dir, MEDIA_DIR), { recursive: true });
  const meta: ProjectMeta = { id: randomUUID(), name, createdAt: nowIso() };
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath);
    db.prepare('INSERT INTO project_meta (id, name, created_at) VALUES (?, ?, ?)').run(meta.id, meta.name, meta.createdAt);
    return wrap(dir, db, meta);
  } catch (error) {
    // 建到一半失败：关掉连接、删掉半成品库，否则这个目录既建不了也打不开
    db?.close();
    for (const suffix of DB_SIDE_FILES) rmSync(`${dbPath}${suffix}`, { force: true });
    throw error;
  }
}

export function openProject(dirArg: string): Project {
  const dir = resolve(dirArg);
  const dbPath = join(dir, DB_FILE);
  if (!existsSync(dbPath)) throw new Error(`不是项目目录（缺 ${DB_FILE}）：${dir}`);
  const db = openDb(dbPath);
  try {
    return wrap(dir, db, readMeta(db, dir));
  } catch (error) {
    db.close();
    throw error;
  }
}

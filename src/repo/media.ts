// 内容寻址素材库：media/<sha 前 2 位>/<sha>.<ext>。同一文件只存一份，哈希就是身份。
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join, posix, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { nowIso } from '../domain/clock.ts';
import { MEDIA_DIR, type Project } from '../project.ts';

export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.json': 'application/json',
  '.srt': 'application/x-subrip',
};
const FALLBACK_MIME = 'application/octet-stream';

export interface MediaRow {
  readonly id: number;
  readonly sha256: string;
  readonly relPath: string;
  readonly mime: string;
  readonly bytes: number;
  readonly createdAt: string;
}

interface RawMedia {
  id: number;
  sha256: string;
  rel_path: string;
  mime: string;
  bytes: number;
  created_at: string;
}

const toMediaRow = (r: RawMedia): MediaRow => ({
  id: r.id,
  sha256: r.sha256,
  relPath: r.rel_path,
  mime: r.mime,
  bytes: r.bytes,
  createdAt: r.created_at,
});

/** 流式算哈希：视频文件可能很大，不整个读进内存。 */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export function findMedia(project: Project, sha256: string): MediaRow | null {
  const row = project.db.prepare('SELECT * FROM media_file WHERE sha256 = ?').get(sha256) as RawMedia | undefined;
  return row ? toMediaRow(row) : null;
}

const isUniqueViolation = (error: unknown) => error instanceof Error && /UNIQUE constraint failed/.test(error.message);

/** 项目内的绝对路径；rel_path 越出媒体目录（库被改过）时返回 null。 */
function insideMedia(project: Project, relPath: string): string | null {
  const root = resolve(project.dir, MEDIA_DIR);
  const abs = resolve(project.dir, relPath);
  return abs.startsWith(root + sep) ? abs : null;
}

/** 已入库但文件不在了：用刚拷进来的、哈希已核对的临时文件补回去。 */
function restoreIfMissing(project: Project, row: MediaRow, tmp: string): void {
  const abs = insideMedia(project, row.relPath);
  if (abs && !existsSync(abs)) {
    mkdirSync(dirname(abs), { recursive: true });
    renameSync(tmp, abs);
  }
}

/**
 * 入库一个素材文件；已有同哈希的直接返回。
 * 先拷到媒体目录里的临时文件、对拷贝算哈希、再原子改名就位——
 * 哈希算的就是落盘的那份字节，源文件中途被改、目标位置有残缺旧文件都不会出错。
 */
export async function addMediaFile(project: Project, srcPath: string): Promise<MediaRow> {
  if (!existsSync(srcPath) || !statSync(srcPath).isFile()) throw new Error(`素材文件不存在：${srcPath}`);
  const ext = extname(srcPath).toLowerCase();
  const mediaRoot = join(project.dir, MEDIA_DIR);
  mkdirSync(mediaRoot, { recursive: true }); // 用户可能手动删过 media/
  const tmp = join(mediaRoot, `.tmp-${randomUUID()}${ext}`);
  copyFileSync(srcPath, tmp);
  try {
    const sha256 = await hashFile(tmp);
    const existing = findMedia(project, sha256);
    if (existing) {
      restoreIfMissing(project, existing, tmp);
      return existing;
    }
    // 库里一律存 / 分隔：项目目录在 Windows 与 macOS 之间拷贝后路径仍有效
    const relPath = posix.join(MEDIA_DIR, sha256.slice(0, 2), `${sha256}${ext}`);
    const abs = join(project.dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    renameSync(tmp, abs);
    return insertMedia(project, { sha256, relPath, mime: MIME_BY_EXT[ext] ?? FALLBACK_MIME, bytes: statSync(abs).size });
  } finally {
    rmSync(tmp, { force: true });
  }
}

function insertMedia(project: Project, row: Omit<MediaRow, 'id' | 'createdAt'>): MediaRow {
  const createdAt = nowIso();
  try {
    const result = project.db
      .prepare('INSERT INTO media_file (sha256, rel_path, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.sha256, row.relPath, row.mime, row.bytes, createdAt);
    return { ...row, id: Number(result.lastInsertRowid), createdAt };
  } catch (error) {
    // 并发入库同一文件：另一路先插进去了，读它的那行
    const winner = isUniqueViolation(error) ? findMedia(project, row.sha256) : null;
    if (winner) return winner;
    throw error;
  }
}

export interface MediaCheck {
  readonly ok: number;
  readonly missing: readonly string[];
  readonly mismatched: readonly string[];
}

type MediaStatus = 'ok' | 'missing' | 'mismatched';

async function checkOne(project: Project, row: MediaRow): Promise<MediaStatus> {
  const abs = insideMedia(project, row.relPath);
  if (!abs) return 'mismatched'; // 路径越出媒体目录：库记录不可信
  if (!existsSync(abs)) return 'missing';
  return (await hashFile(abs)) === row.sha256 ? 'ok' : 'mismatched';
}

/** 交付核验：逐个重算哈希，报告丢失和被改动的文件。顺序执行：大项目不会一次打开上千个文件。 */
export async function verifyMedia(project: Project): Promise<MediaCheck> {
  const rows = (project.db.prepare('SELECT * FROM media_file ORDER BY id').all() as unknown as RawMedia[]).map(toMediaRow);
  const results: { row: MediaRow; status: MediaStatus }[] = [];
  for (const row of rows) results.push({ row, status: await checkOne(project, row) });
  return {
    ok: results.filter((r) => r.status === 'ok').length,
    missing: results.filter((r) => r.status === 'missing').map((r) => r.row.relPath),
    mismatched: results.filter((r) => r.status === 'mismatched').map((r) => r.row.relPath),
  };
}

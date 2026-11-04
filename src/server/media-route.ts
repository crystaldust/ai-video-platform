// 素材文件：GET /api/p/:id/media/:mid，给页面的 <img>、<video> 用。
// 只按库里登记过的素材 id 查，不接受任何路径参数；库里的路径再校验一次必须在 media/ 下（库被改过就 404，不说原因）。
// 文件按哈希命名、内容不变，可以长缓存；视频要拖进度条，支持单段 Range（206 / 416）；流式发送，不整个读进内存。
// GET 不要令牌（<img> 带不了请求头），Host 校验照常（server.ts 的 guard）；别的网站的页面来嵌（Sec-Fetch-Site: cross-site）一律 403，
// 免得外站靠加载成败探出有哪些项目和素材。符号链接按真实路径再查一次，指到 media/ 外的不发。
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { MEDIA_DIR, type Project } from '../project.ts';
import { getMedia, insideMedia, MIME_BY_EXT } from '../repo/media.ts';
import { HttpError } from './http.ts';
import { route, type Route } from './route.ts';

const NOT_FOUND = '没有这个素材';

/** 单段 bytes=a-b / bytes=a- / bytes=-n；看不懂的当没有 Range（回整个文件），越界返回 'bad'。 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return 'bad';
  return { start, end };
}

function send(res: ServerResponse, abs: string, mime: string, size: number, rangeHeader: string | undefined): void {
  const common = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
  const range = parseRange(rangeHeader, size);
  if (range === 'bad') {
    res.writeHead(416, { ...common, 'content-range': `bytes */${size}` });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  res.writeHead(range ? 206 : 200, { ...common, 'content-length': String(size === 0 ? 0 : end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
  if (size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(abs, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** 真实路径（解开符号链接）也在项目的 media/ 下。 */
function reallyInside(p: Project, abs: string): boolean {
  const root = realpathSync(resolve(p.dir, MEDIA_DIR));
  return realpathSync(abs).startsWith(root + sep);
}

export const MEDIA_ROUTES: readonly Route[] = [
  route('GET', '/api/p/:id/media/:mid', async ({ app, params, req, res }) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '不接受别的网站来取素材');
    const raw = params['mid'];
    const mid = Number(raw);
    if (!Number.isSafeInteger(mid) || mid < 1 || String(mid) !== raw) throw new HttpError(400, `素材编号不对：${String(raw)}`);
    const file = await app.withProject(params['id']!, (p) => {
      const row = getMedia(p, mid);
      const abs = row && insideMedia(p, row.relPath);
      if (!row || !abs || !existsSync(abs) || !reallyInside(p, abs) || !statSync(abs).isFile()) throw new HttpError(404, NOT_FOUND);
      return { abs, mime: MIME_BY_EXT[extname(abs).toLowerCase()] ?? 'application/octet-stream', size: statSync(abs).size };
    });
    send(res, file.abs, file.mime, file.size, req.headers.range);
    return undefined;
  }),
];

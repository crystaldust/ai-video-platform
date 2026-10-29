// 本地 Web 服务：JSON API + SSE 进度 + 前端静态文件。零运行时依赖（node:http）。
// 安全模型（本机单用户）：
// - 只监听 127.0.0.1；
// - Host 必须是 127.0.0.1:<端口> 或 localhost:<端口>（挡 DNS rebinding）；
// - 变更类请求（非 GET/HEAD）必须带启动时生成的随机令牌（x-avp-token），带了 Origin 的还要同源（挡 CSRF）；
// - 不开 CORS：别的网页读不到响应。令牌由服务注入到 index.html 的 meta 里，只有同源页面拿得到。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import type { App } from './app.ts';
import { HttpError, ok, sendError } from './http.ts';
import { ROUTES, type Route } from './routes.ts';

export const DEFAULT_PORT = 5170;

/** 所有响应都带的安全头：不许被嵌进别的页面、不猜类型、不外带来源。 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

/** 页面的内容安全策略：脚本只许同源（构建产物没有内联脚本）；样式允许内联（React 的 style 属性）与 Google Fonts。 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');
export const TOKEN_HEADER = 'x-avp-token';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  readonly token: string;
  readonly url: string;
  close(): Promise<void>;
}

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** 安全检查；不过就抛 HttpError。 */
function guard(req: IncomingMessage, port: number, token: string): void {
  const hosts = allowedHosts(port);
  if (!hosts.includes(req.headers.host ?? '')) throw new HttpError(421, 'Host 不对：只接受本机地址');
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const given = req.headers[TOKEN_HEADER];
  if (typeof given !== 'string' || !sameToken(given, token)) throw new HttpError(403, '缺少或错误的令牌');
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) throw new HttpError(403, '跨站请求被拒绝');
}

/** 解码 URL 片段；坏的百分号编码是请求错误，不是服务器错误。 */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, '路径编码不对');
  }
}

function match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => {
      params[k] = decode(m[i + 1] ?? '');
    });
    return { route, params };
  }
  return null;
}

/** 静态文件；不是文件的路径都回 index.html（前端路由）。index.html 里注入令牌。 */
function serveStatic(res: ServerResponse, dir: string, path: string, token: string): void {
  const rel = normalize(decode(path)).replace(/^([/\\])+/, '');
  const file = join(dir, rel);
  const inside = file === dir || file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  const target = inside && rel && existsSync(file) && statSync(file).isFile() ? file : join(dir, 'index.html');
  if (!existsSync(target)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('前端还没有构建：先运行 pnpm web:build');
    return;
  }
  let body: Buffer | string = readFileSync(target);
  if (target.endsWith('index.html')) body = body.toString('utf8').replace('</head>', `<meta name="avp-token" content="${token}"></head>`);
  res.writeHead(200, {
    ...(target.endsWith('index.html') ? { 'content-security-policy': CSP } : {}),
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    // assets/ 下是带哈希的构建产物，可以长缓存；index.html 每次都取新的（里面有令牌）；其余短缓存
    'cache-control': target.endsWith('index.html') ? 'no-store' : rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(body);
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse, port: number, token: string): Promise<void> {
  try {
    guard(req, port, token);
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持的请求方法');
      if (!app.config.staticDir) throw new HttpError(404, '没有配置前端目录');
      return serveStatic(res, app.config.staticDir, url.pathname, token);
    }
    const found = match(req.method ?? 'GET', url.pathname);
    if (!found) throw new HttpError(404, `没有这个接口：${req.method} ${url.pathname}`);
    const data = await found.route.handler({ app, req, res, url, params: found.params });
    // 自己写了响应的处理器（SSE）返回 undefined 且已经开始写
    if (!res.headersSent) ok(res, data ?? null);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendError(res, error, app.config.log);
  }
}

/** 启动服务；port 为 0 时由系统分配（测试用）。 */
export async function startServer(app: App, opts: { port?: number; token?: string } = {}): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(24).toString('base64url');
  let port = opts.port ?? DEFAULT_PORT;
  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    void handle(app, req, res, port, token);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    token,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        app.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

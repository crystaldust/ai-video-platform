// 测试用：起一个本地服务（项目根目录是临时目录、模型是吐渡口样例的假模型、估算不读本机配置），
// 用 node:http 发请求（fetch 不让改 Host 头，测不了 Host 校验）。
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { estimateProject } from '../../src/estimate/estimate.ts';
import { BUILTIN_PRESET_DIR } from '../../src/presets/presets.ts';
import { loadPriceSources } from '../../src/pricing/prices.ts';
import { App, type AppConfig } from '../../src/server/app.ts';
import { startServer, TOKEN_HEADER, type RunningServer } from '../../src/server/server.ts';
import { dukoModel } from './duko-model.ts';
import { ROOT, SKILLS } from './novel-pack.ts';

const NONE = '/nonexistent-avp';
export const PRESET_DIRS = { builtin: BUILTIN_PRESET_DIR, user: NONE };
export const testEstimate = (db: DatabaseSync) =>
  estimateProject(db, { prices: loadPriceSources(NONE), fx: { usdToCny: 7, checkedAt: '2026-10-29', source: 'test' }, presetDirs: PRESET_DIRS });

export interface Harness {
  readonly app: App;
  readonly server: RunningServer;
  readonly root: string;
  readonly logs: string[];
  call(method: string, path: string, opts?: { body?: unknown; headers?: Record<string, string>; token?: boolean }): Promise<{ status: number; body: any; text: string; headers: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function startHarness(over: Partial<AppConfig> = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'avp-srv-'));
  const logs: string[] = [];
  const app = new App({
    projectsRoot: join(root, 'projects'),
    packManifest: join(ROOT, 'packs', 'novel.pack.json'),
    skillsRoot: SKILLS,
    staticDir: null,
    log: (l) => logs.push(l),
    modelFor: () => dukoModel(),
    estimate: testEstimate,
    run: { prices: null },
    credentials: { dir: join(root, 'cfg'), env: {} },
    presetDirs: PRESET_DIRS,
    ...over,
  });
  const server = await startServer(app, { port: 0 });
  const call: Harness['call'] = (method, path, opts = {}) =>
    new Promise((resolve, reject) => {
      const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      const headers: Record<string, string> = {
        host: `127.0.0.1:${server.port}`,
        ...(data ? { 'content-type': 'application/json' } : {}),
        ...(opts.token === false || method === 'GET' ? {} : { [TOKEN_HEADER]: server.token }),
        ...opts.headers,
      };
      const req = request({ host: '127.0.0.1', port: server.port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body, text, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  return {
    app,
    server,
    root,
    logs,
    call,
    close: async () => {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 订阅 SSE，收事件直到 until 返回 true；返回收到的事件。 */
export function collectEvents(h: Harness, projectPath: string, until: (e: { type: string; [k: string]: unknown }) => boolean): Promise<{ type: string; [k: string]: unknown }[]> {
  return new Promise((resolve, reject) => {
    const events: { type: string; [k: string]: unknown }[] = [];
    const req = request({ host: '127.0.0.1', port: h.server.port, method: 'GET', path: projectPath, headers: { host: `127.0.0.1:${h.server.port}` } }, (res) => {
      let buffer = '';
      res.on('data', (c: Buffer) => {
        buffer += c.toString('utf8');
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (!data) continue;
          const e = JSON.parse(data.slice(6));
          events.push(e);
          if (until(e)) {
            req.destroy();
            resolve(events);
          }
        }
      });
    });
    req.on('error', (e) => (events.length ? resolve(events) : reject(e)));
    req.end();
  });
}

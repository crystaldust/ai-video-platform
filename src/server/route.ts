// 路由的类型与构造：方法 + 路径模式 → 处理器。处理器返回的数据由 server.ts 包进统一信封；SSE 处理器自己写响应。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { App } from './app.ts';

export interface RouteCtx {
  readonly app: App;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
}

export interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly keys: readonly string[];
  readonly handler: (ctx: RouteCtx) => unknown;
}

/** '/api/p/:id/episodes/:ep' → 正则 + 参数名。参数不跨 '/'。 */
export function route(method: string, path: string, handler: Route['handler']): Route {
  const keys: string[] = [];
  const source = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_m, k: string) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${source}$`), keys, handler };
}

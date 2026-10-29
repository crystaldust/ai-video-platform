// 接口调用：统一信封解析、变更请求带令牌（服务注入在页面 meta 里）、出错抛带问题清单的 ApiError。
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  readonly status: number;
  readonly problems: readonly string[];
  constructor(status: number, message: string, problems: readonly string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problems = problems;
  }
}

const token = (): string => document.querySelector<HTMLMetaElement>('meta[name="avp-token"]')?.content ?? '';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-avp-token': token() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, '连不上本地服务：确认 cli serve 还在运行');
  }
  const doc = (await res.json().catch(() => null)) as { ok: boolean; data?: T; error?: { message: string; problems?: string[] } } | null;
  if (!doc) throw new ApiError(res.status, `服务返回了无法解析的响应（${res.status}）`);
  if (!doc.ok) throw new ApiError(res.status, doc.error?.message ?? '请求失败', doc.error?.problems ?? []);
  return doc.data as T;
}

export const api = {
  get: <T,>(path: string) => call<T>('GET', path),
  post: <T,>(path: string, body: unknown = {}) => call<T>('POST', path, body),
};

export const projectPath = (id: string, rest = ''): string => `/api/p/${encodeURIComponent(id)}${rest}`;

export interface Loaded<T> {
  readonly data: T | null;
  readonly error: ApiError | null;
  readonly loading: boolean;
  reload(): void;
}

/** 拉一个 GET 接口；path 为 null 时不拉。reload 不会清掉旧数据（刷新时页面不闪）。 */
export function useApi<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  // 换了接口路径（比如换了项目）：先清掉旧数据，免得新地址显示旧内容
  const [shownPath, setShownPath] = useState(path);
  if (shownPath !== path) {
    setShownPath(path);
    setData(null);
    setError(null);
  }
  useEffect(() => {
    if (path === null) return;
    const n = ++latest.current;
    setLoading(true);
    api
      .get<T>(path)
      .then((d) => {
        if (n !== latest.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => n === latest.current && setError(e instanceof ApiError ? e : new ApiError(0, String(e))))
      .finally(() => n === latest.current && setLoading(false));
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export interface ServerEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** 订阅项目的进度事件流；断线时浏览器自动重连（重连后服务先发 hello，带当前任务）。 */
export function useProjectEvents(id: string, onEvent: (e: ServerEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const source = new EventSource(projectPath(id, '/events'));
    const listen = (msg: MessageEvent<string>) => {
      try {
        handler.current(JSON.parse(msg.data) as ServerEvent);
      } catch {
        // 坏事件忽略
      }
    };
    const types = ['hello', 'job-start', 'job-end', 'layer', 'stage', 'paid-gate', 'run-run-start', 'run-run-end', 'run-attempt', 'run-gate', 'run-notice'];
    for (const t of types) source.addEventListener(t, listen);
    return () => source.close();
  }, [id]);
}

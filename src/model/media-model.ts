// 图片、视频供应商的统一接口：提交（拿任务 id）、查询、列出最近的任务（崩溃后对账用）。
// 两家都是异步任务、都没有幂等键，所以「提交」和「查询」的重试纪律不同：
// 查询可以随便重试；提交绝不自动重试——网络错误、超时、5xx 时请求可能已经到了供应商，
// 再发一次就可能多付一次钱。这类结果一律报「结果未知」，交给对账。
import { ModelError, isRetryable } from './errors.ts';
import { classify, retryAfterMs, type HttpDeps } from './openai-compatible.ts';

/** 供应商任务状态，映射到平台任务状态机的那几个。 */
export type ProviderState = 'submitted' | 'running' | 'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'unknown';

/** 参考图：素材库里的文件。sha256 记进实际输入，dataUri 只放进请求体。 */
export interface RefImage {
  readonly sha256: string;
  readonly dataUri: string;
}

export interface ImageRequest {
  readonly prompt: string;
  readonly negativePrompt?: string;
  /** 百炼格式 `宽*高` */
  readonly size: string;
  readonly refs: readonly RefImage[];
}

export interface VideoRequest {
  readonly prompt: string;
  /** 按 Picture 顺序的参考图 */
  readonly refs: readonly RefImage[];
  readonly duration: number;
  readonly resolution: string;
  readonly ratio: string;
}

export interface SubmitResult {
  readonly providerTaskId: string;
  /** 真正发出的请求：去掉凭据，参考图换成 sha256 */
  readonly actualInput: unknown;
}

export interface MediaUsage {
  readonly outputImages?: number;
  readonly inputImages?: number;
  readonly outputSeconds?: number;
}

export interface QueryResult {
  readonly state: ProviderState;
  /** 供应商原样的状态字 */
  readonly providerStatus: string;
  readonly url?: string;
  readonly usage?: MediaUsage;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface RecentTask {
  readonly providerTaskId: string;
  /** ISO 时间；供应商没给或解析不了时为 null（对账时当作「可能是」） */
  readonly createdAt: string | null;
}

export interface MediaModel<R> {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  submit(req: R, signal?: AbortSignal): Promise<SubmitResult>;
  query(providerTaskId: string, signal?: AbortSignal): Promise<QueryResult>;
  /** 时间窗内本模型的任务（崩溃后对账）；供应商只留有限时间（百炼 24 小时、MiniMax 7 天） */
  listRecent(window: { since: Date; until: Date }, signal?: AbortSignal): Promise<RecentTask[]>;
}

export type ImageModel = MediaModel<ImageRequest>;
export type VideoModel = MediaModel<VideoRequest>;

/**
 * 提交失败的四种情况，执行器按它决定任务怎么走：
 * - unknown：请求可能已到达（网络错误、超时、5xx、响应看不懂）→ 保持「提交中」，等对账
 * - rate：限流，确定没创建 → 等一会儿再提交同一条任务
 * - rejected：内容审核没过 → rejected
 * - invalid：参数错、鉴权失败、余额不足 → failed（改好再「重新生成」）
 */
export type SubmitErrorKind = 'unknown' | 'rate' | 'rejected' | 'invalid';

export class SubmitError extends Error {
  readonly kind: SubmitErrorKind;
  readonly retryAfterMs: number | null;
  constructor(kind: SubmitErrorKind, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'SubmitError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

const TIMEOUT_MS = 2 * 60_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export interface HttpCall {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly key: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

async function once(http: HttpDeps, provider: string, call: HttpCall, signal?: AbortSignal): Promise<{ status: number; text: string; retryAfter: number | null }> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await http.fetch(call.url, {
      method: call.method,
      headers: { authorization: `Bearer ${call.key}`, ...(call.body === undefined ? {} : { 'content-type': 'application/json' }), ...call.headers },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new ModelError(timedOut ? 'timeout' : 'network', `${provider} ${timedOut ? '请求超时' : '连不上'}：${error instanceof Error ? error.message : String(error)}`);
  }
  return { status: res.status, text: await res.text(), retryAfter: retryAfterMs(res.headers.get('retry-after')) };
}

const parse = (provider: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelError('server', `${provider} 返回的不是 JSON：${text.slice(0, 200)}`);
  }
};

/** 查询类请求：限流、5xx、网络错误按指数退避重试。 */
export async function getJson(http: HttpDeps, provider: string, call: HttpCall, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await once(http, provider, call, signal);
      if (r.status < 200 || r.status >= 300) throw classify(r.status, provider, r.text, r.retryAfter);
      return parse(provider, r.text);
    } catch (e) {
      if (!(e instanceof ModelError) || !isRetryable(e) || attempt >= MAX_RETRIES || signal?.aborted) throw e;
      await http.sleep(e.retryAfterMs ?? Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) * (0.5 + http.random() / 2));
    }
  }
}

/**
 * 提交：只发一次。返回 2xx 的 JSON；其余按 SubmitError 分类。
 * isModeration 由各家给出（审核失败的错误码各不相同）。
 */
export async function submitJson(http: HttpDeps, provider: string, call: HttpCall, isModeration: (status: number, body: unknown) => boolean, signal?: AbortSignal): Promise<unknown> {
  let r: { status: number; text: string; retryAfter: number | null };
  try {
    r = await once(http, provider, call, signal);
  } catch (e) {
    throw new SubmitError('unknown', `${(e as Error).message}（请求可能已经到达，等对账确认，不会自动重提）`);
  }
  if (r.status >= 200 && r.status < 300) {
    try {
      return JSON.parse(r.text);
    } catch {
      throw new SubmitError('unknown', `${provider} 提交后返回的不是 JSON，任务可能已经建了，等对账确认`);
    }
  }
  let body: unknown = null;
  try {
    body = JSON.parse(r.text);
  } catch {
    body = null;
  }
  const detail = r.text.slice(0, 300);
  if (r.status === 429) throw new SubmitError('rate', `${provider} 限流（HTTP 429）：${detail}`, r.retryAfter);
  // 408：请求超时，服务端可能已经建了任务
  if (r.status === 408) throw new SubmitError('unknown', `${provider} 请求超时（HTTP 408），任务可能已经建了，等对账确认：${detail}`);
  if (r.status >= 500) throw new SubmitError('unknown', `${provider} 服务端错误（HTTP ${r.status}），任务可能已经建了，等对账确认：${detail}`);
  if (isModeration(r.status, body)) throw new SubmitError('rejected', `${provider} 内容审核没通过：${detail}`);
  throw new SubmitError('invalid', classify(r.status, provider, r.text, null).message);
}

/** 看不懂的供应商状态：当作一次查询出错，不改任务状态——判失败可能让一个还在计费的任务被重新生成。 */
export const unreadable = (provider: string, status: string): ModelError => new ModelError('server', `${provider} 返回了看不懂的任务状态「${status.slice(0, 40)}」，先不改任务状态`);

/** 翻页到上限还没取完：对账时不能据此判「没到达」。 */
export const truncatedList = (provider: string, pages: number): Error => new Error(`${provider} 任务列表超过 ${pages} 页没取完，没法确认任务是否到达`);

export const str = (x: unknown): string | undefined => (typeof x === 'string' && x !== '' ? x : undefined);
export const numOf = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
export const objOf = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

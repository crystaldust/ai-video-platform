// OpenAI 兼容的文本适配器（DeepSeek 等）：POST {baseUrl}/chat/completions。
// 限流和服务端错误按指数退避重试，遵守 Retry-After；鉴权失败立即报错并提示配凭据。不打印请求体与 key。
import type { ModelInfo } from './capabilities.ts';
import { isRetryable, ModelError } from './errors.ts';
import type { FinishReason, TextModel, TextRequest, TextResult } from './text-model.ts';

export interface HttpDeps {
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

export const defaultHttpDeps: HttpDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
};

const TIMEOUT_MS = 10 * 60_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/** 供应商要求等更久就不等了，直接报限流，免得命令行一声不吭卡住、阶段一直锁着 */
const MAX_RETRY_AFTER_MS = 120_000;

type TextModelInfo = Extract<ModelInfo, { capability: 'text' }>;

const finishOf = (raw: unknown): FinishReason =>
  raw === 'stop' || raw === 'length' || raw === 'content_filter' ? raw : 'other';

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** 毫秒；Retry-After 可以是秒数，也可以是 HTTP 日期。 */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function classify(status: number, provider: string, body: string, retryAfter: number | null): ModelError {
  const detail = body.slice(0, 300);
  if (status === 401 || status === 403) return new ModelError('auth', `${provider} 鉴权失败（HTTP ${status}）：检查凭据，cred set ${provider}`, status);
  if (status === 429) return new ModelError('rate', `${provider} 限流（HTTP 429）：${detail}`, status, retryAfter);
  if (status >= 500) return new ModelError('server', `${provider} 服务端错误（HTTP ${status}）：${detail}`, status, retryAfter);
  return new ModelError('bad_request', `${provider} 拒绝了请求（HTTP ${status}）：${detail}`, status);
}

export class OpenAICompatibleTextModel implements TextModel {
  readonly id: string;
  private readonly info: TextModelInfo;
  private readonly key: string;
  private readonly http: HttpDeps;

  constructor(info: TextModelInfo, key: string, http: HttpDeps = defaultHttpDeps) {
    this.id = info.id;
    this.info = info;
    this.key = key;
    this.http = http;
  }

  async complete(req: TextRequest, signal?: AbortSignal): Promise<TextResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(req, signal);
      } catch (error) {
        const e = error instanceof ModelError ? error : new ModelError('network', `${this.info.provider} 网络错误：${error instanceof Error ? error.message : String(error)}`);
        if (!isRetryable(e) || attempt >= MAX_RETRIES || signal?.aborted) throw e;
        const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) * (0.5 + this.http.random() / 2);
        if (e.retryAfterMs !== null && e.retryAfterMs > MAX_RETRY_AFTER_MS) throw new ModelError(e.kind, `${e.message}（供应商要求等待 ${Math.round(e.retryAfterMs / 1000)} 秒，超过上限，稍后再试）`, e.status, e.retryAfterMs);
        await this.http.sleep(e.retryAfterMs ?? backoff);
      }
    }
  }

  private async once(req: TextRequest, signal?: AbortSignal): Promise<TextResult> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.http.fetch(`${this.info.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({
          model: this.info.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          // 推理模型的推理 token 也算在这里面：长任务给足，否则正文为空、finish_reason 为 length
          max_tokens: req.maxOutputTokens ?? this.info.caps.maxOutputTokens,
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (timeout.aborted) throw new ModelError('timeout', `${this.info.provider} 超时（${TIMEOUT_MS / 1000} 秒）`);
      throw new ModelError('network', `${this.info.provider} 网络错误：${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await res.text();
    if (!res.ok) throw classify(res.status, this.info.provider, body, retryAfterMs(res.headers.get('retry-after')));
    let data: Record<string, any>;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ModelError('server', `${this.info.provider} 返回的不是 JSON：${body.slice(0, 200)}`, res.status);
    }
    const choice = data['choices']?.[0];
    const usage = data['usage'] ?? {};
    return {
      text: typeof choice?.message?.content === 'string' ? choice.message.content : '',
      finishReason: finishOf(choice?.finish_reason),
      usage: {
        inputTokens: num(usage['prompt_tokens']),
        outputTokens: num(usage['completion_tokens']),
        cachedInputTokens: num(usage['prompt_cache_hit_tokens'] ?? usage['prompt_tokens_details']?.['cached_tokens']),
        reasoningTokens: num(usage['completion_tokens_details']?.['reasoning_tokens']),
      },
    };
  }
}

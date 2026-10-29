// 模型调用的失败分类：执行器和界面据此决定重试、提示配凭据，还是直接交给人。消息里不带 key。
export const MODEL_ERROR_KINDS = ['auth', 'rate', 'server', 'bad_request', 'network', 'timeout'] as const;
export type ModelErrorKind = (typeof MODEL_ERROR_KINDS)[number];

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;
  /** 供应商在 Retry-After 里要求等待的毫秒数 */
  readonly retryAfterMs: number | null;
  constructor(kind: ModelErrorKind, message: string, status: number | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 值得等一等再试的失败：限流、服务端错误、网络与超时。 */
export const isRetryable = (e: ModelError): boolean => e.kind === 'rate' || e.kind === 'server' || e.kind === 'network' || e.kind === 'timeout';

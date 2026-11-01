// 百炼（DashScope）Qwen-Image 3.0：文生图与带参考图生成同一个模型、同一个接口（2026-10 的文档）。
// 用异步接口（X-DashScope-Async）：同步接口不留任务记录，崩溃后没法对账。
// 请求体是 input.messages（参考图在前、文字一条），不是旧的 input.prompt；尺寸写成「宽*高」。
// 结果地址与任务记录只保留 24 小时——成功就要立刻下载。
import type { HttpDeps } from './openai-compatible.ts';
import { getJson, numOf, objOf, str, submitJson, SubmitError, truncatedList, unreadable, type ImageModel, type ImageRequest, type ProviderState, type QueryResult, type RecentTask, type SubmitResult } from './media-model.ts';

const PROVIDER = 'dashscope';
/** 内容审核类错误码（大小写两种写法都见过） */
const MODERATION = new Set(['DataInspectionFailed', 'data_inspection_failed', 'IPInfringementSuspect']);
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

const STATES: Readonly<Record<string, ProviderState>> = {
  PENDING: 'submitted',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'cancelled',
  UNKNOWN: 'unknown',
};

/** 列表接口的时间参数：北京时间（UTC+8）的 YYYYMMDDhhmmss。 */
function beijingStamp(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600_000).toISOString();
  return t.slice(0, 19).replace(/[-T:]/g, '');
}

/** gmt_create 可能是毫秒数，也可能是不带时区的北京时间字符串。 */
function parseCreated(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw).toISOString();
  if (typeof raw !== 'string' || !raw) return null;
  const at = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(' ', 'T')}+08:00`);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** 成功任务的图片地址：新格式 choices[].message.content[].image，旧格式 results[].url。 */
function imageUrl(output: Record<string, unknown>): string | undefined {
  const choices = Array.isArray(output['choices']) ? output['choices'] : [];
  for (const c of choices) {
    const content = objOf(objOf(c)['message'])['content'];
    for (const part of Array.isArray(content) ? content : []) {
      const url = str(objOf(part)['image']);
      if (url) return url;
    }
  }
  const results = Array.isArray(output['results']) ? output['results'] : [];
  return results.map((r) => str(objOf(r)['url'])).find(Boolean);
}

export class DashScopeImageModel implements ImageModel {
  readonly id: string;
  readonly provider = PROVIDER;
  readonly model: string;
  private readonly key: string;
  private readonly base: string;
  private readonly http: HttpDeps;

  constructor(model: string, key: string, base: string, http: HttpDeps) {
    this.id = `${PROVIDER}:${model}`;
    this.model = model;
    this.key = key;
    this.base = base;
    this.http = http;
  }

  async submit(req: ImageRequest, signal?: AbortSignal): Promise<SubmitResult> {
    const parameters = { size: req.size, n: 1, prompt_extend: false, watermark: false, ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}) };
    const body = { model: this.model, input: { messages: [{ role: 'user', content: [...req.refs.map((r) => ({ image: r.dataUri })), { text: req.prompt }] }] }, parameters };
    const res = objOf(
      await submitJson(
        this.http,
        PROVIDER,
        { url: `${this.base}/api/v1/services/aigc/image-generation/generation`, method: 'POST', key: this.key, headers: { 'X-DashScope-Async': 'enable' }, body },
        (_status, err) => MODERATION.has(String(objOf(err)['code'] ?? '')),
        signal,
      ),
    );
    const taskId = str(objOf(res['output'])['task_id']);
    if (!taskId) throw new SubmitError('unknown', `${PROVIDER} 提交返回里没有 task_id，任务可能已经建了，等对账确认`);
    return { providerTaskId: taskId, actualInput: { model: this.model, prompt: req.prompt, refs: req.refs.map((r) => r.sha256), parameters } };
  }

  async query(providerTaskId: string, signal?: AbortSignal): Promise<QueryResult> {
    const res = objOf(await getJson(this.http, PROVIDER, { url: `${this.base}/api/v1/tasks/${encodeURIComponent(providerTaskId)}`, method: 'GET', key: this.key }, signal));
    const output = objOf(res['output']);
    const status = typeof output['task_status'] === 'string' ? output['task_status'] : '';
    const mapped = STATES[status];
    if (!mapped) throw unreadable(PROVIDER, status || '（没有 output.task_status）');
    const code = str(output['code']) ?? '';
    const state: ProviderState = status === 'FAILED' && MODERATION.has(code) ? 'rejected' : mapped;
    const usage = objOf(res['usage']);
    const outputImages = numOf(usage['output_image_count']) ?? numOf(usage['image_count']);
    const inputImages = numOf(usage['input_image_count']);
    const url = state === 'succeeded' ? imageUrl(output) : undefined;
    return {
      state,
      providerStatus: status,
      ...(url ? { url } : {}),
      ...(outputImages !== undefined || inputImages !== undefined ? { usage: { ...(outputImages !== undefined ? { outputImages } : {}), ...(inputImages !== undefined ? { inputImages } : {}) } } : {}),
      ...(state === 'failed' || state === 'rejected' ? { error: { code, message: str(output['message']) ?? '' } } : {}),
    };
  }

  /** 整个账号的任务（任何 key 建的都在），只能按模型和时间窗过滤；窗口不超过 24 小时。 */
  async listRecent(window: { since: Date; until: Date }, signal?: AbortSignal): Promise<RecentTask[]> {
    const out: RecentTask[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = new URLSearchParams({ start_time: beijingStamp(window.since), end_time: beijingStamp(window.until), model_name: this.model, page_no: String(page), page_size: String(PAGE_SIZE) });
      const res = objOf(await getJson(this.http, PROVIDER, { url: `${this.base}/api/v1/tasks?${q}`, method: 'GET', key: this.key }, signal));
      const data = Array.isArray(res['data']) ? res['data'] : [];
      for (const d of data) {
        const id = str(objOf(d)['task_id']);
        if (id) out.push({ providerTaskId: id, createdAt: parseCreated(objOf(d)['gmt_create']) });
      }
      if (page >= (numOf(res['total_page']) ?? 1) || data.length === 0) return out;
    }
    throw truncatedList(PROVIDER, MAX_PAGES);
  }
}

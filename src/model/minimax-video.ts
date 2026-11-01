// MiniMax H3 视频（V2 接口）：参考生视频——文字（分镜的 h3Prompt）+ 按 Picture 顺序的参考图（各切关键帧）。
// H3-Lite 的参考生视频不接受 adaptive 画幅，要给具体比例；时长 4–15 秒整数。
// 成功后 task.content.url 是有时效的直链；7 天内重查能拿到新链接。按量付费下失败是否收费官方没写。
import type { HttpDeps } from './openai-compatible.ts';
import { getJson, numOf, objOf, str, submitJson, SubmitError, truncatedList, unreadable, type ProviderState, type QueryResult, type RecentTask, type SubmitResult, type VideoModel, type VideoRequest } from './media-model.ts';

const PROVIDER = 'minimax';
/** 内容审核：创建时 HTTP 422，查询时 error.code 1026 */
const MODERATION_CODE = '1026';
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

const STATES: Readonly<Record<string, ProviderState>> = {
  queued: 'submitted',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** created_at 可能是秒、毫秒或 ISO 字符串（列表接口文档没写清，宽松解析，认不出就 null）。 */
function parseCreated(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw < 1e12 ? raw * 1000 : raw).toISOString();
  if (typeof raw === 'string' && raw) {
    const at = Date.parse(raw);
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  return null;
}

export class MiniMaxVideoModel implements VideoModel {
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

  async submit(req: VideoRequest, signal?: AbortSignal): Promise<SubmitResult> {
    const content = [{ type: 'text', text: req.prompt }, ...req.refs.map((r) => ({ type: 'image_url', image_url: { url: r.dataUri }, role: 'reference_image' }))];
    const body = { model: this.model, content, resolution: req.resolution, duration: req.duration, ratio: req.ratio };
    const res = objOf(await submitJson(this.http, PROVIDER, { url: `${this.base}/v2/video_generation`, method: 'POST', key: this.key, body }, (status) => status === 422, signal));
    const taskId = str(res['task_id']);
    if (!taskId) throw new SubmitError('unknown', `${PROVIDER} 提交返回里没有 task_id，任务可能已经建了，等对账确认`);
    return { providerTaskId: taskId, actualInput: { model: this.model, prompt: req.prompt, refs: req.refs.map((r) => r.sha256), resolution: req.resolution, duration: req.duration, ratio: req.ratio } };
  }

  async query(providerTaskId: string, signal?: AbortSignal): Promise<QueryResult> {
    const res = objOf(await getJson(this.http, PROVIDER, { url: `${this.base}/v2/query/video_generation/${encodeURIComponent(providerTaskId)}`, method: 'GET', key: this.key }, signal));
    const task = objOf(res['task']);
    const status = typeof task['status'] === 'string' ? task['status'] : '';
    const mapped = STATES[status];
    if (!mapped) throw unreadable(PROVIDER, status || '（没有 task.status）');
    const err = objOf(task['error']);
    const code = err['code'] === undefined ? '' : String(err['code']);
    const state: ProviderState = status === 'failed' && code === MODERATION_CODE ? 'rejected' : mapped;
    const usage = objOf(task['usage']);
    const outputSeconds = numOf(usage['output_seconds']);
    const inputImages = numOf(usage['input_image_count']);
    const url = state === 'succeeded' ? str(objOf(task['content'])['url']) : undefined;
    return {
      state,
      providerStatus: status,
      ...(url ? { url } : {}),
      ...(outputSeconds !== undefined || inputImages !== undefined ? { usage: { ...(outputSeconds !== undefined ? { outputSeconds } : {}), ...(inputImages !== undefined ? { inputImages } : {}) } } : {}),
      ...(state === 'failed' || state === 'rejected' ? { error: { code, message: str(err['message']) ?? '' } } : {}),
    };
  }

  /** 近 7 天本模型的任务；接口没有时间参数，取完再按创建时间筛（没有时间的留着，对账时当作「可能是」）。 */
  async listRecent(window: { since: Date; until: Date }, signal?: AbortSignal): Promise<RecentTask[]> {
    const out: RecentTask[] = [];
    let seen = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = new URLSearchParams({ page_num: String(page), page_size: String(PAGE_SIZE), 'filter.model': this.model });
      const res = objOf(await getJson(this.http, PROVIDER, { url: `${this.base}/v2/query/video_generation?${q}`, method: 'GET', key: this.key }, signal));
      const items = Array.isArray(res['items']) ? res['items'] : [];
      seen += items.length;
      for (const it of items) {
        const id = str(objOf(it)['task_id']) ?? str(objOf(it)['id']);
        if (!id) continue;
        const createdAt = parseCreated(objOf(it)['created_at'] ?? objOf(it)['create_time']);
        const at = createdAt ? Date.parse(createdAt) : null;
        if (at !== null && (at < window.since.getTime() || at > window.until.getTime())) continue;
        out.push({ providerTaskId: id, createdAt });
      }
      if (items.length === 0 || seen >= (numOf(res['total']) ?? seen)) return out;
    }
    throw truncatedList(PROVIDER, MAX_PAGES);
  }
}

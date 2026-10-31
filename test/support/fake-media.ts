// 测试共用：可编程的假图片 / 视频供应商。记下每次提交，任务查几次后完成；
// 能模拟审核拒绝、参数错、结果未知（请求到了但没回音）、提交后进程崩溃（供应商建了任务、平台没来得及记 id）。
import { SubmitError, type MediaModel, type QueryResult, type RecentTask, type SubmitResult } from '../../src/model/media-model.ts';

export interface FakeBehavior {
  /** 第几次提交（从 1 起）怎么失败 */
  readonly failSubmit?: ReadonlyMap<number, 'unknown' | 'rate' | 'rejected' | 'invalid'>;
  /** 提示词含这些字的任务在查询时被审核拒绝 */
  readonly rejectPrompts?: readonly string[];
  /** 查几次后完成（默认 1） */
  readonly pollsToFinish?: number;
  /** 第几次提交：供应商建了任务，但平台这边抛错（模拟提交后、记 id 前进程崩溃） */
  readonly crashAfterSubmit?: number;
  /** 第几次提交：请求在路上丢了（供应商没建任务），平台收到「结果未知」 */
  readonly lostSubmit?: number;
  /** 查询时：'unknown' = 供应商说查不到；'throw' = 查询出错（看不懂的状态、网络） */
  readonly queryMode?: 'unknown' | 'throw';
  /** 任务列表：抛错（翻页到上限没取完等） */
  readonly listThrows?: boolean;
}

interface FakeTask {
  readonly id: string;
  readonly prompt: string;
  readonly refs: number;
  readonly createdAt: string;
  polls: number;
}

export class CrashAfterSubmit extends Error {}

export class FakeMediaModel<R extends { prompt: string; refs: readonly unknown[] }> implements MediaModel<R> {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly submits: R[] = [];
  readonly tasks: FakeTask[] = [];
  readonly queries: string[] = [];
  private readonly behavior: FakeBehavior;
  private readonly kind: 'image' | 'video';

  constructor(provider: string, model: string, kind: 'image' | 'video', behavior: FakeBehavior = {}) {
    this.provider = provider;
    this.model = model;
    this.id = `${provider}:${model}`;
    this.kind = kind;
    this.behavior = behavior;
  }

  async submit(req: R): Promise<SubmitResult> {
    this.submits.push(req);
    const n = this.submits.length;
    const fail = this.behavior.failSubmit?.get(n);
    if (fail) throw new SubmitError(fail, `fake ${fail}`, fail === 'rate' ? 0 : null);
    if (this.behavior.lostSubmit === n) throw new SubmitError('unknown', 'fake 请求丢了');
    const task: FakeTask = { id: `${this.provider}-${n}`, prompt: req.prompt, refs: req.refs.length, createdAt: new Date().toISOString(), polls: 0 };
    this.tasks.push(task);
    if (this.behavior.crashAfterSubmit === n) throw new CrashAfterSubmit('fake 进程在记 id 之前死了');
    return { providerTaskId: task.id, actualInput: { prompt: req.prompt, refs: req.refs.length } };
  }

  async query(providerTaskId: string): Promise<QueryResult> {
    this.queries.push(providerTaskId);
    if (this.behavior.queryMode === 'throw') throw new Error('fake 看不懂的状态');
    if (this.behavior.queryMode === 'unknown') return { state: 'unknown', providerStatus: 'UNKNOWN' };
    const t = this.tasks.find((x) => x.id === providerTaskId);
    if (!t) return { state: 'unknown', providerStatus: 'UNKNOWN' };
    t.polls += 1;
    if (t.polls < (this.behavior.pollsToFinish ?? 1)) return { state: 'running', providerStatus: 'running' };
    if (this.behavior.rejectPrompts?.some((p) => t.prompt.includes(p))) return { state: 'rejected', providerStatus: 'failed', error: { code: 'moderation', message: '审核没过' } };
    const usage = this.kind === 'image' ? { outputImages: 1, inputImages: t.refs } : { outputSeconds: 6, inputImages: t.refs };
    return { state: 'succeeded', providerStatus: 'succeeded', url: `https://fake/${t.id}.${this.kind === 'image' ? 'png' : 'mp4'}`, usage };
  }

  async listRecent(): Promise<RecentTask[]> {
    if (this.behavior.listThrows) throw new Error('fake 任务列表没取完');
    return this.tasks.map((t) => ({ providerTaskId: t.id, createdAt: t.createdAt }));
  }
}

/** 假下载：按扩展名写几个字节，记下下载过的地址；failUrls 里的地址抛错。 */
export function fakeDownload(failUrls: Set<string> = new Set()) {
  const got: string[] = [];
  const download = async (url: string, dest: string): Promise<{ mime: string }> => {
    got.push(url);
    if (failUrls.has(url)) throw new Error('fake 下载失败');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dest, `bytes of ${url}`);
    return { mime: url.endsWith('.mp4') ? 'video/mp4' : 'image/png' };
  };
  return { got, download };
}

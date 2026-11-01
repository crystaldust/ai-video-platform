// 付费生成的执行：按计划好的任务调度、提交、轮询、下载入库。
// 提交纪律（防重复付费）：先把任务写成「提交中」再发请求；同一时刻只有一个提交在路上（逐个 await）；
// 结果未知（网络错误、超时、5xx）就停在「提交中」等对账，绝不自动重提；限流确定没建任务，等一等再提同一条。
// 依赖：派生视图、关键帧等锚点入库，视频等这一段各切关键帧入库；依赖死了（被拒、失败、结果未知）就不提交，汇总里说明。
// 预算（人民币）：已花 + 在途预估 + 这一条预估超过上限就不再提交，剩下的保持 planned。
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { lookupPrice, type PriceSources, type PriceUnit } from '../pricing/prices.ts';
import type { Project } from '../project.ts';
import { addCandidate, candidateOfTask, nextLabel } from '../repo/candidates.ts';
import { addMediaFile } from '../repo/media.ts';
import type { PaidGateRow } from '../repo/paid-gates.ts';
import { getTask, listTasks, markSubmitting, recordProviderId, transition, type PaidNode, type TaskRow } from '../repo/tasks.ts';
import { SubmitError, type ImageRequest, type MediaModel, type MediaUsage, type QueryResult, type RefImage, type VideoRequest } from '../model/media-model.ts';
import { TASK_STATUSES, TERMINAL, type TaskStatus } from './state-machine.ts';

export type AnyMediaModel = MediaModel<ImageRequest> | MediaModel<VideoRequest>;
export type Download = (url: string, dest: string, signal?: AbortSignal) => Promise<{ mime: string }>;

export interface GenerateOptions {
  readonly modelFor: (provider: string, model: string) => AnyMediaModel;
  readonly prices: PriceSources;
  readonly download?: Download;
  readonly pid?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 两轮轮询之间等多久（毫秒） */
  readonly pollMs?: number;
  /** 在途任务数上限：图片、视频分开算 */
  readonly concurrency?: { readonly image?: number; readonly video?: number };
  readonly onProgress?: (e: GenerateEvent) => void;
  readonly signal?: AbortSignal;
  /** false：只查询、下载在途任务，不提交新的（崩溃恢复后续跑用；提交要人发起） */
  readonly submit?: boolean;
}

export type GenerateEvent = { readonly type: 'task'; readonly taskId: number; readonly node: PaidNode | null; readonly label: string | null; readonly status: TaskStatus };

export interface GenerateSummary {
  readonly gateId: number;
  readonly counts: Readonly<Record<TaskStatus, number>>;
  /** 依赖死了、没提交的任务 */
  readonly blocked: readonly { readonly taskId: number; readonly label: string; readonly reason: string }[];
  readonly budgetStopped: boolean;
  /** 人民币：已花 + 在途预估 */
  readonly spent: number;
  readonly cap: number | null;
  /** 提交结果未知、停在「提交中」等对账的任务 */
  readonly unknownSubmits: readonly number[];
  /** 生成成功但这次没下载下来的任务（再跑或 tasks requery 会重新下载） */
  readonly downloadFailed: readonly number[];
  /** 连续查询出错、这次先放下的在途任务（还在供应商那边，可能还在计费；再跑或 tasks resume 会接着查） */
  readonly pollGaveUp: readonly number[];
  /** 各任务最后一次出错的原因（查询、下载、提交结果未知），给人看 */
  readonly problems: readonly { readonly taskId: number; readonly error: string }[];
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_CONCURRENCY = { image: 4, video: 3 };
const MAX_RATE_RETRIES = 5;
const MAX_QUERY_FAILURES = 3;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** 还没花钱的状态；其余状态实际费用为空时按预估算（未知、失败的可能已经计费，宁可多算） */
const UNSPENT: ReadonlySet<TaskStatus> = new Set(['planned', 'cancelled']);
const FREE_VIDEO_REFS = 5;

const depsOf = (t: TaskRow): string[] => {
  const d = (t.plannedInput as { deps?: unknown }).deps;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [];
};
const keyOf = (t: TaskRow): string => `${t.node}|${t.label}`;
const field = (t: TaskRow, name: string): unknown => (t.plannedInput as Record<string, unknown>)[name];

/**
 * 默认下载：只走 https（跳转后也必须是 https）、带超时；先看 content-length，再边读边数，超过上限就停，不整个读进内存再判断。
 * 不带任何凭据。
 */
export const fetchDownload: Download = async (url, dest, signal) => {
  if (new URL(url).protocol !== 'https:') throw new Error('结果地址不是 https，不下载');
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）`);
  if (new URL(res.url || url).protocol !== 'https:') throw new Error('结果地址跳转到了非 https，不下载');
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`文件太大（${declared} 字节）`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error(`文件太大（超过 ${MAX_DOWNLOAD_BYTES} 字节）`);
    chunks.push(Buffer.from(chunk));
  }
  writeFileSync(dest, Buffer.concat(chunks), { mode: 0o600 });
  return { mime: (res.headers.get('content-type') ?? '').split(';')[0]!.trim() };
};

const EXT: Readonly<Record<string, string>> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4' };

class Run {
  private readonly project: Project;
  private readonly gate: PaidGateRow;
  private readonly opts: GenerateOptions;
  private readonly pid: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly unknownSubmits: number[] = [];
  readonly downloadFailed = new Set<number>();
  readonly blocked = new Map<number, { label: string; reason: string }>();
  private readonly queryFailures = new Map<number, number>();
  readonly problems = new Map<number, string>();
  /** 有提交结果未知的供应商：这次不再往它提交，免得对账时间窗里出现多个分不清的任务 */
  readonly stalled = new Set<string>();
  budgetStopped = false;

  constructor(project: Project, gate: PaidGateRow, opts: GenerateOptions) {
    this.project = project;
    this.gate = gate;
    this.opts = opts;
    this.pid = opts.pid ?? process.pid;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get db() {
    return this.project.db;
  }

  tasks(): TaskRow[] {
    return listTasks(this.db, { paidGateId: this.gate.id });
  }

  private emit(t: TaskRow): void {
    this.opts.onProgress?.({ type: 'task', taskId: t.id, node: t.node, label: t.label, status: t.status });
  }

  private model(t: TaskRow): AnyMediaModel {
    return this.opts.modelFor(t.provider, t.model);
  }

  /** 已入库的依赖（任何确认单都算），没有就 null。 */
  private collected(key: string): TaskRow | null {
    const [node, label] = key.split('|') as [PaidNode, string];
    return listTasks(this.db, { status: ['collected'], node }).filter((t) => t.label === label).at(-1) ?? null;
  }

  /** 依赖的状态：ready 都入库了；dead 有一个再也等不到（原因）；否则等着。 */
  depState(t: TaskRow, inGate: readonly TaskRow[]): { state: 'ready' } | { state: 'waiting' } | { state: 'dead'; reason: string } {
    let waiting = false;
    for (const key of depsOf(t)) {
      if (this.collected(key)) continue;
      const dep = inGate.find((x) => keyOf(x) === key);
      const what = key.startsWith('image:keyframe') ? '关键帧' : '锚点图';
      if (!dep) return { state: 'dead', reason: `要用的${what} ${key.split('|')[1]} 不在这张确认单里，也没有生成过` };
      if (TERMINAL.has(dep.status) || dep.status === 'unknown' || this.unknownSubmits.includes(dep.id)) return { state: 'dead', reason: `要用的${what} ${dep.label} ${dep.status === 'submitting' ? '提交结果未知' : dep.status}` };
      waiting = true;
    }
    return waiting ? { state: 'waiting' } : { state: 'ready' };
  }

  spent(tasks: readonly TaskRow[]): number {
    return tasks.reduce((a, t) => a + (t.costActual ?? (UNSPENT.has(t.status) ? 0 : (t.costEstimate ?? 0))), 0);
  }

  /** 参考图：依赖按顺序取素材库文件，转成 data URI。 */
  private refs(t: TaskRow): RefImage[] {
    return depsOf(t).map((key) => {
      const dep = this.collected(key)!;
      const cand = candidateOfTask(this.db, dep.id);
      const media = cand && (this.db.prepare('SELECT sha256, rel_path, mime FROM media_file WHERE id = ?').get(cand.mediaFileId) as { sha256: string; rel_path: string; mime: string } | undefined);
      if (!media) throw new Error(`依赖 ${key} 入库了但找不到文件`);
      const root = resolve(this.project.dir, 'media');
      const abs = resolve(this.project.dir, media.rel_path);
      if (!abs.startsWith(root + sep)) throw new Error(`依赖 ${key} 的文件路径不在素材目录里`);
      const b64 = readFileSync(abs).toString('base64');
      return { sha256: media.sha256, dataUri: `data:${media.mime.toLowerCase()};base64,${b64}` };
    });
  }

  private request(t: TaskRow, refs: RefImage[]): ImageRequest | VideoRequest {
    const prompt = String(field(t, 'prompt') ?? '');
    if (t.capability === 'video') return { prompt, refs, duration: Number(field(t, 'duration')), resolution: String(field(t, 'resolution')), ratio: String(field(t, 'ratio')) };
    const negative = field(t, 'negativePrompt');
    return { prompt, size: String(field(t, 'size')), refs, ...(typeof negative === 'string' && negative ? { negativePrompt: negative } : {}) };
  }

  /** 先写库（提交中），再发；只发这一次，限流例外。 */
  async submit(t: TaskRow): Promise<void> {
    let req: ImageRequest | VideoRequest;
    try {
      req = this.request(t, this.refs(t));
    } catch (e) {
      this.emit(transition(this.db, t.id, 'failed', { error: (e as Error).message }));
      return;
    }
    this.emit(markSubmitting(this.db, t.id, this.pid));
    const model = this.model(t) as MediaModel<ImageRequest | VideoRequest>;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await model.submit(req, this.opts.signal);
        this.emit(recordProviderId(this.db, t.id, r.providerTaskId, r.actualInput));
        return;
      } catch (e) {
        if (!(e instanceof SubmitError)) throw e;
        if (e.kind === 'rate' && attempt < MAX_RATE_RETRIES) {
          await this.sleep(e.retryAfterMs ?? 2 ** attempt * 1000);
          continue;
        }
        if (e.kind === 'unknown') {
          this.unknownSubmits.push(t.id);
          this.stalled.add(t.provider);
          this.problems.set(t.id, `提交结果未知，等对账（tasks resume）；这次不再往 ${t.provider} 提交：${e.message}`);
          return;
        }
        const to = e.kind === 'rejected' ? 'rejected' : 'failed';
        const message = e.kind === 'rate' ? `多次限流，没有提交成功：${e.message}` : e.message;
        this.emit(transition(this.db, t.id, to, { error: message, costActual: to === 'rejected' ? this.rejectedCost(t) : 0 }));
        return;
      }
    }
  }

  /** 百炼：失败、审核不过不收费；MiniMax 按量付费下官方没写，记 null。 */
  private rejectedCost(t: TaskRow): number | null {
    return t.provider === 'dashscope' ? 0 : null;
  }

  /** 按用量算实际费用（人民币）；用量缺就按预估，单价查不到记 null。 */
  private actualCost(t: TaskRow, usage: MediaUsage | undefined): number | null {
    if (!usage) return t.costEstimate;
    const est = this.gate.estimate.nodes.find((n) => n.node === t.node);
    if (!est) return null;
    const parts: [PriceUnit, number][] =
      t.capability === 'video'
        ? [['video_second', usage.outputSeconds ?? 0], ['ref_image_extra', Math.max(0, (usage.inputImages ?? 0) - FREE_VIDEO_REFS)]]
        : [['image', usage.outputImages ?? 1], ['ref_image', usage.inputImages ?? 0]];
    let usd = 0;
    for (const [unit, qty] of parts) {
      if (qty === 0) continue;
      const hit = lookupPrice(this.opts.prices, est.model, unit, est.params);
      if (!hit || hit.entry.currency !== 'USD') return null;
      usd += hit.entry.price * qty;
    }
    return usd * this.gate.estimate.fx.usdToCny;
  }

  /** 查一次在途任务，按结果转状态。查询出错不改状态，连续几次就这次先放下（汇总里列出）。 */
  async poll(t: TaskRow): Promise<void> {
    let q: QueryResult;
    try {
      q = await this.model(t).query(t.providerTaskId!, this.opts.signal);
    } catch (e) {
      this.queryFailures.set(t.id, (this.queryFailures.get(t.id) ?? 0) + 1);
      this.problems.set(t.id, `查询出错：${(e as Error).message}`);
      return;
    }
    this.queryFailures.delete(t.id);
    try {
      this.apply(t, q);
    } catch (e) {
      // 供应商给的状态和我们记的接不上（如已成功又说被拒）：不让整个运行崩掉，记下交给人
      this.problems.set(t.id, `状态对不上：${(e as Error).message}`);
    }
  }

  private apply(t: TaskRow, q: QueryResult): void {
    const patch = { providerStatus: q.providerStatus };
    if (q.state === 'submitted') {
      // 未知的任务人指定了 id、供应商说还在排队：转回已提交
      transition(this.db, t.id, t.status === 'unknown' ? 'submitted' : t.status, patch);
    } else if (q.state === 'running') {
      this.emit(transition(this.db, t.id, 'running', patch));
    } else if (q.state === 'succeeded') {
      this.emit(transition(this.db, t.id, 'succeeded', { ...patch, resultUrl: q.url ?? null, costActual: this.actualCost(t, q.usage) }, q.usage ?? null));
    } else if (q.state === 'unknown') {
      // 不判失败：判了失败就能重新生成，而它可能已经计费——交给人到供应商控制台核对
      this.emit(transition(this.db, t.id, 'unknown', { ...patch, error: '供应商查不到这个任务（过期或不存在）：到供应商控制台核对' }));
    } else {
      const error = q.state === 'rejected' ? `内容审核没通过：${q.error?.message ?? ''}` : (q.error?.message ?? q.state);
      this.emit(transition(this.db, t.id, q.state, { ...patch, error, costActual: q.state === 'rejected' || q.state === 'failed' ? this.rejectedCost(t) : null }));
    }
  }

  pollGaveUp(t: TaskRow): boolean {
    return (this.queryFailures.get(t.id) ?? 0) >= MAX_QUERY_FAILURES;
  }

  /** 下载入库建候选 → collected。中途死了也能续：已有候选就直接转。 */
  async collect(t: TaskRow): Promise<void> {
    if (!candidateOfTask(this.db, t.id)) {
      if (!t.resultUrl) throw new Error('没有结果地址');
      const dest = join(tmpdir(), `avp-dl-${randomUUID()}`);
      let typed: string | null = null;
      try {
        const { mime } = await (this.opts.download ?? fetchDownload)(t.resultUrl, dest, this.opts.signal);
        const ext = EXT[mime];
        if (!ext) throw new Error(`下载到的不是图片或视频（${mime || '没有类型'}）`);
        typed = `${dest}${ext}`;
        renameSync(dest, typed);
        const media = await addMediaFile(this.project, typed);
        const entity = this.db.prepare('SELECT entity_id FROM entity_version WHERE id = ?').get(t.targetVersionId) as { entity_id: number };
        const prefix = t.node === 'image:character-refs' ? `${String(t.label).split(':')[1]} ` : '';
        addCandidate(this.db, { taskId: t.id, mediaFileId: media.id, label: nextLabel(this.db, entity.entity_id, prefix) });
      } finally {
        rmSync(dest, { force: true });
        if (typed) rmSync(typed, { force: true });
      }
    }
    this.emit(transition(this.db, t.id, 'collected'));
  }
}

const count = (tasks: readonly TaskRow[]): Record<TaskStatus, number> => Object.fromEntries(TASK_STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length])) as Record<TaskStatus, number>;

/** 跑一张已计划好的确认单，直到没有能推进的任务。返回汇总。 */
export async function runGeneration(project: Project, gate: PaidGateRow, opts: GenerateOptions): Promise<GenerateSummary> {
  const run = new Run(project, gate, opts);
  const limit = { ...DEFAULT_CONCURRENCY, ...opts.concurrency };
  while (!opts.signal?.aborted) {
    let progressed = false;
    for (const t of run.tasks().filter((x) => (x.status === 'submitted' || x.status === 'running') && x.providerTaskId && !run.pollGaveUp(x))) {
      await run.poll(t);
      progressed = progressed || getTask(project.db, t.id)!.status !== t.status;
    }
    for (const t of run.tasks().filter((x) => x.status === 'succeeded' && !run.downloadFailed.has(x.id))) {
      try {
        await run.collect(t);
        progressed = true;
      } catch (e) {
        run.downloadFailed.add(t.id);
        run.problems.set(t.id, `下载入库失败：${(e as Error).message}`);
      }
    }
    if (opts.submit !== false) progressed = (await submitReady(run, gate, limit)) || progressed;
    const waiting = run.tasks().some((x) => (x.status === 'submitted' || x.status === 'running') && !run.pollGaveUp(x));
    if (!waiting && !progressed) break;
    if (waiting) await run.sleep(opts.pollMs ?? DEFAULT_POLL_MS);
  }
  const tasks = run.tasks();
  return {
    gateId: gate.id,
    counts: count(tasks),
    blocked: [...run.blocked.entries()].filter(([id]) => getTask(project.db, id)!.status === 'planned').map(([taskId, b]) => ({ taskId, ...b })),
    budgetStopped: run.budgetStopped,
    spent: run.spent(tasks),
    cap: gate.budgetCap,
    unknownSubmits: run.unknownSubmits.filter((id) => getTask(project.db, id)!.status === 'submitting'),
    downloadFailed: [...run.downloadFailed].filter((id) => getTask(project.db, id)!.status === 'succeeded'),
    pollGaveUp: tasks.filter((t) => (t.status === 'submitted' || t.status === 'running') && run.pollGaveUp(t)).map((t) => t.id),
    problems: [...run.problems.entries()].map(([taskId, error]) => ({ taskId, error })),
  };
}

/**
 * 单个任务再查一次（重新查询，不花钱）：在途的查询状态，成功了的（含之前没下载下来的）重新取结果地址并下载入库。
 * 返回查完之后的任务；下载失败抛错。
 */
export async function refreshTask(project: Project, gate: PaidGateRow, taskId: number, opts: GenerateOptions): Promise<TaskRow> {
  const run = new Run(project, gate, opts);
  const t = getTask(project.db, taskId);
  if (!t) throw new Error(`没有这个任务：${taskId}`);
  if (!t.providerTaskId) throw new Error(`任务 ${taskId} 还没有供应商任务 id（${t.status}）：提交中的先 tasks resume 对账；未知的用 --provider-id 指定`);
  if (t.status === 'submitted' || t.status === 'running' || t.status === 'succeeded' || t.status === 'unknown') await run.poll(t);
  const now = getTask(project.db, taskId)!;
  if (now.status === 'succeeded') await run.collect(now);
  return getTask(project.db, taskId)!;
}

/** 提交依赖都入库了的 planned 任务：在途数、预算都在限内才提交，逐个 await（同一时刻只有一个提交在路上）。 */
async function submitReady(run: Run, gate: PaidGateRow, limit: { image: number; video: number }): Promise<boolean> {
  let progressed = false;
  for (const t of run.tasks().filter((x) => x.status === 'planned')) {
    const all = run.tasks();
    const dep = run.depState(t, all);
    if (dep.state === 'dead') {
      run.blocked.set(t.id, { label: t.label ?? String(t.id), reason: dep.reason });
      continue;
    }
    if (dep.state === 'waiting' || run.stalled.has(t.provider)) continue;
    if (gate.budgetCap !== null && t.costEstimate === null) {
      run.blocked.set(t.id, { label: t.label ?? String(t.id), reason: '单价查不到、没法预估费用：设了预算上限就不提交（补上单价或去掉上限）' });
      continue;
    }
    const cap = t.capability === 'video' ? limit.video : limit.image;
    if (all.filter((x) => x.capability === t.capability && (x.status === 'submitted' || x.status === 'running')).length >= cap) continue;
    if (gate.budgetCap !== null && run.spent(all) + (t.costEstimate ?? 0) > gate.budgetCap + 1e-9) {
      run.budgetStopped = true;
      break;
    }
    await run.submit(t);
    progressed = true;
  }
  return progressed;
}

// 后台任务：一键跑、打回都要跑好几分钟，不能挂在请求上。请求只负责开任务，进度经事件总线推给页面。
// 每个项目同一时刻只跑一个任务（编排自己也有库里的锁，这里先在进程内挡掉，回 409）。
// 付费生成也是后台任务：确认后开跑、页面上能停（只在两次提交之间停）、能继续；服务启动时对账续查（不提交）。
import type { Stage } from '../domain/types.ts';
import type { ProgressEvent } from '../executor/run-node.ts';
import { orchestrate, type OrchestrateEvent } from '../orchestrate/orchestrator.ts';
import { fillCharacterRefs } from '../orchestrate/refs-only.ts';
import { reject, rejectMany } from '../orchestrate/revisions.ts';
import type { GenerateEvent } from '../generate/runner.ts';
import { generateOnce, needsResume, resumeAll } from '../generate/session.ts';
import type { OrchestrationMode } from '../repo/orchestrations.ts';
import { getPaidGate } from '../repo/paid-gates.ts';
import type { App } from './app.ts';
import { HttpError } from './http.ts';
import { STAGE_TITLES } from './views/common.ts';

export type JobKind = 'go' | 'reject' | 'generate' | 'resume' | 'requery';

const STOPPABLE: ReadonlySet<JobKind> = new Set(['generate', 'resume']);

export interface JobInfo {
  readonly kind: JobKind;
  readonly startedAt: string;
  readonly detail: string;
  /** 付费生成跑的是哪张确认单 */
  readonly gateId?: number;
}

/** 编排进度 → 页面要的事件（只带页面会用到的字段）。 */
function fromOrchestrate(e: OrchestrateEvent): { type: string; [k: string]: unknown } {
  if (e.type === 'run') return { ...e.event, type: `run-${e.event.type}` };
  if (e.type === 'stage') return { type: 'stage', ...e.result };
  if (e.type === 'paid-gate') return { type: 'paid-gate', gateId: e.gate.id };
  return { type: 'layer', stages: e.stages };
}

export interface GenerationFailure {
  readonly gateId: number;
  readonly message: string;
  readonly at: string;
}

export class Jobs {
  private readonly app: App;
  private readonly active = new Map<string, JobInfo>();
  /** 最近一个任务的结束（测试与 E2E 等它） */
  private readonly done = new Map<string, Promise<void>>();
  /** 每个项目最近一次付费生成失败（哪张确认单、原因）：只在内存里，下次开跑这张确认单时清掉。页面靠它说清楚为什么没出图 */
  private readonly failures = new Map<string, GenerationFailure>();
  /** 能停的任务（付费生成、恢复）的停止开关 */
  private readonly aborts = new Map<string, AbortController>();

  constructor(app: App) {
    this.app = app;
  }

  current(projectId: string): JobInfo | null {
    return this.active.get(projectId) ?? null;
  }

  /** 最近一次付费生成失败；这张确认单之后又开跑过就没有了。 */
  lastFailure(projectId: string): GenerationFailure | null {
    return this.failures.get(projectId) ?? null;
  }

  /** 等这个项目当前的任务结束（没有任务立即返回）。 */
  settled(projectId: string): Promise<void> {
    return this.done.get(projectId) ?? Promise.resolve();
  }

  private start(projectId: string, kind: JobKind, detail: string, work: () => Promise<unknown>, extra: { gateId?: number; abort?: AbortController } = {}): JobInfo {
    if (this.active.has(projectId)) throw new HttpError(409, `这个项目已有任务在跑（${this.active.get(projectId)!.detail}），等它结束`);
    const info: JobInfo = { kind, startedAt: new Date().toISOString(), detail, ...(extra.gateId !== undefined ? { gateId: extra.gateId } : {}) };
    this.active.set(projectId, info);
    if (extra.abort) this.aborts.set(projectId, extra.abort);
    const { bus, config } = this.app;
    bus.publish(projectId, { type: 'job-start', ...info });
    const promise = work()
      .then((result) => bus.publish(projectId, { type: 'job-end', kind, ok: true, result }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        config.log(`后台任务失败（${projectId} ${detail}）：${message}`);
        if (kind === 'generate' && extra.gateId !== undefined) this.failures.set(projectId, { gateId: extra.gateId, message, at: new Date().toISOString() });
        bus.publish(projectId, { type: 'job-end', kind, ok: false, message });
      })
      .finally(() => {
        this.active.delete(projectId);
        this.aborts.delete(projectId);
      });
    this.done.set(projectId, promise);
    return info;
  }

  go(projectId: string, mode: OrchestrationMode, only?: Stage, fresh?: boolean): JobInfo {
    const { app } = this;
    const publish = (e: OrchestrateEvent) => app.bus.publish(projectId, fromOrchestrate(e));
    return this.start(projectId, 'go', only ? `重跑${STAGE_TITLES[only]}阶段${fresh ? '（整份重写）' : ''}` : mode === 'only-stale' ? '只重跑需复核' : '一键跑', () =>
      app.withProject(projectId, async (p) => {
        const r = await orchestrate(p, {
          modelFor: (stage) => app.modelFor(p, stage),
          ...(only ? { only } : { mode }),
          onProgress: publish,
          ...(app.config.run || fresh ? { run: { ...app.config.run, ...(fresh ? { fresh } : {}) } } : {}),
          ...(app.config.estimate ? { estimate: app.config.estimate } : {}),
        });
        return { orchestrationId: r.id, status: r.status, paidGateId: r.paidGate?.id ?? null };
      }),
    );
  }

  /** 同一条意见依次打回几集（一个任务里一集一集地跑，一集失败不影响别的）；结束时带逐集结果。 */
  rejectMany(projectId: string, stage: Stage, note: string, episodes: readonly { id: string; ep: number | null }[]): JobInfo {
    const { app } = this;
    const publish = (e: ProgressEvent) => app.bus.publish(projectId, { ...e, type: `run-${e.type}` });
    const which = `第 ${episodes.map((e) => (e.ep === null ? e.id : String(e.ep).padStart(2, '0'))).join('、')} 集`;
    return this.start(projectId, 'reject', `打回${STAGE_TITLES[stage]}（${which}）`, () =>
      app.withProject(projectId, async (p) => {
        const r = await rejectMany(p, stage, { model: app.modelFor(p, stage), note, episodes: episodes.map((e) => e.id), onProgress: publish, ...app.config.run });
        return { stage, episodes: r.episodes, pending: r.pending.length };
      }),
    );
  }

  /** 只补出图提示词：角色卡不重写，只补 characterRefs（分镜不读它，不会因此需复核）。 */
  refs(projectId: string): JobInfo {
    const { app } = this;
    const publish = (e: ProgressEvent) => app.bus.publish(projectId, { ...e, type: `run-${e.type}` });
    return this.start(projectId, 'go', '补出图提示词', () =>
      app.withProject(projectId, async (p) => {
        const r = await fillCharacterRefs(p, { model: app.modelFor(p, 'cast'), onProgress: publish, ...app.config.run });
        return { runId: r.outcome.runId, status: r.outcome.status };
      }),
    );
  }

  /** epNo：给人看的集号（任务说明用）；episode 是集 id。 */
  reject(projectId: string, stage: Stage, note: string, episode?: string, epNo?: number): JobInfo {
    const { app } = this;
    const publish = (e: ProgressEvent) => app.bus.publish(projectId, { ...e, type: `run-${e.type}` });
    const which = !episode ? '全部集' : epNo !== undefined ? `第 ${String(epNo).padStart(2, '0')} 集` : `集 ${episode}`;
    return this.start(projectId, 'reject', `打回${STAGE_TITLES[stage]}（${which}）`, () =>
      app.withProject(projectId, async (p) => {
        const r = await reject(p, stage, { model: app.modelFor(p, stage), note, onProgress: publish, ...(episode ? { episode } : {}), ...app.config.run });
        return { runId: r.outcome.runId, status: r.outcome.status, pending: r.pending.length };
      }),
    );
  }

  /** 生成进度 → 页面事件。 */
  private genPublisher(projectId: string, gateId: number | null): (e: GenerateEvent) => void {
    return (e) => this.app.bus.publish(projectId, { type: 'gen-task', gateId, taskId: e.taskId, node: e.node, label: e.label, status: e.status });
  }

  /** 付费生成：对账 → 补计划（跨确认单去重）→ 提交、轮询、下载。确认单必须已确认（调用方先查）。 */
  generate(projectId: string, gateId: number): JobInfo {
    const { app } = this;
    const abort = new AbortController();
    const info = this.start(
      projectId,
      'generate',
      `付费生成 #${gateId}`,
      () =>
        app.withProject(projectId, async (p) => {
          const gate = getPaidGate(p.db, gateId);
          if (!gate || gate.status !== 'confirmed') throw new Error(`确认单 #${gateId} 不是已确认状态，不能生成`);
          const r = await generateOnce(p, gate, app.generateDeps(), { onProgress: this.genPublisher(projectId, gateId), signal: abort.signal });
          const s = r.summary;
          return { gateId, counts: s.counts, spent: s.spent, cap: s.cap, currency: s.currency, budgetStopped: s.budgetStopped, stopped: abort.signal.aborted, skipped: r.skipped.length, problems: s.problems.length + s.blocked.length };
        }),
      { gateId, abort },
    );
    if (this.failures.get(projectId)?.gateId === gateId) this.failures.delete(projectId);
    return info;
  }

  /**
   * 恢复：对账「提交中」、续查在途、下载成功未入库的；不提交新任务。没有要恢复的就什么都不做（返回 null），
   * 免得服务启动时每个项目都发一遍事件、去碰供应商。已有任务在跑也跳过。
   */
  async resume(projectId: string): Promise<JobInfo | null> {
    if (this.active.has(projectId)) return null;
    const { app } = this;
    if (!(await app.withProject(projectId, (p) => needsResume(p)))) return null;
    if (this.active.has(projectId)) return null;
    const abort = new AbortController();
    return this.start(
      projectId,
      'resume',
      '恢复中断的生成任务',
      () =>
        app.withProject(projectId, async (p) => {
          const r = await resumeAll(p, app.generateDeps(), { onProgress: this.genPublisher(projectId, null), signal: abort.signal });
          return { matched: r.recovered.matched.length, notFound: r.recovered.notFound.length, ambiguous: r.recovered.ambiguous.length, gates: r.gates.map((g) => g.gateId) };
        }),
      { abort },
    );
  }

  /**
   * 短的独占操作（重新查询）：同步占住项目再开始，结束就放开；不发任务事件（页面不该因此显示「运行中」）。
   * 和后台任务互斥：有任务在跑回 409；它在跑时别人开任务也回 409。
   */
  async exclusive<T>(projectId: string, detail: string, work: () => Promise<T>): Promise<T> {
    if (this.active.has(projectId)) throw new HttpError(409, `这个项目已有任务在跑（${this.active.get(projectId)!.detail}），等它结束`);
    this.active.set(projectId, { kind: 'requery', startedAt: new Date().toISOString(), detail });
    try {
      return await work();
    } finally {
      this.active.delete(projectId);
    }
  }

  /** 停止付费生成或恢复：在两次提交之间停下，已提交的留着下次续查。 */
  stop(projectId: string): { stopping: true } {
    const job = this.active.get(projectId);
    if (!job || !STOPPABLE.has(job.kind)) throw new HttpError(409, job ? `正在跑的是「${job.detail}」，不能从这里停` : '没有在跑的生成任务');
    this.aborts.get(projectId)?.abort();
    this.app.bus.publish(projectId, { type: 'gen-stop', ...(job.gateId !== undefined ? { gateId: job.gateId } : {}) });
    return { stopping: true };
  }
}

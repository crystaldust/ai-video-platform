// 后台任务：一键跑、打回都要跑好几分钟，不能挂在请求上。请求只负责开任务，进度经事件总线推给页面。
// 每个项目同一时刻只跑一个任务（编排自己也有库里的锁，这里先在进程内挡掉，回 409）。
import type { Stage } from '../domain/types.ts';
import type { ProgressEvent } from '../executor/run-node.ts';
import { orchestrate, type OrchestrateEvent } from '../orchestrate/orchestrator.ts';
import { reject } from '../orchestrate/revisions.ts';
import type { OrchestrationMode } from '../repo/orchestrations.ts';
import type { App } from './app.ts';
import { HttpError } from './http.ts';

export type JobKind = 'go' | 'reject';

export interface JobInfo {
  readonly kind: JobKind;
  readonly startedAt: string;
  readonly detail: string;
}

/** 编排进度 → 页面要的事件（只带页面会用到的字段）。 */
function fromOrchestrate(e: OrchestrateEvent): { type: string; [k: string]: unknown } {
  if (e.type === 'run') return { ...e.event, type: `run-${e.event.type}` };
  if (e.type === 'stage') return { type: 'stage', ...e.result };
  if (e.type === 'paid-gate') return { type: 'paid-gate', gateId: e.gate.id };
  return { type: 'layer', stages: e.stages };
}

export class Jobs {
  private readonly app: App;
  private readonly active = new Map<string, JobInfo>();
  /** 最近一个任务的结束（测试与 E2E 等它） */
  private readonly done = new Map<string, Promise<void>>();

  constructor(app: App) {
    this.app = app;
  }

  current(projectId: string): JobInfo | null {
    return this.active.get(projectId) ?? null;
  }

  /** 等这个项目当前的任务结束（没有任务立即返回）。 */
  settled(projectId: string): Promise<void> {
    return this.done.get(projectId) ?? Promise.resolve();
  }

  private start(projectId: string, kind: JobKind, detail: string, work: () => Promise<unknown>): JobInfo {
    if (this.active.has(projectId)) throw new HttpError(409, `这个项目已有任务在跑（${this.active.get(projectId)!.detail}），等它结束`);
    const info: JobInfo = { kind, startedAt: new Date().toISOString(), detail };
    this.active.set(projectId, info);
    const { bus, config } = this.app;
    bus.publish(projectId, { type: 'job-start', ...info });
    const promise = work()
      .then((result) => bus.publish(projectId, { type: 'job-end', kind, ok: true, result }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        config.log(`后台任务失败（${projectId} ${detail}）：${message}`);
        bus.publish(projectId, { type: 'job-end', kind, ok: false, message });
      })
      .finally(() => this.active.delete(projectId));
    this.done.set(projectId, promise);
    return info;
  }

  go(projectId: string, mode: OrchestrationMode, only?: Stage): JobInfo {
    const { app } = this;
    const publish = (e: OrchestrateEvent) => app.bus.publish(projectId, fromOrchestrate(e));
    return this.start(projectId, 'go', only ? `只跑 ${only}` : mode === 'only-stale' ? '只重跑需复核' : '一键跑', () =>
      app.withProject(projectId, async (p) => {
        const r = await orchestrate(p, {
          modelFor: (stage) => app.modelFor(p, stage),
          ...(only ? { only } : { mode }),
          onProgress: publish,
          ...(app.config.run ? { run: app.config.run } : {}),
          ...(app.config.estimate ? { estimate: app.config.estimate } : {}),
        });
        return { orchestrationId: r.id, status: r.status, paidGateId: r.paidGate?.id ?? null };
      }),
    );
  }

  reject(projectId: string, stage: Stage, note: string, episode?: string): JobInfo {
    const { app } = this;
    const publish = (e: ProgressEvent) => app.bus.publish(projectId, { ...e, type: `run-${e.type}` });
    return this.start(projectId, 'reject', `打回 ${stage}${episode ? ` 第 ${episode} 集` : ''}`, () =>
      app.withProject(projectId, async (p) => {
        const r = await reject(p, stage, { model: app.modelFor(p, stage), note, onProgress: publish, ...(episode ? { episode } : {}), ...app.config.run });
        return { runId: r.outcome.runId, status: r.outcome.status, pending: r.pending.length };
      }),
    );
  }
}

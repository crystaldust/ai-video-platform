// 一次付费生成会话：命令行（generate / tasks resume）和服务的后台任务共用。
// generateOnce = 对账上次中断留下的「提交中」→ 按确认单补计划（跨确认单去重）→ 提交、轮询、下载。
// resumeAll = 只对账、续查、下载，不提交新任务（崩溃恢复；提交要人发起）。
import type { CredentialOptions } from '../config/credentials.ts';
import { createImageModel, createVideoModel, findModel } from '../model/registry.ts';
import { loadPriceSources } from '../pricing/prices.ts';
import type { Project } from '../project.ts';
import { getPaidGate, type PaidGateRow } from '../repo/paid-gates.ts';
import { isAlive } from '../repo/runs.ts';
import { listTasks } from '../repo/tasks.ts';
import { planGate, type SkippedDraft } from './planner.ts';
import { recoverTasks, type RecoverReport } from './recovery.ts';
import { runGeneration, type AnyMediaModel, type GenerateEvent, type GenerateOptions, type GenerateSummary } from './runner.ts';

/** 供应商、价格、下载等可注入的部分（测试给假的）。 */
export type GenerateDeps = Omit<GenerateOptions, 'onProgress' | 'signal' | 'submit' | 'pid'>;

export interface SessionOptions {
  readonly onProgress?: (e: GenerateEvent) => void;
  readonly signal?: AbortSignal;
  readonly concurrency?: GenerateOptions['concurrency'];
}

/** 真的供应商：按模型 id 造，同一个只造一次（凭据缺失时在第一次用到才报）。credentials 只给测试和服务指定凭据目录。 */
export function realGenerateDeps(credentials: CredentialOptions = {}): GenerateDeps {
  const cache = new Map<string, AnyMediaModel>();
  const modelFor = (provider: string, model: string): AnyMediaModel => {
    const id = `${provider}:${model}`;
    if (!cache.has(id)) cache.set(id, findModel(id).capability === 'video' ? createVideoModel(id, credentials) : createImageModel(id, credentials));
    return cache.get(id)!;
  };
  return { modelFor, prices: loadPriceSources() };
}

/**
 * 另一个还活着的进程正在提交：两个生成同时跑会让对账时间窗里出现分不清的任务，拒绝启动。
 * 本进程自己的任务不算「另一个」——服务里靠后台任务的项目锁保证同一时刻只有一个生成。
 */
export function assertNoOtherSubmitter(p: Project): void {
  const other = listTasks(p.db, { status: ['submitting'] }).find((t) => t.pid !== null && t.pid !== process.pid && isAlive(t.pid));
  if (other) throw new Error(`另一个进程（${other.pid}）正在提交任务 ${other.id}：等它结束再跑（它要是已经没了，先 tasks resume）`);
}

export interface GenerateOnceResult {
  readonly recovered: RecoverReport;
  /** 这张确认单的任务数 */
  readonly planned: number;
  readonly skipped: readonly SkippedDraft[];
  readonly summary: GenerateSummary;
}

export async function generateOnce(p: Project, gate: PaidGateRow, deps: GenerateDeps, opts: SessionOptions = {}): Promise<GenerateOnceResult> {
  assertNoOtherSubmitter(p);
  const recovered = await recoverTasks(p, { modelFor: deps.modelFor });
  const plan = planGate(p.db, gate, deps.prices);
  const summary = await runGeneration(p, gate, { ...deps, ...(opts.concurrency ? { concurrency: opts.concurrency } : {}), ...(opts.onProgress ? { onProgress: opts.onProgress } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
  return { recovered, planned: plan.tasks.length, skipped: plan.skipped, summary };
}

/** 有在途或成功未下载任务的确认单。 */
export function gatesInFlight(p: Project): number[] {
  return [...new Set(listTasks(p.db, { status: ['submitted', 'running', 'succeeded'] }).flatMap((t) => (t.paidGateId === null ? [] : [t.paidGateId])))];
}

/** 有需要恢复的任务吗（提交中、在途、成功未下载）：启动时没有就什么都不做，也不去碰供应商。 */
export function needsResume(p: Project): boolean {
  return listTasks(p.db, { status: ['submitting', 'submitted', 'running', 'succeeded'] }).length > 0;
}

export async function resumeAll(p: Project, deps: GenerateDeps, opts: SessionOptions = {}): Promise<{ recovered: RecoverReport; gates: GenerateSummary[] }> {
  const recovered = await recoverTasks(p, { modelFor: deps.modelFor });
  const gates: GenerateSummary[] = [];
  for (const id of gatesInFlight(p)) {
    if (opts.signal?.aborted) break;
    gates.push(await runGeneration(p, getPaidGate(p.db, id)!, { ...deps, submit: false, ...(opts.onProgress ? { onProgress: opts.onProgress } : {}), ...(opts.signal ? { signal: opts.signal } : {}) }));
  }
  return { recovered, gates };
}

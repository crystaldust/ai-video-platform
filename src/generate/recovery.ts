// 崩溃恢复：只处理「进程已经不在」的提交中任务——请求可能已经到了供应商，所以去供应商的任务列表里对账，
// 绝不重新提交。时间窗 = 提交时刻前 2 分钟到后 10 分钟，去掉库里已经记过的 id：
//   唯一匹配 → 补记 id（转已提交，之后照常查询下载）
//   没找到   → 失败（提交没有到达供应商，可以安全重新生成）
//   多个匹配 → 未知（列出候选 id，交给人用 tasks requery 指定）
// 两家都没有幂等键、也不能给任务打自己的标签，所以执行器每家同一时刻只有一个提交在路上，对账才对得准。
// 供应商列表只保留有限时间（百炼 24 小时、MiniMax 7 天）：超过了查不到，不能判「没到达」，判未知。
import type { Project } from '../project.ts';
import { isAlive } from '../repo/runs.ts';
import { listTasks, recordProviderId, transition, type TaskRow } from '../repo/tasks.ts';
import type { AnyMediaModel } from './runner.ts';

const BEFORE_MS = 2 * 60_000;
const AFTER_MS = 10 * 60_000;
const RETENTION_MS: Readonly<Record<string, number>> = { dashscope: 24 * 3600_000, minimax: 7 * 24 * 3600_000 };

export interface RecoverOptions {
  readonly modelFor: (provider: string, model: string) => AnyMediaModel;
  /** 这条任务的进程还在跑它吗；默认：别的进程看进程号是否还在，本进程的算不在（恢复只在没有生成在跑时调用） */
  readonly isActive?: (t: TaskRow) => boolean;
  readonly now?: () => Date;
}

export interface RecoverReport {
  readonly matched: readonly number[];
  readonly notFound: readonly number[];
  readonly ambiguous: readonly number[];
  /** 进程还在、没碰的 */
  readonly skipped: readonly number[];
  /** 对账没做成的（任务列表取不全、查询出错）：保持提交中，原因在这里 */
  readonly errors: readonly { readonly taskId: number; readonly error: string }[];
}

const defaultActive = (t: TaskRow): boolean => t.pid !== null && t.pid !== process.pid && isAlive(t.pid);

export async function recoverTasks(project: Project, opts: RecoverOptions): Promise<RecoverReport> {
  const { db } = project;
  const active = opts.isActive ?? defaultActive;
  const now = (opts.now ?? (() => new Date()))();
  const report = { matched: [] as number[], notFound: [] as number[], ambiguous: [] as number[], skipped: [] as number[], errors: [] as { taskId: number; error: string }[] };
  for (const t of listTasks(db, { status: ['submitting'] })) {
    if (active(t)) {
      report.skipped.push(t.id);
      continue;
    }
    const at = Date.parse(t.submittedAt ?? t.updatedAt);
    if (now.getTime() - at > (RETENTION_MS[t.provider] ?? RETENTION_MS['dashscope']!)) {
      transition(db, t.id, 'unknown', { error: '提交时刻已超出供应商任务列表的保留期，没法对账：请到供应商控制台核对，再用 tasks requery 指定任务 id 或判失败' });
      report.ambiguous.push(t.id);
      continue;
    }
    const since = new Date(at - BEFORE_MS);
    const until = new Date(at + AFTER_MS);
    const known = new Set(listTasks(db, { provider: t.provider }).flatMap((x) => (x.providerTaskId ? [x.providerTaskId] : [])));
    let recent: Awaited<ReturnType<AnyMediaModel['listRecent']>>;
    try {
      recent = await opts.modelFor(t.provider, t.model).listRecent({ since, until });
    } catch (e) {
      // 列表取不全就不能判「没到达」：保持提交中，下次再对
      report.errors.push({ taskId: t.id, error: (e as Error).message });
      continue;
    }
    const candidates = recent.filter((r) => !known.has(r.providerTaskId) && (r.createdAt === null || (Date.parse(r.createdAt) >= since.getTime() && Date.parse(r.createdAt) <= until.getTime())));
    if (candidates.length === 1) {
      recordProviderId(db, t.id, candidates[0]!.providerTaskId);
      report.matched.push(t.id);
    } else if (candidates.length === 0) {
      transition(db, t.id, 'failed', { error: '提交没有到达供应商（对账时供应商任务列表里没有），可以安全重新生成', costActual: 0 });
      report.notFound.push(t.id);
    } else {
      const ids = candidates.map((c) => c.providerTaskId);
      transition(db, t.id, 'unknown', { error: `对账时时间窗里有 ${ids.length} 个可能的供应商任务：${ids.join('、')}——用 tasks requery 指定是哪一个` }, { candidates: ids });
      report.ambiguous.push(t.id);
    }
  }
  return report;
}

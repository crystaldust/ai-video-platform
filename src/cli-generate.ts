// 付费生成的命令：按已确认的付费确认单生成参考图、关键帧、视频；任务列表；崩溃后对账续跑；重新查询；重新生成。
// 进度写 stderr，结果 JSON 写 stdout（同其他命令）。供应商可注入（测试用假的），默认按注册表与凭据造真的。
import type { CommandResult } from './cli-nodes.ts';
import { intFlag, need, withProject } from './cli-shared.ts';
import { regenerateTask, requeryTask } from './generate/manage.ts';
import { planGeneration } from './generate/planner.ts';
import { recoverTasks } from './generate/recovery.ts';
import { runGeneration, type AnyMediaModel, type GenerateOptions, type GenerateSummary } from './generate/runner.ts';
import { isTaskStatus } from './generate/state-machine.ts';
import { createImageModel, createVideoModel, findModel } from './model/registry.ts';
import { loadPriceSources } from './pricing/prices.ts';
import type { Project } from './project.ts';
import { getPaidGate, listPaidGates, type PaidGateRow } from './repo/paid-gates.ts';
import { isAlive } from './repo/runs.ts';
import { isPaidNode, listTasks } from './repo/tasks.ts';

export const GENERATE_USAGE = `  generate <dir> [--gate <id>] [--concurrency <图片数>]
                                                付费生成：按已确认的付费确认单（默认最近一张）出角色参考图、关键帧、视频；
                                                先对账上次中断留下的「提交中」，再提交；到预算上限就停
  tasks <dir> [--status <状态>] [--node <节点>] [--gate <id>]
                                                付费任务列表：状态、供应商任务 id、预估 / 实际费用（人民币）、原因
  tasks resume <dir>                            崩溃后恢复：对账「提交中」的任务，续查在途的、下载成功的；不提交新任务
  tasks requery <dir> <任务 id> [--provider-id <供应商任务 id>]
                                                重新查询（不花钱）；未知的任务可指定在供应商控制台核对过的 id
  tasks regenerate <dir> <任务 id>              重新生成：新建一条任务（再跑 generate 时提交，计入预算）`;

export type GenerateDeps = Omit<GenerateOptions, 'onProgress' | 'signal' | 'submit' | 'pid'>;

const done = (output: unknown, exitCode = 0): CommandResult => ({ output, exitCode });
const write = (line: string): void => void process.stderr.write(`${line}\n`);

/** 真的供应商：按模型 id 造，同一个只造一次（凭据缺失时在第一次用到才报）。 */
function realDeps(): GenerateDeps {
  const cache = new Map<string, AnyMediaModel>();
  const modelFor = (provider: string, model: string): AnyMediaModel => {
    const id = `${provider}:${model}`;
    if (!cache.has(id)) cache.set(id, findModel(id).capability === 'video' ? createVideoModel(id) : createImageModel(id));
    return cache.get(id)!;
  };
  return { modelFor, prices: loadPriceSources() };
}

function gateOf(p: Project, flag: string | undefined): PaidGateRow {
  if (flag !== undefined) {
    const gate = getPaidGate(p.db, intFlag(flag, '--gate')!);
    if (!gate) throw new Error(`没有付费确认单 ${flag}`);
    return gate;
  }
  const gate = listPaidGates(p.db).filter((g) => g.status === 'confirmed').at(-1);
  if (!gate) throw new Error('没有已确认的付费确认单：先在全貌上确认付费生成（或用 --gate 指定）');
  return gate;
}

const progress = (e: { taskId: number; label: string | null; status: string }): void => write(`  任务 ${e.taskId} ${e.label ?? ''} → ${e.status}`);

/** 汇总里有没有需要人看的：被挡住、结果未知、没下载下来、到了预算、失败或被拒。 */
const needsAttention = (s: GenerateSummary): boolean =>
  s.blocked.length > 0 || s.unknownSubmits.length > 0 || s.downloadFailed.length > 0 || s.pollGaveUp.length > 0 || s.budgetStopped || s.counts.failed + s.counts.rejected + s.counts.unknown > 0;

/** 另一个还活着的进程正在提交：两个 generate 同时跑会让对账时间窗里出现分不清的任务，拒绝启动。 */
function assertNoOtherSubmitter(p: Project): void {
  const other = listTasks(p.db, { status: ['submitting'] }).find((t) => t.pid !== null && t.pid !== process.pid && isAlive(t.pid));
  if (other) throw new Error(`另一个进程（${other.pid}）正在提交任务 ${other.id}：等它结束再跑（它要是已经没了，先 tasks resume）`);
}

async function cmdGenerate(args: string[], flags: Record<string, string>, deps: GenerateDeps): Promise<CommandResult> {
  const dir = need(args[0], 'generate <dir> [--gate <id>]');
  return withProject(dir, async (p) => {
    assertNoOtherSubmitter(p);
    const gate = gateOf(p, flags['gate']);
    const recovered = await recoverTasks(p, { modelFor: deps.modelFor });
    const tasks = planGeneration(p.db, gate, deps.prices);
    write(`确认单 ${gate.id}：${tasks.length} 个任务；上限 ${gate.budgetCap === null ? '不设' : `¥${gate.budgetCap}`}`);
    const concurrency = flags['concurrency'] === undefined ? {} : { concurrency: { image: intFlag(flags['concurrency'], '--concurrency')! } };
    const summary = await runGeneration(p, gate, { ...deps, ...concurrency, onProgress: progress });
    return done({ recovered, ...summary }, needsAttention(summary) ? 2 : 0);
  });
}

async function cmdTasks(args: string[], flags: Record<string, string>, deps: GenerateDeps): Promise<CommandResult> {
  const sub = args[0];
  if (sub === 'resume') return cmdResume(args.slice(1), deps);
  if (sub === 'requery') {
    const usage = 'tasks requery <dir> <任务 id> [--provider-id <id>]';
    const [dir, id] = [need(args[1], usage), intFlag(need(args[2], usage), '任务 id')!];
    return withProject(dir, async (p) => done(await requeryTask(p, id, { ...deps, ...(flags['provider-id'] ? { providerTaskId: flags['provider-id'] } : {}) })));
  }
  if (sub === 'regenerate') {
    const usage = 'tasks regenerate <dir> <任务 id>';
    const [dir, id] = [need(args[1], usage), intFlag(need(args[2], usage), '任务 id')!];
    return withProject(dir, (p) => done(regenerateTask(p.db, id)));
  }
  const dir = need(sub, 'tasks <dir> [--status <状态>] [--node <节点>] [--gate <id>]');
  const status = flags['status'];
  if (status !== undefined && !isTaskStatus(status)) throw new Error(`不认识的任务状态：${status}`);
  const node = flags['node'];
  if (node !== undefined && !isPaidNode(node)) throw new Error(`不认识的付费节点：${node}`);
  return withProject(dir, (p) =>
    done(
      listTasks(p.db, { ...(status ? { status: [status] } : {}), ...(node ? { node } : {}), ...(flags['gate'] ? { paidGateId: intFlag(flags['gate'], '--gate')! } : {}) }).map((t) => ({
        id: t.id,
        node: t.node,
        episode: t.episodeKey,
        label: t.label,
        status: t.status,
        providerTaskId: t.providerTaskId,
        costEstimate: t.costEstimate,
        costActual: t.costActual,
        currency: t.currency,
        error: t.error,
        attemptOf: t.attemptOf,
      })),
    ),
  );
}

/** 恢复：对账「提交中」，再把有在途任务的确认单各跑一遍「只查询、下载」。 */
async function cmdResume(args: string[], deps: GenerateDeps): Promise<CommandResult> {
  const dir = need(args[0], 'tasks resume <dir>');
  return withProject(dir, async (p) => {
    const recovered = await recoverTasks(p, { modelFor: deps.modelFor });
    const gateIds = [...new Set(listTasks(p.db, { status: ['submitted', 'running', 'succeeded'] }).flatMap((t) => (t.paidGateId === null ? [] : [t.paidGateId])))];
    const summaries: GenerateSummary[] = [];
    for (const id of gateIds) summaries.push(await runGeneration(p, getPaidGate(p.db, id)!, { ...deps, submit: false, onProgress: progress }));
    return done({ recovered, gates: summaries }, recovered.ambiguous.length || summaries.some(needsAttention) ? 2 : 0);
  });
}

/** 不是付费生成命令时返回 null。deps 只给测试注入；不给就用真的供应商与价格。 */
export async function generateCommand(cmd: string, args: string[], flags: Record<string, string>, deps?: GenerateDeps): Promise<CommandResult | null> {
  if (cmd === 'generate') return cmdGenerate(args, flags, deps ?? realDeps());
  if (cmd === 'tasks') return cmdTasks(args, flags, deps ?? realDeps());
  return null;
}

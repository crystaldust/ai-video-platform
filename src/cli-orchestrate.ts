// 编排相关的命令：一键跑、打回、复核确认、需复核矩阵、付费确认单。进度写 stderr，结果 JSON 写 stdout。
import type { CommandResult } from './cli-nodes.ts';
import { progressLine } from './cli-nodes.ts';
import { intFlag, need, stageArg, withProject } from './cli-shared.ts';
import type { Stage } from './domain/types.ts';
import { createTextModel } from './model/registry.ts';
import type { TextModel } from './model/text-model.ts';
import { orchestrate, type OrchestrateEvent, type StageResult } from './orchestrate/orchestrator.ts';
import { acknowledge, reviewMatrix } from './orchestrate/review-matrix.ts';
import { reject, resolveEpisode } from './orchestrate/revisions.ts';
import type { Project } from './project.ts';
import { resolveNodeModel } from './repo/models.ts';
import { listPaidGates } from './repo/paid-gates.ts';

export const ORCHESTRATE_USAGE = `  go <dir> [--only-stale] [--only <stage> [--fresh]] [--concurrency 3] [--model-cmd "<命令>"] [--max-attempts 3]
                                                一键跑文本阶段：按依赖分层并发，停在付费前生成确认单
                                                （没有产物的从头跑，需复核的只改受影响的集，其余跳过）；
                                                --only-stale 只重跑需复核的部分；--only 只跑一个阶段；
                                                --fresh（配合 --only）不沿用之前写好的集，整份重写。
                                                有阶段转人工或被阻断时退出码 2，失败退出码 1
  reject <dir> <stage> [--ep <集号|集 id>] --note "<意见>" [--model-cmd "<命令>"]
                                                打回：带意见在当前版本上重跑（剧本、站位、分镜可只打回一集）
  review <dir> <stage> [--ep <集号|集 id>] --keep [--note "<说明>"]
                                                看过了、保持现状：这一格不再标需复核（上游再变会重新出现）
  matrix <dir>                                  需复核矩阵：按阶段 × 集列出过期原因、是否已确认、最近一次运行
  gates <dir>                                   付费确认单`;

const done = (output: unknown, exitCode = 0): CommandResult => ({ output, exitCode });
const write = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const STAGE_MARK: Readonly<Record<StageResult['status'], string>> = { passed: '✓', skipped: '·', needs_human: '✗', failed: '✗', blocked: '■' };

function eventLine(e: OrchestrateEvent): string {
  if (e.type === 'layer') return `▸ ${e.stages.join(' ∥ ')}`;
  if (e.type === 'run') return `  ${progressLine(e.event)}`;
  if (e.type === 'paid-gate') {
    const t = e.gate.estimate.total;
    return `■ 停在付费阶段之前：确认单 #${e.gate.id}，预估 $${t.low}–${t.high}（${e.gate.estimate.preset}${e.gate.estimate.incomplete ? '，有节点无价格，合计不完整' : ''}）`;
  }
  const r = e.result;
  return `${STAGE_MARK[r.status]} ${r.stage} ${r.status}${r.episodes ? `（${r.episodes.join('、')}）` : ''}${r.message ? `：${r.message}` : ''}`;
}

/** --model-cmd 给了就所有阶段都用它；否则每个阶段按预设或节点覆盖解析 text:<stage>。 */
function modelFor(p: Project, flags: Record<string, string>): (stage: Stage) => TextModel {
  return (stage) => createTextModel(flags['model-cmd'] ? `cmd:${flags['model-cmd']}` : resolveNodeModel(p.db, `text:${stage}`).model);
}

const runOptions = (flags: Record<string, string>) => {
  const maxAttempts = intFlag(flags['max-attempts'], '--max-attempts');
  return maxAttempts === undefined ? {} : { maxAttempts };
};

const goRunOptions = (flags: Record<string, string>) => ({ ...runOptions(flags), ...(flags['fresh'] ? { fresh: true } : {}) });

async function cmdGo(args: string[], flags: Record<string, string>): Promise<CommandResult> {
  const dir = need(args[0], 'go <dir> [--only-stale] [--only <stage> [--fresh]] [--concurrency 3]');
  if (flags['only-stale'] && flags['only']) throw new Error('--only-stale 与 --only 不能同时给');
  if (flags['fresh'] && !flags['only']) throw new Error('--fresh 只能配合 --only 用：整份重写只针对单个阶段');
  const concurrency = intFlag(flags['concurrency'], '--concurrency');
  const result = await withProject(dir, (p) =>
    orchestrate(p, {
      modelFor: modelFor(p, flags),
      ...(flags['only-stale'] ? { mode: 'only-stale' as const } : {}),
      ...(flags['only'] ? { only: stageArg(flags['only']) } : {}),
      ...(concurrency === undefined ? {} : { concurrency }),
      run: goRunOptions(flags),
      onProgress: (e) => write(eventLine(e)),
    }),
  );
  if (result.paidGateError) write(`⚠ ${result.paidGateError}`);
  return done(result, result.status === 'done' ? 0 : result.status === 'blocked' ? 2 : 1);
}

async function cmdReject(args: string[], flags: Record<string, string>): Promise<CommandResult> {
  const usage = 'reject <dir> <stage> [--ep <集号|集 id>] --note "<意见>"';
  const [dir, stage, note] = [need(args[0], usage), stageArg(need(args[1], usage)), need(flags['note'], usage)];
  const result = await withProject(dir, (p) =>
    reject(p, stage, {
      model: modelFor(p, flags)(stage),
      note,
      ...(flags['ep'] ? { episode: flags['ep'] } : {}),
      ...runOptions(flags),
      onProgress: (e) => write(progressLine(e)),
    }),
  );
  for (const c of result.pending) write(`  需复核：${c.stage}${c.episode ? ` ${c.episode}` : '（跨集共用部分）'}，${c.reasons.length} 处引用过期`);
  return done(result, result.outcome.status === 'passed' ? 0 : result.outcome.status === 'needs_human' ? 2 : 1);
}

async function cmdReview(args: string[], flags: Record<string, string>): Promise<CommandResult> {
  const usage = 'review <dir> <stage> [--ep <集号|集 id>] --keep [--note "<说明>"]';
  const [dir, stage] = [need(args[0], usage), stageArg(need(args[1], usage))];
  if (!flags['keep']) throw new Error(`用法：${usage}（目前只支持 --keep：看过了，保持现状；要改就用 reject）`);
  return done(await withProject(dir, (p) => acknowledge(p.db, stage, flags['ep'] ? resolveEpisode(p.db, flags['ep']) : null, flags['note'] ?? '')));
}

async function cmdGates(args: string[]): Promise<CommandResult> {
  const dir = need(args[0], 'gates <dir>');
  const gates = await withProject(dir, (p) => listPaidGates(p.db));
  // 完整估算很长：列表只给合计与状态，明细见库里的 estimate
  return done(gates.map((g) => ({ id: g.id, status: g.status, orchestrationId: g.orchestrationId, preset: g.estimate.preset, total: g.estimate.total, currency: g.currency, incomplete: g.estimate.incomplete, createdAt: g.createdAt, nodes: g.estimate.nodes.map((n) => ({ node: n.node, model: n.model, cost: n.cost })) })));
}

const COMMANDS: Readonly<Record<string, (args: string[], flags: Record<string, string>) => Promise<CommandResult>>> = {
  go: cmdGo,
  reject: cmdReject,
  review: cmdReview,
  matrix: async (args) => done(await withProject(need(args[0], 'matrix <dir>'), (p) => reviewMatrix(p.db))),
  gates: cmdGates,
};

/** 不是编排命令时返回 null。 */
export async function orchestrateCommand(cmd: string, args: string[], flags: Record<string, string>): Promise<CommandResult | null> {
  const handler = COMMANDS[cmd];
  return handler ? handler(args, flags) : null;
}

// 节点协议相关的命令：注册 skill 包、挂载、项目输入、运行节点、查看与解锁运行记录。
// 进度写 stderr，结果 JSON 写 stdout（管道里仍可解析）。
import { intFlag, need, readJson, readText, stageArg, withProject } from './cli-shared.ts';
import { RECIPE_NAMES } from './executor/recipes.ts';
import { runNode, type ProgressEvent } from './executor/run-node.ts';
import { createTextModel } from './model/registry.ts';
import { resolveNodeModel } from './repo/models.ts';
import { INPUT_KINDS, addInput, type InputKind } from './repo/inputs.ts';
import { getRun, listAttempts, listRuns, unlockRun } from './repo/runs.ts';
import { mountSkill, registerPack } from './repo/skills.ts';

export const NODE_USAGE = `  pack register <dir> <manifest.json> --root <skills 根目录>
                                                注册一套 skill 包，有阶段的 skill 自动挂载（同名旧版自动换成新版）
  mount <dir> <stage> <skill>                   把阶段挂到另一个已注册的 skill
  input <dir> <file.txt> --episodes N --seconds S --genre <题材> [--kind synopsis|novel]
                                                设置项目输入（梗概或小说正文 + 参数）
  run <dir> <stage> [--model-cmd "<命令>"] [--max-attempts 3]
                                                用平台执行器跑一个阶段；不给 --model-cmd 就用预设或节点覆盖里
                                                text:<stage> 的模型；--model-cmd 从 stdin 读提示词、stdout 输出
                                                （按空白切分参数，不支持引号）；转人工时退出码 2
  runs <dir> [--id N]                           列出运行记录；--id 看某次运行的每次尝试
  runs unlock <dir> --id N                      把卡在 running 的运行标为失败（进程已不在但没被认出来时用）`;

export interface CommandResult {
  readonly output: unknown;
  readonly exitCode: number;
}

const done = (output: unknown): CommandResult => ({ output, exitCode: 0 });

const progressLine = (e: ProgressEvent): string => {
  if (e.type === 'run-start') return `▸ ${e.stage} · ${e.skill} · ${e.model}（run ${e.runId}）`;
  if (e.type === 'attempt') return `  ${e.step} #${e.n} ${e.violations.length ? `✗ ${e.violations[0]}` : '✓'}`;
  if (e.type === 'notice') return `  ⚠ ${e.message}`;
  if (e.type === 'gate') return `  门 ${e.gate} ${e.violations.length ? `✗ ${e.violations.length} 处违规` : '✓'}`;
  return `${e.status === 'passed' ? '✓' : '✗'} run ${e.runId} ${e.status}`;
};

async function cmdPack(args: string[], flags: Record<string, string>): Promise<CommandResult> {
  const usage = 'pack register <dir> <manifest.json> --root <skills 根目录>';
  if (args[0] !== 'register') throw new Error(`用法：${usage}`);
  const [dir, file, root] = [need(args[1], usage), need(args[2], usage), need(flags['root'], usage)];
  const manifest = readJson(file);
  const result = await withProject(dir, (p) => registerPack(p.db, manifest, root, RECIPE_NAMES));
  for (const problem of result.problems) process.stderr.write(`⚠ ${problem}\n`);
  return done(result);
}

async function cmdInput(args: string[], flags: Record<string, string>): Promise<CommandResult> {
  const usage = 'input <dir> <file.txt> --episodes N --seconds S --genre <题材> [--kind synopsis|novel]';
  const [dir, file] = [need(args[0], usage), need(args[1], usage)];
  const kind = (flags['kind'] ?? 'synopsis') as InputKind;
  if (!(INPUT_KINDS as readonly string[]).includes(kind)) throw new Error(`--kind 只能是 ${INPUT_KINDS.join(' / ')}`);
  const params = {
    episodes: intFlag(need(flags['episodes'], usage), '--episodes')!,
    seconds: intFlag(need(flags['seconds'], usage), '--seconds')!,
    genre: need(flags['genre'], usage),
  };
  const text = readText(file);
  const row = await withProject(dir, (p) => addInput(p.db, { kind, text, params }));
  return done({ id: row.id, kind: row.kind, chars: row.text.length, params: row.params });
}

async function cmdRun(args: string[], flags: Record<string, string>): Promise<CommandResult> {
  const usage = 'run <dir> <stage> [--model-cmd "<命令>"] [--max-attempts 3]';
  const [dir, stage] = [need(args[0], usage), stageArg(need(args[1], usage))];
  const maxAttempts = intFlag(flags['max-attempts'], '--max-attempts');
  const out = await withProject(dir, (p) => {
    const modelId = flags['model-cmd'] ? `cmd:${flags['model-cmd']}` : resolveNodeModel(p.db, `text:${stage}`).model;
    const model = createTextModel(modelId);
    return runNode(p, stage, { model, ...(maxAttempts === undefined ? {} : { maxAttempts }), onProgress: (e) => process.stderr.write(`${progressLine(e)}\n`) });
  });
  if (out.status === 'needs_human') {
    process.stderr.write(`  最后一版：${out.dir}/out/${stage}.json，违规：${out.dir}/violations.txt\n`);
    process.stderr.write(`  修好后：import ${dir} ${stage} <修好的文件> --run ${out.runId}\n`);
  }
  return { output: out, exitCode: out.status === 'passed' ? 0 : out.status === 'needs_human' ? 2 : 1 };
}

async function cmdRuns(args: string[], flags: Record<string, string>): Promise<CommandResult> {
  if (args[0] === 'unlock') {
    const usage = 'runs unlock <dir> --id N';
    const dir = need(args[1], usage);
    const id = intFlag(need(flags['id'], usage), '--id')!;
    return done(await withProject(dir, (p) => unlockRun(p.db, id)));
  }
  const dir = need(args[0], 'runs <dir> [--id N]');
  const id = intFlag(flags['id'], '--id');
  if (id === undefined) return done(await withProject(dir, (p) => listRuns(p.db)));
  const output = await withProject(dir, (p) => {
    const run = getRun(p.db, id);
    if (!run) throw new Error(`没有这个运行：${id}`);
    // 不打印完整提示词（很长），只给长度；需要全文直接查库
    const attempts = listAttempts(p.db, id).map((a) => ({ step: a.step, n: a.n, promptChars: a.systemPrompt.length + a.userPrompt.length, violations: a.violations, usage: a.usage }));
    return { ...run, attempts };
  });
  return done(output);
}

const COMMANDS: Readonly<Record<string, (args: string[], flags: Record<string, string>) => Promise<CommandResult>>> = {
  pack: cmdPack,
  mount: async (args) => {
    const usage = 'mount <dir> <stage> <skill>';
    const [dir, stage, skill] = [need(args[0], usage), stageArg(need(args[1], usage)), need(args[2], usage)];
    return done(await withProject(dir, (p) => mountSkill(p.db, stage, skill)));
  },
  input: cmdInput,
  run: cmdRun,
  runs: cmdRuns,
};

/** 不是节点命令时返回 null，由 cli.ts 报未知命令。 */
export async function nodeCommand(cmd: string, args: string[], flags: Record<string, string>): Promise<CommandResult | null> {
  const handler = COMMANDS[cmd];
  return handler ? handler(args, flags) : null;
}

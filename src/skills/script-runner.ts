// 跑 skill 的确定性脚本：用当前 node 直接执行，不经过 shell，参数按数组传，不需要转义。
// 非零退出不算异常（validate 不过就是 exit 1）；超时、起不来才抛错。
import { execFile } from 'node:child_process';
import { join } from 'node:path';

export interface ScriptResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ScriptOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const TAIL = 800;

const tail = (s: string): string => (s.length > TAIL ? `…${s.slice(-TAIL)}` : s);

export function runScript(scriptPath: string, args: readonly string[], opts: ScriptOptions): Promise<ScriptResult> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      { cwd: opts.cwd, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const label = `${scriptPath} ${args.join(' ')}`;
        if (error && error.killed) return reject(new Error(`skill 脚本超时（${timeout} ms）：${label}`));
        if (error && typeof error.code !== 'number') return reject(new Error(`skill 脚本起不来：${label}：${error.message}`));
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
}

/** 失败时给人看的命令摘要（只带 stderr / stdout 的尾部）。 */
export const describeFailure = (what: string, r: ScriptResult): string => `${what} 退出码 ${r.code}：${tail(r.stderr || r.stdout).trim()}`;

export interface Capabilities {
  readonly seed: boolean;
  readonly ids: boolean;
  readonly validate: boolean;
  readonly blocking: boolean;
  /** 逐门打印 ✓/✗（全貌页的质量门计数用）；4b 之前注册的记录里没有这一项 */
  readonly checkup?: boolean;
}

export const NO_CAPABILITIES: Capabilities = { seed: false, ids: false, validate: false, blocking: false, checkup: false };

export const PROBE_TIMEOUT_MS = 15_000;

/** 无参数运行脚本读 USAGE，按行首命令判断支持哪些子命令。 */
export async function probeCapabilities(scriptPath: string, cwd: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Capabilities> {
  const r = await runScript(scriptPath, [], { cwd, timeoutMs });
  const usage = `${r.stdout}\n${r.stderr}`;
  const has = (cmd: string) => new RegExp(`^\\s{2,}${cmd}\\s`, 'm').test(usage);
  return { seed: has('seed'), ids: has('ids'), validate: has('validate'), blocking: has('blocking'), checkup: has('checkup') };
}

export const scriptPathOf = (dir: string, script: string): string => join(dir, script);

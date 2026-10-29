// 命令行模型：把提示词写进子进程的 stdin，读 stdout 作为输出，例如 `claude -p`。
// 不经过 shell：命令按空白切分成参数（不支持引号），用户输入不会被当成 shell 代码执行。
import { spawn } from 'node:child_process';
import { NO_USAGE, type TextModel, type TextRequest, type TextResult } from './text-model.ts';

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const TAIL = 800;

export function parseCommand(cmd: string): string[] {
  const argv = cmd.trim().split(/\s+/).filter(Boolean);
  if (!argv.length) throw new Error('模型命令不能为空');
  return argv;
}

export class CommandTextModel implements TextModel {
  readonly id: string;
  private readonly argv: readonly string[];
  private readonly timeoutMs: number;

  constructor(cmd: string, opts: { timeoutMs?: number } = {}) {
    this.argv = parseCommand(cmd);
    this.id = `cmd:${this.argv.join(' ')}`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  complete(req: TextRequest, signal?: AbortSignal): Promise<TextResult> {
    const [bin, ...args] = this.argv as [string, ...string[]];
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], signal: combined });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', (e) => {
        const reason = timeout.aborted ? `超时（${this.timeoutMs} ms）` : e.message;
        reject(new Error(`模型命令 ${this.id} 失败：${reason}`));
      });
      child.on('close', (code) => {
        if (code !== 0) {
          const stderr = Buffer.concat(err).toString('utf8');
          return reject(new Error(`模型命令 ${this.id} 退出码 ${code}：${stderr.slice(-TAIL).trim()}`));
        }
        resolve({ text: Buffer.concat(out).toString('utf8'), usage: NO_USAGE });
      });
      // 子进程提前退出时写 stdin 会 EPIPE，交给 close 事件报错
      child.stdin.on('error', () => {});
      child.stdin.end(`${req.system}\n\n${req.user}`);
    });
  }
}

// 命令行共用的小工具：参数拆分、必填检查、打开项目、读文件、整数与阶段校验。cli.ts 与 cli-nodes.ts 共用一份。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STAGES, isStage, type Stage } from './domain/types.ts';
import { openProject, type Project } from './project.ts';

export const print = (x: unknown): void => {
  process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
};

/** 拆出 --flag value，其余为位置参数。 */
export function parseArgs(argv: readonly string[]): { args: string[]; flags: Record<string, string> } {
  const args: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) {
      args.push(a);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${a} 后面缺少取值`);
    flags[a.slice(2)] = value;
    i += 1;
  }
  return { args, flags };
}

export function need(value: string | undefined, usage: string): string {
  if (!value) throw new Error(`用法：${usage}`);
  return value;
}

export async function withProject<T>(dir: string, fn: (p: Project) => T | Promise<T>): Promise<T> {
  const project = openProject(dir);
  try {
    return await fn(project);
  } finally {
    project.close();
  }
}

/** 读文本文件；失败时点名文件。 */
export function readText(path: string): string {
  try {
    return readFileSync(resolve(path), 'utf8');
  } catch (error) {
    throw new Error(`读不了 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 读 JSON 文件；读不了、解析不了都点名文件。 */
export function readJson(path: string): unknown {
  const text = readText(path);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 整数参数：没给返回 undefined，给了但不是整数报错。 */
export function intFlag(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${label} 必须是整数：${value}`);
  return n;
}

export function stageArg(value: string): Stage {
  if (!isStage(value)) throw new Error(`不认识的 stage：${value}（可选 ${STAGES.join(' / ')}）`);
  return value;
}

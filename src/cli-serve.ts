// serve：启动本地 Web 界面。只监听 127.0.0.1；地址打印到 stderr，按 Ctrl+C 退出。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandResult } from './cli-nodes.ts';
import { intFlag } from './cli-shared.ts';
import { App } from './server/app.ts';
import { DEFAULT_PORT, startServer } from './server/server.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PROJECTS_ROOT = join(homedir(), 'ShortDrama');

export const SERVE_USAGE = `  serve [--port ${DEFAULT_PORT}] [--root ~/ShortDrama] [--skills <skills 根目录>] [--open no]
                                                启动本地 Web 界面（只监听 127.0.0.1）；--skills 给了才能在页面上新建项目
                                                （也可用环境变量 AVP_SKILLS_ROOT）`;

/** 用系统默认浏览器打开；打不开不影响服务。 */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

export async function serveCommand(cmd: string, _args: string[], flags: Record<string, string>): Promise<CommandResult | null> {
  if (cmd !== 'serve') return null;
  const skills = flags['skills'] ?? process.env['AVP_SKILLS_ROOT'] ?? null;
  if (skills && !existsSync(skills)) throw new Error(`skills 根目录不存在：${skills}`);
  const staticDir = join(REPO, 'web', 'dist');
  const app = new App({
    projectsRoot: resolve(flags['root'] ?? DEFAULT_PROJECTS_ROOT),
    packManifest: join(REPO, 'packs', 'novel.pack.json'),
    skillsRoot: skills ? resolve(skills) : null,
    staticDir: existsSync(staticDir) ? staticDir : null,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const server = await startServer(app, { port: intFlag(flags['port'], '--port') ?? DEFAULT_PORT });
  process.stderr.write(`短剧工坊：${server.url}\n  项目目录：${app.config.projectsRoot}\n`);
  if (!app.config.skillsRoot) process.stderr.write('  ⚠ 没有给 --skills，页面上不能新建项目\n');
  if (!app.config.staticDir) process.stderr.write('  ⚠ 前端还没有构建（pnpm web:build），只提供 API\n');
  if (flags['open'] !== 'no') openBrowser(server.url);
  await new Promise<void>((done) => {
    const stop = () => void server.close().then(done);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return { output: { stopped: true }, exitCode: 0 };
}

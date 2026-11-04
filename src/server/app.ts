// 服务的运行时上下文：配置、项目目录解析、事件总线、后台任务。路由处理器都从这里拿东西。
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CredentialOptions } from '../config/credentials.ts';
import type { Stage } from '../domain/types.ts';
import type { ProjectEstimate } from '../estimate/estimate.ts';
import type { RunNodeOptions } from '../executor/run-node.ts';
import { realGenerateDeps, type GenerateDeps } from '../generate/session.ts';
import { createTextModel } from '../model/registry.ts';
import type { TextModel } from '../model/text-model.ts';
import type { PresetDirs } from '../presets/presets.ts';
import { DB_FILE, openProject, type Project } from '../project.ts';
import { resolveNodeModel } from '../repo/models.ts';
import { failInterruptedOrchestrations } from '../repo/orchestrations.ts';
import { failInterruptedRuns } from '../repo/runs.ts';
import { EventBus } from './events.ts';
import { HttpError } from './http.ts';
import { Jobs } from './jobs.ts';
import type { GenContext } from './views/generation.ts';

export interface AppConfig {
  /** 项目根目录：下面每个含 project.sqlite 的子目录是一个项目 */
  readonly projectsRoot: string;
  /** 新建项目时注册的 skill 包清单与 skills 根目录；没有 skills 根目录就不能新建 */
  readonly packManifest: string;
  readonly skillsRoot: string | null;
  /** 前端构建产物目录；null = 只提供 API */
  readonly staticDir: string | null;
  readonly log: (line: string) => void;
  /** 每个阶段用哪个模型；默认按项目的预设 / 节点覆盖解析（测试里换成假模型） */
  readonly modelFor?: (project: Project, stage: Stage) => TextModel;
  /** 付费确认单的估算（测试里换掉，免得读本机价格配置） */
  readonly estimate?: (db: DatabaseSync) => ProjectEstimate;
  readonly run?: Pick<RunNodeOptions, 'maxAttempts' | 'prices'>;
  readonly credentials?: CredentialOptions;
  readonly presetDirs?: PresetDirs;
  /** 付费生成的供应商、价格、下载（测试与 E2E 换成假的）；默认按注册表与凭据造真的 */
  readonly generate?: GenerateDeps | undefined;
}

/** 项目 id 就是项目根目录下的子目录名；不允许带路径分隔符、不允许以点开头。 */
export function checkProjectId(id: string): string {
  if (!id || id.startsWith('.') || id.includes('/') || id.includes('\\') || id.includes('\0')) throw new HttpError(400, `项目名不合法：${id}`);
  return id;
}

export class App {
  readonly config: AppConfig;
  readonly bus = new EventBus();
  readonly jobs: Jobs;
  private realGenerate: GenerateDeps | null = null;

  constructor(config: AppConfig) {
    this.config = { ...config, projectsRoot: resolve(config.projectsRoot) };
    this.jobs = new Jobs(this);
  }

  projectDir(id: string): string {
    const dir = join(this.config.projectsRoot, checkProjectId(id));
    if (!dir.startsWith(this.config.projectsRoot + sep)) throw new HttpError(400, `项目名不合法：${id}`);
    return dir;
  }

  /** 打开项目、执行、关闭。项目不存在回 404。 */
  async withProject<T>(id: string, fn: (p: Project) => T | Promise<T>): Promise<T> {
    const dir = this.projectDir(id);
    if (!existsSync(join(dir, DB_FILE))) throw new HttpError(404, `没有这个项目：${id}`);
    const project = openProject(dir);
    try {
      this.sweep(id, project);
      return await fn(project);
    } finally {
      project.close();
    }
  }

  /**
   * 进程中断（Ctrl+C、崩溃）留下的 running 编排与运行：本进程没在跑这个项目的任务，就按进程号收尾，
   * 免得页面一直停在「运行中」、重跑和付费确认都点不了。别的进程（命令行 go）的还活着就不动。
   */
  private sweep(id: string, project: Project): void {
    if (this.jobs.current(id)) return;
    failInterruptedOrchestrations(project.db, () => false);
    failInterruptedRuns(project.db, () => false);
  }

  modelFor(project: Project, stage: Stage): TextModel {
    if (this.config.modelFor) return this.config.modelFor(project, stage);
    return createTextModel(resolveNodeModel(project.db, `text:${stage}`, this.config.presetDirs ? { dirs: this.config.presetDirs } : {}).model);
  }

  /** 项目根目录下所有项目的 id（只看目录，不打开库）。 */
  projectIds(): string[] {
    const root = this.config.projectsRoot;
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && existsSync(join(root, d.name, DB_FILE))).map((d) => d.name);
  }

  /**
   * 服务启动时：每个项目在后台对账、续查中断的付费任务（不提交新任务）。没有要恢复的项目什么都不做。
   * 失败只写日志，不影响服务起来。
   */
  async resumeInterrupted(): Promise<void> {
    for (const id of this.projectIds()) {
      try {
        const job = await this.jobs.resume(id);
        if (job) this.config.log(`  恢复中断的付费任务：${id}`);
      } catch (e) {
        this.config.log(`  恢复 ${id} 的付费任务失败：${(e as Error).message}`);
      }
    }
  }

  /** 生成任务页、全貌要的：在跑的后台任务、最近一次生成失败、价格。 */
  genContext(projectId: string): GenContext {
    return { job: this.jobs.current(projectId), failure: this.jobs.lastFailure(projectId), prices: this.generateDeps().prices };
  }

  /** 付费生成用的依赖：注入的优先；真的只造一次（凭据在第一次用到某家供应商时才读）。 */
  generateDeps(): GenerateDeps {
    if (this.config.generate) return this.config.generate;
    this.realGenerate ??= realGenerateDeps(this.config.credentials ?? {});
    return this.realGenerate;
  }

  close(): void {
    this.bus.closeAll();
  }
}

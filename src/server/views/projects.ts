// 项目列表与新建项目。项目就是项目根目录下含 project.sqlite 的子目录；打不开的（库比程序新、文件坏了）照样列出来并说明原因。
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { STAGES } from '../../domain/types.ts';
import { RECIPE_NAMES } from '../../executor/recipes.ts';
import { pendingCells } from '../../orchestrate/review-matrix.ts';
import { findPreset } from '../../presets/presets.ts';
import { loadFx } from '../../pricing/prices.ts';
import { createProject, DB_FILE, openProject } from '../../project.ts';
import { addInput, INPUT_KINDS, validateParams, type InputKind } from '../../repo/inputs.ts';
import { usePreset } from '../../repo/models.ts';
import { failInterruptedOrchestrations, listOrchestrations } from '../../repo/orchestrations.ts';
import { failInterruptedRuns } from '../../repo/runs.ts';
import { registerPack } from '../../repo/skills.ts';
import { checkProjectId, type App } from '../app.ts';
import { HttpError } from '../http.ts';
import { projectHead, STAGE_TITLES, stageCards, textCost, toCny, type ProjectHead } from './common.ts';

/** 显示用路径：家目录写成 ~ */
export const displayPath = (p: string, home = homedir()): string => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

export type ProjectSummary =
  | {
      readonly status: 'ok';
      readonly id: string;
      readonly dir: string;
      readonly head: ProjectHead;
      readonly text: { readonly passed: number; readonly total: number };
      /** 一句话现状：运行中 / 某阶段未通过 / n 项待处理 / 文本阶段已跑完 */
      readonly headline: { readonly tone: 'running' | 'err' | 'warn' | 'ok' | 'idle'; readonly text: string };
      readonly cost: { readonly usd: number; readonly cny: number };
      readonly updatedAt: string | null;
    }
  | { readonly status: 'needs_upgrade' | 'broken'; readonly id: string; readonly dir: string; readonly message: string };

function summarize(app: App, id: string, dir: string): ProjectSummary {
  let project;
  try {
    project = openProject(dir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: /比程序支持的/.test(message) ? 'needs_upgrade' : 'broken', id, dir: displayPath(dir), message };
  }
  try {
    const { db } = project;
    if (!app.jobs.current(id)) {
      failInterruptedOrchestrations(db, () => false);
      failInterruptedRuns(db, () => false);
    }
    const cells = pendingCells(db);
    const cards = stageCards(db, cells);
    const passed = cards.filter((c) => c.state === 'passed' || c.state === 'stale').length;
    const bad = cards.find((c) => c.state === 'needs_human' || c.state === 'failed');
    const running = app.jobs.current(id) || cards.some((c) => c.state === 'running');
    const headline: Extract<ProjectSummary, { status: 'ok' }>['headline'] = running
      ? { tone: 'running', text: `运行中 · ${cards.find((c) => c.state === 'running')?.title ?? ''}`.replace(/ · $/, '') }
      : bad
        ? { tone: 'err', text: `${bad.title}${bad.state === 'needs_human' ? '未通过' : '失败'} · 已尝试 ${bad.lastRun?.attempts ?? 0} 次` }
        : cells.length
          ? { tone: 'warn', text: `${passed === STAGES.length ? '文本阶段已跑完 · ' : ''}${cells.length} 项待你处理` }
          : passed === STAGES.length
            ? { tone: 'ok', text: '文本阶段已跑完' }
            : { tone: 'idle', text: passed ? `已完成到${STAGE_TITLES[STAGES[passed - 1]!]}` : '还没有开始' };
    const usd = textCost(db).usd;
    const updated = (db.prepare('SELECT MAX(t) AS t FROM (SELECT MAX(ended_at) AS t FROM node_run UNION ALL SELECT MAX(created_at) FROM artifact_version)').get() as { t: string | null }).t;
    return { status: 'ok', id, dir: displayPath(dir), head: projectHead(project, id), text: { passed, total: STAGES.length }, headline, cost: { usd, cny: toCny(usd, loadFx()) }, updatedAt: updated ?? listOrchestrations(db).at(-1)?.startedAt ?? null };
  } finally {
    project.close();
  }
}

/** 项目根目录下的项目，最近有动静的在前。根目录不存在就是空列表。 */
export function listProjects(app: App): ProjectSummary[] {
  const root = app.config.projectsRoot;
  if (!existsSync(root)) return [];
  const ids = readdirSync(root).filter((name) => !name.startsWith('.') && existsSync(join(root, name, DB_FILE)) && statSync(join(root, name)).isDirectory());
  const list = ids.map((id) => summarize(app, id, join(root, id)));
  const time = (p: ProjectSummary) => (p.status === 'ok' ? (p.updatedAt ?? '') : '');
  return list.sort((a, b) => time(b).localeCompare(time(a)) || a.id.localeCompare(b.id));
}

export interface NewProject {
  readonly name: string;
  readonly kind: InputKind;
  readonly text: string;
  readonly params: unknown;
  readonly preset?: string;
}

/** 新建：建目录与库、注册 skill 包（自动挂载）、写输入、选预设。中途出错就删掉这次建的目录。 */
export async function newProject(app: App, input: NewProject): Promise<{ id: string; problems: readonly string[] }> {
  const id = checkProjectId(input.name.trim());
  if (!(INPUT_KINDS as readonly string[]).includes(input.kind)) throw new HttpError(400, `输入类型只能是 ${INPUT_KINDS.join(' / ')}`);
  if (!app.config.skillsRoot) throw new HttpError(400, '服务启动时没有给 skills 根目录（serve --skills <目录>），不能新建项目');
  const params = validateParams((input.params ?? {}) as Record<string, unknown>);
  if (!input.text.trim()) throw new HttpError(400, '梗概或正文不能为空');
  if (input.preset) findPreset(input.preset, app.config.presetDirs);
  const dir = app.projectDir(id);
  if (existsSync(dir)) throw new HttpError(409, `已经有同名目录：${id}`);
  const manifest = JSON.parse(readFileSync(app.config.packManifest, 'utf8')) as unknown;
  const project = createProject(dir, id);
  try {
    const reg = await registerPack(project.db, manifest, app.config.skillsRoot, RECIPE_NAMES);
    addInput(project.db, { kind: input.kind, text: input.text, params });
    if (input.preset) usePreset(project.db, input.preset, app.config.presetDirs);
    project.close();
    return { id, problems: reg.problems };
  } catch (error) {
    // 建到一半失败：目录是这次刚建的，删掉，免得留下同名的半个项目、再建报 409
    project.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// 各页面共用的数据：阶段状态、文本实际花费、人民币折算、项目头信息。都是只读查询，库函数之上的薄组装。
import type { DatabaseSync } from 'node:sqlite';
import { STAGES, type Stage } from '../../domain/types.ts';
import { isDoc, listOf, type Doc } from '../../executor/recipe-kit.ts';
import { pendingCells, type MatrixCell } from '../../orchestrate/review-matrix.ts';
import type { Fx } from '../../pricing/prices.ts';
import type { Project } from '../../project.ts';
import { latestArtifact, latestArtifactDoc } from '../../repo/artifacts.ts';
import { currentInput } from '../../repo/inputs.ts';
import { currentPresetName } from '../../repo/models.ts';
import type { RunStatus } from '../../repo/runs.ts';
import { currentMount } from '../../repo/skills.ts';

export const STAGE_TITLES: Readonly<Record<Stage, string>> = { outline: '大纲', cast: '角色', art: '美术', script: '剧本', staging: '站位', storyboard: '分镜' };

export type StageState = 'passed' | 'stale' | 'failed' | 'needs_human' | 'running' | 'waiting';

export interface StageCard {
  readonly stage: Stage;
  readonly title: string;
  readonly skill: string | null;
  readonly state: StageState;
  readonly artifactV: number | null;
  readonly lastRun: { readonly id: number; readonly status: RunStatus; readonly attempts: number; readonly error: string | null } | null;
  /** 需复核的格子数 */
  readonly stale: number;
}

export const docOf = (db: DatabaseSync, stage: Stage): Doc | null => {
  const d = latestArtifactDoc(db, stage)?.doc;
  return isDoc(d) ? d : null;
};

export const episodesIn = (doc: Doc | null): Doc[] => listOf(doc, 'episodes');

function lastRun(db: DatabaseSync, stage: Stage): StageCard['lastRun'] {
  const row = db.prepare('SELECT id, status, error FROM node_run WHERE stage = ? ORDER BY id DESC LIMIT 1').get(stage) as { id: number; status: RunStatus; error: string | null } | undefined;
  if (!row) return null;
  const attempts = (db.prepare('SELECT COUNT(*) AS n FROM node_attempt WHERE run_id = ?').get(row.id) as { n: number }).n;
  return { ...row, attempts };
}

/** 一个阶段现在的状态：在跑 > 最近一次没过 > 需复核 > 有产物（通过）> 等待。 */
export function stageState(hasArtifact: boolean, run: StageCard['lastRun'], stale: number): StageState {
  if (run?.status === 'running') return 'running';
  if (run && (run.status === 'needs_human' || run.status === 'failed')) return run.status;
  if (hasArtifact && stale) return 'stale';
  return hasArtifact ? 'passed' : 'waiting';
}

export function stageCards(db: DatabaseSync, cells: readonly MatrixCell[] = pendingCells(db)): StageCard[] {
  return STAGES.map((stage) => {
    const mount = currentMount(db, stage);
    const artifact = latestArtifact(db, stage);
    const run = lastRun(db, stage);
    const stale = cells.filter((c) => c.stage === stage).length;
    return { stage, title: STAGE_TITLES[stage], skill: mount ? `${mount.name}@${mount.version}` : null, state: stageState(Boolean(artifact), run, stale), artifactV: artifact?.v ?? null, lastRun: run, stale };
  });
}

/** 文本阶段实际花费（各次模型调用记下的费用，按币种合计）。 */
export function textCost(db: DatabaseSync): { readonly usd: number; readonly unpriced: number } {
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN cost_currency = 'USD' THEN cost END), 0) AS usd, SUM(CASE WHEN cost IS NULL AND output IS NOT NULL THEN 1 ELSE 0 END) AS unpriced FROM node_attempt`).get() as { usd: number; unpriced: number | null };
  return { usd: Math.round(row.usd * 1e6) / 1e6, unpriced: row.unpriced ?? 0 };
}

export const toCny = (usd: number, fx: Fx): number => Math.round(usd * fx.usdToCny * 100) / 100;

export interface ProjectHead {
  readonly id: string;
  readonly name: string;
  readonly params: { readonly episodes: number; readonly seconds: number; readonly genre: string; readonly aspect?: string } | null;
  readonly inputKind: string | null;
  readonly inputChars: number;
  readonly preset: string;
}

export function projectHead(project: Project, id: string): ProjectHead {
  const input = currentInput(project.db);
  return { id, name: project.meta.name, params: input?.params ?? null, inputKind: input?.kind ?? null, inputChars: input?.text.length ?? 0, preset: currentPresetName(project.db) };
}

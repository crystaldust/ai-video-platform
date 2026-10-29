// 测试共用：渡口样例（6 份互相对得上的 skill 产物）+ 临时项目。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGES, type Stage } from '../src/domain/types.ts';
import { importArtifact, type ImportResult } from '../src/import/import-artifact.ts';
import { createProject, type Project } from '../src/project.ts';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'duko');

/** 样例里会反复用到的稳定 id（取自 3.0 样例，改夹具时一起改）。 */
export const DUKO = {
  ep1: 'ep_mtg51p27',
  ep2: 'ep_vt1jgnz6',
  ep6: 'ep_4207pqxh',
  /** 第 1 集第 1、2 场 */
  sc11: 'sc_x3xq2c82',
  sc12: 'sc_rvnqh21s',
  /** 第 6 集第 2 场 */
  sc62: 'sc_7n77hnfr',
  /** 第 1 集第 1、2 段（原 E01-01、E01-02） */
  seg1: 'sg_x96b305w',
  seg2: 'sg_tbkve4z7',
  /** 第 1 段第 1 切、第 2 段第 1 切 */
  cut11: 'ct_dfg1t316',
  cut21: 'ct_s8epvsfx',
} as const;

export const fixturePath = (stage: Stage): string => join(FIXTURE_DIR, `渡口-${stage}.json`);

/** 每次都重新读盘，调用方可以随意改坏而不影响别的测试。 */
export const loadFixture = (stage: Stage): any => JSON.parse(readFileSync(fixturePath(stage), 'utf8'));

/** 按上下游顺序导入样例：outline → cast → art → script → staging → storyboard。 */
export const importAll = (project: Project, stages: readonly Stage[] = STAGES): ImportResult[] =>
  stages.map((stage) => importArtifact(project, stage, loadFixture(stage)));

export interface TempProject {
  readonly dir: string;
  readonly project: Project;
  cleanup(): void;
}

export function tempProject(name = '渡口'): TempProject {
  const dir = mkdtempSync(join(tmpdir(), 'avp-'));
  const project = createProject(dir, name);
  return {
    dir,
    project,
    cleanup: () => {
      project.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

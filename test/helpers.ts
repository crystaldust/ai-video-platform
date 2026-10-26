// 测试共用：渡口样例（6 份互相对得上的 skill 产物）+ 临时项目。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGES, type Stage } from '../src/domain/types.ts';
import { importArtifact, type ImportResult } from '../src/import/import-artifact.ts';
import { createProject, type Project } from '../src/project.ts';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'duko');

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

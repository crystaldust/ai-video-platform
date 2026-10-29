// Skill 包页：每个阶段挂的是哪个 skill、协议能力、质量门数；已注册的包与可换挂的 skill。
import { STAGES, type Stage } from '../../domain/types.ts';
import type { Project } from '../../project.ts';
import { currentMount, listPacks, type SkillRow } from '../../repo/skills.ts';
import { stageGates, type GateResult } from './checkup.ts';
import { projectHead, STAGE_TITLES, type ProjectHead } from './common.ts';

export interface MountRow {
  readonly stage: Stage;
  readonly title: string;
  readonly skill: { readonly id: number; readonly name: string; readonly version: string; readonly packId: number } | null;
  readonly capabilities: { readonly seed: boolean; readonly validate: boolean; readonly ids: boolean } | null;
  readonly gates: GateResult | null;
  /** 别的包里也声明了这个阶段、可以换挂的 skill */
  readonly alternatives: readonly { readonly id: number; readonly name: string; readonly version: string; readonly packId: number }[];
}

export interface SkillsView {
  readonly project: ProjectHead;
  readonly mounts: readonly MountRow[];
  readonly packs: readonly { readonly id: number; readonly name: string; readonly root: string; readonly description: string | null; readonly registeredAt: string; readonly inUse: boolean; readonly skills: readonly { readonly name: string; readonly version: string; readonly stage: Stage | null; readonly recipe: string | null }[] }[];
}

const brief = (s: SkillRow) => ({ id: s.id, name: s.name, version: s.version, packId: s.packId });

export async function skillsView(project: Project, id: string): Promise<SkillsView> {
  const { db } = project;
  const packs = listPacks(db);
  const mounts = await Promise.all(
    STAGES.map(async (stage): Promise<MountRow> => {
      const mount = currentMount(db, stage);
      return {
        stage,
        title: STAGE_TITLES[stage],
        skill: mount ? brief(mount) : null,
        capabilities: mount ? { seed: mount.capabilities.seed, validate: mount.capabilities.validate, ids: mount.capabilities.ids } : null,
        gates: await stageGates(project, stage).catch(() => null),
        alternatives: packs.flatMap((p) => p.skills).filter((s) => s.stage === stage && s.id !== mount?.id).map(brief),
      };
    }),
  );
  const mounted = new Set(mounts.map((m) => m.skill?.packId));
  return {
    project: projectHead(project, id),
    mounts,
    packs: packs.map((p) => ({ id: p.id, name: p.name, root: p.root, description: p.description, registeredAt: p.registeredAt, inUse: mounted.has(p.id), skills: p.skills.map((s) => ({ name: s.name, version: s.version, stage: s.stage, recipe: s.recipe })) })),
  };
}

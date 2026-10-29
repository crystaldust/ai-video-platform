// 接口数据的类型：直接取自服务端的视图模块（只取类型，构建时擦除），前后端不会对不上。
export type { Overview, EpisodeRow, PendingItem, LogRun, CellState } from '../../src/server/views/overview.ts';
export type { ProjectSummary } from '../../src/server/views/projects.ts';
export type { EpisodeDetail, SceneView, SegmentView, CutView, BeatView } from '../../src/server/views/episode.ts';
export type { CastView, CharacterView, ArtItemView } from '../../src/server/views/cast.ts';
export type { SkillsView, MountRow } from '../../src/server/views/skills.ts';
export type { ModelsView } from '../../src/server/views/models.ts';
export type { GateView } from '../../src/server/views/gates.ts';
export type { StageCard, StageState, ProjectHead } from '../../src/server/views/common.ts';
export type { GateResult } from '../../src/server/views/checkup.ts';
export type { JobInfo } from '../../src/server/jobs.ts';
export type { ProjectEstimate, NodeEstimate } from '../../src/estimate/estimate.ts';
export type { Stage } from '../../src/domain/types.ts';

export interface AppConfigView {
  readonly projectsRoot: string;
  readonly canCreate: boolean;
  readonly pack: { readonly name: string; readonly description: string; readonly stages: readonly string[] } | null;
  readonly presets: readonly { readonly name: string; readonly title: string; readonly description: string }[];
}

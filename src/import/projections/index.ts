import type { ProjectFn, Stage } from '../../domain/types.ts';
import { projectArt } from './art.ts';
import { projectCast } from './cast.ts';
import { projectOutline } from './outline.ts';
import { projectScript } from './script.ts';
import { projectStaging } from './staging.ts';
import { projectStoryboard } from './storyboard.ts';

export const PROJECTIONS: Readonly<Record<Stage, ProjectFn>> = {
  outline: projectOutline,
  cast: projectCast,
  art: projectArt,
  script: projectScript,
  staging: projectStaging,
  storyboard: projectStoryboard,
};

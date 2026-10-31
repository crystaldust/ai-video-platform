// 没落实的打回意见（运行转人工或失败，意见没用上）：再打回一次的请求体、放弃的路径、说明里的称呼。
import { epLabel } from './format.ts';
import { STAGE_TITLE } from './reject.ts';
import type { PendingItem, Stage } from './types.ts';

type PendingRevision = NonNullable<PendingItem['revision']>;

/** 带同样的意见再打回一次：意见只针对一集时带那一集，否则是整个阶段。 */
export const repeatRejectBody = (stage: Stage, revision: PendingRevision): { stage: Stage; note: string; episode?: string } => ({
  stage,
  note: revision.note,
  ...(revision.episode ? { episode: revision.episode } : {}),
});

export const dismissPath = (id: number): string => `/revisions/${id}/dismiss`;

export const revisionLabel = (stage: Stage, revision: PendingRevision): string => `${revision.ep ? `第 ${epLabel(revision.ep)} 集的` : ''}${STAGE_TITLE[stage]}`;

// 「需复核」矩阵：上游变了、下游还钉着旧版本的地方，按 (阶段, 集) 聚合。
// 底层就是 findStaleRefs（过期现算），这里不另造一套判断：阶段 = 引用方的侧面，集 = 引用方当前版本记的所属集，
// 跨集共用的对象（角色卡、美术、站位认图）归到集 null。
// 「看过了，保持现状」记一条复核确认（存当时各上游的版本号）；上游之后再变，这一格重新出现。
import type { DatabaseSync } from 'node:sqlite';
import { STAGES, type Stage } from '../domain/types.ts';
import { findStaleRefs, type StaleRef } from '../repo/lineage.ts';
import { addReviewAck, cellKey, latestReviewAcks, type AckSnapshot, type ReviewAckRow } from '../repo/revisions.ts';
import type { RunStatus } from '../repo/runs.ts';

export interface MatrixCell {
  readonly stage: Stage;
  /** 集 id；null = 跨集共用的部分 */
  readonly episode: string | null;
  readonly reasons: readonly StaleRef[];
  /** 已复核确认（当前这些过期都在确认时看过） */
  readonly acknowledged: boolean;
  /** 这一格最近一次运行的状态（覆盖这一集的单集运行或整阶段运行）；没跑过就是 null */
  readonly lastRun: { readonly id: number; readonly status: RunStatus } | null;
}

const targetKey = (r: StaleRef): string => `${r.to.kind}/${r.to.key}/${r.to.facet}`;

/** 快照里记的版本都不比现在的旧：当前的过期都是确认时就看过的。 */
const covered = (reasons: readonly StaleRef[], ack: ReviewAckRow | undefined): boolean =>
  Boolean(ack) && reasons.every((r) => (ack!.snapshot[targetKey(r)] ?? 0) >= r.currentV);

function lastRuns(db: DatabaseSync): { stage: Stage; id: number; status: RunStatus; episodes: string[] | null }[] {
  const rows = db.prepare('SELECT id, stage, status, episode_key FROM node_run ORDER BY id DESC').all() as { id: number; stage: Stage; status: RunStatus; episode_key: string | null }[];
  return rows.map((r) => ({ stage: r.stage, id: r.id, status: r.status, episodes: r.episode_key ? r.episode_key.split(',') : null }));
}

function groupStale(db: DatabaseSync): Map<string, { stage: Stage; episode: string | null; reasons: StaleRef[] }> {
  const cells = new Map<string, { stage: Stage; episode: string | null; reasons: StaleRef[] }>();
  for (const r of findStaleRefs(db)) {
    const key = cellKey(r.from.facet, r.from.episode);
    const cell = cells.get(key) ?? { stage: r.from.facet, episode: r.from.episode, reasons: [] };
    cell.reasons.push(r);
    cells.set(key, cell);
  }
  return cells;
}

const order = (a: MatrixCell, b: MatrixCell): number => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || (a.episode ?? '').localeCompare(b.episode ?? '');

/** 全部需复核的格子（含已确认的，acknowledged 标出来），按阶段顺序。 */
export function reviewMatrix(db: DatabaseSync): MatrixCell[] {
  const acks = latestReviewAcks(db);
  const runs = lastRuns(db);
  return [...groupStale(db).entries()]
    .map(([key, c]): MatrixCell => {
      const run = runs.find((r) => r.stage === c.stage && (r.episodes === null || (c.episode !== null && r.episodes.includes(c.episode))));
      return { ...c, acknowledged: covered(c.reasons, acks.get(key)), lastRun: run ? { id: run.id, status: run.status } : null };
    })
    .sort(order);
}

/** 还没确认的格子：go --only-stale 要重跑的就是这些。 */
export const pendingCells = (db: DatabaseSync): MatrixCell[] => reviewMatrix(db).filter((c) => !c.acknowledged);

/** 「看过了，保持现状」：记下这一格当前各过期上游的版本。没有需复核的引用就报错。 */
export function acknowledge(db: DatabaseSync, stage: Stage, episode: string | null, note = ''): ReviewAckRow {
  const cell = groupStale(db).get(cellKey(stage, episode));
  if (!cell) throw new Error(`${stage}${episode ? `（集 ${episode}）` : ''} 没有需复核的地方`);
  const snapshot: AckSnapshot = Object.fromEntries(cell.reasons.map((r) => [targetKey(r), r.currentV]));
  return addReviewAck(db, { stage, episodeKey: episode, snapshot, note });
}

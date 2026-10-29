// 导入一份 skill 产物：投影 → 产物版本 → 对象版本 → 退役 → 引用，全部在一个事务里。
// 任何一处对不上就整体回滚，库里不留半份数据。
//
// 重新导入即复核：产物里每个对象（不论内容变没变）的引用都按目标的当前版本重新钉一次。
// 所以"上游改了"之后，下游原样重新导入就表示"我看过了，仍然成立"，过期随之消失；
// 同一份产物内部的引用也总是彼此一致，不会对自己报过期。
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/transaction.ts';
import { isStage, type Coverage, type EntityDraft, type RefDraft, type Stage } from '../domain/types.ts';
import type { Project } from '../project.ts';
import { appendArtifactVersion } from '../repo/artifacts.ts';
import {
  appendEntityVersion,
  characterKeyIndex,
  currentVersion,
  ensureEntity,
  insertRef,
  liveEntities,
  retireEntityVersion,
  sceneEpisodeIndex,
  type LiveEntity,
} from '../repo/entities.ts';
import { PROJECTIONS } from './projections/index.ts';

export class ImportError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`导入失败：${problems.length} 处问题`);
    this.name = 'ImportError';
    this.problems = [...problems];
  }
}

export interface ImportOptions {
  readonly skill?: string;
  readonly sourcePath?: string;
}

export interface ImportResult {
  readonly stage: Stage;
  readonly artifactV: number;
  /** 产物原文与上一版完全相同（仍会重新复核引用）。 */
  readonly unchanged: boolean;
  readonly created: number;
  readonly reused: number;
  readonly retired: number;
  /** 本次新写入的引用条数（含复核时改钉的）。 */
  readonly refs: number;
}

type Written = ReadonlyMap<string, number>;

const facetId = (x: { kind: string; key: string; facet: string }) => `${x.kind}/${x.key}/${x.facet}`;

function writeEntities(db: DatabaseSync, drafts: readonly EntityDraft[], artifactVersionId: number) {
  let created = 0;
  const written = new Map<string, number>();
  for (const d of drafts) {
    const entityId = ensureEntity(db, d.kind, d.key, d.title, d.facet === 'outline');
    const version = appendEntityVersion(db, { entityId, facet: d.facet, payload: d.payload, artifactVersionId, episode: d.episode });
    written.set(facetId(d), version.id);
    if (version.created) created += 1;
  }
  return { written: written as Written, created };
}

// 按集负责时，只看当前版本记的所属集；没记集的（跨集共用）不在任何一集的范围里
const inScope = (c: Coverage, live: LiveEntity): boolean =>
  c.episodes === 'all' || (live.episodeKey !== null && c.episodes.includes(live.episodeKey));

/** 覆盖范围内、库里仍有效、这次却没出现的对象：退役。 */
function retireMissing(db: DatabaseSync, covers: readonly Coverage[], written: Written, artifactVersionId: number): number {
  let retired = 0;
  for (const c of covers) {
    for (const live of liveEntities(db, c.kind, c.facet)) {
      if (!inScope(c, live) || written.has(facetId({ kind: c.kind, key: live.key, facet: c.facet }))) continue;
      retireEntityVersion(db, live.entityId, c.facet, artifactVersionId);
      retired += 1;
    }
  }
  return retired;
}

/** 目标侧面按优先级取第一个有效版本——引用钉在它的当前版本上。 */
function resolveTarget(db: DatabaseSync, r: RefDraft): number | null {
  for (const facet of r.toFacets) {
    const v = currentVersion(db, r.to.kind, r.to.key, facet);
    if (v) return v.id;
  }
  return null;
}

function writeRefs(db: DatabaseSync, drafts: readonly RefDraft[], written: Written): { count: number; problems: string[] } {
  const problems: string[] = [];
  let count = 0;
  for (const r of drafts) {
    const fromId = written.get(facetId(r.from));
    if (fromId === undefined) continue;
    const target = resolveTarget(db, r);
    if (target === null) {
      if (!r.optional) problems.push(`${r.where}引用了 ${r.to.kind}/${r.to.key}，项目里没有它有效的 ${r.toFacets.join('/')} 版本`);
      continue;
    }
    if (insertRef(db, fromId, r.role, target)) count += 1;
  }
  return { count, problems };
}

export function importArtifact(project: Project, stage: Stage, doc: unknown, opts: ImportOptions = {}): ImportResult {
  if (!isStage(stage)) throw new Error(`不认识的阶段：${String(stage)}`);
  const { db } = project;
  return withTransaction(db, () => {
    const index = characterKeyIndex(db);
    const ctx = { characterKeyByName: index.byName, ambiguousNames: index.ambiguous, sceneEpisode: sceneEpisodeIndex(db) };
    const projection = PROJECTIONS[stage](doc, ctx);
    if (projection.problems.length) throw new ImportError(projection.problems);

    const artifact = appendArtifactVersion(db, { stage, doc, skill: opts.skill, sourcePath: opts.sourcePath });
    const { written, created } = writeEntities(db, projection.entities, artifact.id);
    const retired = retireMissing(db, projection.covers, written, artifact.id);
    const refs = writeRefs(db, projection.refs, written);
    if (refs.problems.length) throw new ImportError(refs.problems);

    return { stage, artifactV: artifact.v, unchanged: artifact.unchanged, created, reused: written.size - created, retired, refs: refs.count };
  });
}

// 单集详情：场次 → 段 → 切，切上带认领的剧本节拍与台词；段带开场走位、视频提示词。来自剧本、站位、分镜的当前版本。
import type { Doc } from '../../executor/recipe-kit.ts';
import { listOf } from '../../executor/recipe-kit.ts';
import { pendingCells } from '../../orchestrate/review-matrix.ts';
import type { Project } from '../../project.ts';
import { HttpError } from '../http.ts';
import { docOf, episodesIn, liveDoc, projectHead, STAGE_TITLES, type ProjectHead } from './common.ts';

export interface BeatView {
  readonly id: string;
  readonly kind: 'action' | 'line';
  readonly speaker: string | null;
  readonly text: string;
}

export interface CutView {
  readonly id: string;
  readonly start: number;
  readonly seconds: number;
  readonly size: string;
  readonly camera: string;
  readonly frame: string;
  readonly shot: string;
  readonly lens: string;
  readonly eyeline: string;
  readonly composition: string;
  readonly characters: readonly string[];
  readonly props: readonly string[];
  readonly beats: readonly BeatView[];
}

export interface SegmentView {
  readonly id: string;
  readonly label: string;
  readonly seconds: number;
  readonly blocking: string;
  readonly opening: boolean;
  readonly h3Prompt: string;
  readonly soundscape: string;
  readonly cuts: readonly CutView[];
}

export interface SceneView {
  readonly id: string;
  readonly n: number;
  readonly location: string;
  readonly lighting: string;
  readonly changed: boolean;
  readonly segments: readonly SegmentView[];
}

export interface EpisodeDetail {
  readonly project: ProjectHead;
  readonly episode: { readonly id: string; readonly ep: number; readonly hook: string; readonly synopsis: string };
  readonly nav: { readonly prev: string | null; readonly next: string | null; readonly index: number; readonly total: number };
  readonly stale: readonly { readonly stage: string; readonly title: string; readonly reasons: readonly string[] }[];
  readonly stats: { readonly seconds: number; readonly target: number | null; readonly scenes: number; readonly segments: number; readonly cuts: number; readonly hookBeat: number | null };
  readonly scenes: readonly SceneView[];
  /** 这一集的剧本 / 分镜来自正在跑的运行、还没过质量门 */
  readonly draft: { readonly script: boolean; readonly storyboard: boolean };
}

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const num = (x: unknown): number => (typeof x === 'number' ? x : 0);

/** 人物、场景、道具编号 → 名字（大纲为准）。 */
function nameIndex(outline: Doc | null): Map<string, string> {
  return new Map(['characters', 'scenes', 'props'].flatMap((k) => listOf(outline, k).map((x) => [str(x['id']), str(x['name'])] as [string, string])));
}

function beatsOf(script: Doc | null, names: ReadonlyMap<string, string>): Map<string, BeatView> {
  const out = new Map<string, BeatView>();
  for (const e of episodesIn(script)) {
    for (const sc of listOf(e, 'scenes')) {
      for (const b of listOf(sc, 'flow')) {
        const speaker = str(b['speaker']);
        out.set(str(b['id']), b['line'] ? { id: str(b['id']), kind: 'line', speaker: names.get(speaker) ?? speaker, text: str(b['line']) } : { id: str(b['id']), kind: 'action', speaker: null, text: str(b['action']) });
      }
    }
  }
  return out;
}

function cutView(cut: Doc, start: number, names: ReadonlyMap<string, string>, beats: ReadonlyMap<string, BeatView>): CutView {
  const ids = (k: string) => (Array.isArray(cut[k]) ? (cut[k] as unknown[]).map((x) => names.get(str(x)) ?? str(x)) : []);
  return {
    id: str(cut['id']),
    start,
    seconds: num(cut['seconds']),
    size: str(cut['size']),
    camera: str(cut['camera']),
    frame: str(cut['frame']),
    shot: str(cut['shot']),
    lens: str(cut['lens']),
    eyeline: str(cut['eyeline']),
    composition: str(cut['composition']),
    characters: ids('characters'),
    props: ids('props'),
    beats: (Array.isArray(cut['beatIds']) ? cut['beatIds'] : []).flatMap((b) => (beats.has(str(b)) ? [beats.get(str(b))!] : [])),
  };
}

export function episodeDetail(project: Project, id: string, episodeId: string): EpisodeDetail {
  const { db } = project;
  const outline = docOf(db, 'outline');
  const liveScript = liveDoc(project, 'script');
  const liveBoard = liveDoc(project, 'storyboard');
  const [script, board] = [liveScript.doc, liveBoard.doc];
  const all = episodesIn(outline);
  const index = all.findIndex((e) => e['id'] === episodeId || String(e['ep']) === episodeId);
  if (index < 0) throw new HttpError(404, `大纲里没有这一集：${episodeId}`);
  const o = all[index]!;
  const epId = str(o['id']);
  const ep = num(o['ep']);
  const names = nameIndex(outline);
  const beats = beatsOf(script, names);
  // 按集 id 认，认不到再按集号（运行中的草稿补 id 失败时没有集 id）
  const s = episodesIn(script).find((e) => e['id'] === epId) ?? episodesIn(script).find((e) => e['ep'] === ep) ?? null;
  const segments = listOf(episodesIn(board).find((e) => e['id'] === epId) ?? episodesIn(board).find((e) => e['ep'] === ep) ?? null, 'segments');
  const cells = pendingCells(db).filter((c) => c.episode === epId);
  const changedScenes = new Set(cells.flatMap((c) => c.reasons.filter((r) => r.to.kind === 'script_scene').map((r) => r.to.key)));
  let segIndex = 0;
  const scenes = listOf(s, 'scenes').map((sc, i): SceneView => {
    const ref = str(sc['id']);
    const segs = segments.filter((g) => g['sceneRef'] === ref).map((g, j): SegmentView => {
      segIndex += 1;
      let t = 0;
      const cuts = listOf(g, 'cuts').map((c) => {
        const v = cutView(c, t, names, beats);
        t += v.seconds;
        return v;
      });
      return { id: str(g['id']), label: `E${String(ep).padStart(2, '0')}-${String(segIndex).padStart(2, '0')}`, seconds: t, blocking: str(g['blocking']), opening: j === 0, h3Prompt: str(g['h3Prompt']), soundscape: str(g['soundscape']), cuts };
    });
    return { id: ref, n: i + 1, location: names.get(str(sc['sceneId'])) ?? str(sc['sceneId']), lighting: str(sc['lighting']), changed: changedScenes.has(ref), segments: segs };
  });
  const segViews = scenes.flatMap((x) => x.segments);
  const hookBeat = s && typeof s['hookBeat'] === 'string' ? listOf(s, 'scenes').flatMap((x) => listOf(x, 'flow')).findIndex((b) => b['id'] === s['hookBeat']) + 1 || null : null;
  return {
    project: projectHead(project, id),
    episode: { id: epId, ep, hook: str(o['hook']), synopsis: str(o['synopsis']) },
    nav: { prev: index > 0 ? str(all[index - 1]!['id']) : null, next: index < all.length - 1 ? str(all[index + 1]!['id']) : null, index: index + 1, total: all.length },
    stale: cells.map((c) => ({ stage: c.stage, title: STAGE_TITLES[c.stage], reasons: c.reasons.map((r) => `${r.to.kind} ${r.to.key} 的${STAGE_TITLES[r.to.facet]}：v${r.pinnedV} → v${r.currentV}`) })),
    stats: { seconds: segViews.reduce((a, g) => a + g.seconds, 0), target: s ? num(s['targetSeconds']) || null : null, scenes: scenes.length, segments: segViews.length, cuts: segViews.reduce((a, g) => a + g.cuts.length, 0), hookBeat },
    scenes,
    draft: { script: liveScript.drafts.has(ep), storyboard: liveBoard.drafts.has(ep) },
  };
}

// 大纲与剧本页：两份文本产物的当前版本整份展开，人物、场景、道具编号换成大纲里的名字。还没有产物时为 null。
import type { DatabaseSync } from 'node:sqlite';
import { isDoc, listOf, type Doc } from '../../executor/recipe-kit.ts';
import type { Project } from '../../project.ts';
import { latestArtifactDoc } from '../../repo/artifacts.ts';
import { stageGates, type GateResult } from './checkup.ts';
import { docOf, episodesIn, projectHead, type ProjectHead } from './common.ts';

const TIER: Readonly<Record<string, string>> = { lead: '主角', support: '配角', functional: '功能角色' };
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const num = (x: unknown): number => (typeof x === 'number' ? x : 0);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);

export interface Choice {
  readonly what: string;
  readonly why: string;
}

export interface OutlineView {
  readonly v: number;
  readonly adaptation: { readonly core: string; readonly keep: readonly Choice[]; readonly cut: readonly Choice[]; readonly merge: readonly Choice[]; readonly risks: readonly Choice[]; readonly notes: readonly string[] };
  readonly characters: readonly { readonly id: string; readonly name: string; readonly tier: string; readonly role: string; readonly arc: string }[];
  readonly scenes: readonly { readonly id: string; readonly name: string; readonly primary: boolean; readonly note: string }[];
  readonly props: readonly { readonly id: string; readonly name: string; readonly function: string; readonly beats: readonly string[] }[];
  readonly beats: readonly { readonly id: string; readonly type: string; readonly major: boolean; readonly episode: number; readonly setup: string; readonly payoff: string }[];
  readonly episodes: readonly { readonly id: string; readonly ep: number; readonly synopsis: string; readonly hook: string; readonly suspense: string; readonly characters: readonly string[]; readonly scenes: readonly string[]; readonly props: readonly string[]; readonly crowdPlan: string; readonly warnings: readonly string[] }[];
}

export interface FlowItem {
  readonly id: string;
  readonly kind: 'action' | 'line';
  readonly speaker: string | null;
  readonly delivery: string;
  readonly text: string;
  /** 这一集的钩子节拍 */
  readonly hook: boolean;
}

export interface ScriptView {
  readonly v: number;
  readonly episodes: readonly {
    readonly id: string;
    readonly ep: number;
    readonly targetSeconds: number | null;
    readonly hook: string;
    readonly cliff: string;
    readonly beatsClaimed: readonly string[];
    readonly lines: number;
    readonly scenes: readonly { readonly id: string; readonly n: number; readonly location: string; readonly lighting: string; readonly characters: readonly string[]; readonly props: readonly string[]; readonly flow: readonly FlowItem[] }[];
  }[];
}

export type OutlinePage = { readonly project: ProjectHead; readonly gates: GateResult | null; readonly outline: OutlineView | null };
export type ScriptPage = { readonly project: ProjectHead; readonly gates: GateResult | null; readonly script: ScriptView | null };

/** 人物、场景、道具编号 → 名字（大纲为准；找不到就原样）。 */
function namer(outline: Doc | null): (id: unknown) => string {
  const names = new Map(['characters', 'scenes', 'props'].flatMap((k) => listOf(outline, k).map((x) => [str(x['id']), str(x['name'])] as [string, string])));
  return (id) => names.get(str(id)) || str(id);
}

const choices = (x: unknown): Choice[] => (Array.isArray(x) ? (x as Doc[]).map((c) => ({ what: str(c?.['what']), why: str(c?.['why']) || str(c?.['plan']) })) : []);

function current(db: DatabaseSync, stage: 'outline' | 'script'): { v: number; doc: Doc } | null {
  const row = latestArtifactDoc(db, stage);
  return row && isDoc(row.doc) ? { v: row.v, doc: row.doc } : null;
}

function outlineOf(v: number, o: Doc): OutlineView {
  const name = namer(o);
  const a = (o['adaptation'] ?? {}) as Doc;
  const beatType = new Map(listOf(o, 'beats').map((b) => [str(b['id']), str(b['type'])]));
  return {
    v,
    adaptation: { core: str(a['core']), keep: choices(a['keep']), cut: choices(a['cut']), merge: choices(a['merge']), risks: choices(a['risks']), notes: [a['cutNote'], a['mergeNote']].map(str).filter(Boolean) },
    characters: listOf(o, 'characters').map((c) => ({ id: str(c['id']), name: str(c['name']), tier: TIER[str(c['tier'])] ?? str(c['tier']), role: str(c['role']), arc: str(c['arc']) })),
    scenes: listOf(o, 'scenes').map((s) => ({ id: str(s['id']), name: str(s['name']), primary: s['primary'] === true, note: str(s['reusePlan']) })),
    props: listOf(o, 'props').map((p) => ({ id: str(p['id']), name: str(p['name']), function: str(p['function']), beats: strs(p['beatIds']).map((b) => beatType.get(b) ?? b) })),
    beats: listOf(o, 'beats').map((b) => ({ id: str(b['id']), type: str(b['type']), major: b['weight'] === 'major', episode: num(b['episode']), setup: str(b['setup']), payoff: str(b['payoff']) })),
    episodes: episodesIn(o).map((e) => ({
      id: str(e['id']),
      ep: num(e['ep']),
      synopsis: str(e['synopsis']),
      hook: str(e['hook']),
      suspense: str(e['suspense']),
      characters: strs(e['characterIds']).map(name),
      scenes: strs(e['sceneIds']).map(name),
      props: strs(e['propIds']).map(name),
      crowdPlan: str(e['crowdPlan']),
      warnings: strs(e['warnings']),
    })),
  };
}

function flowItem(b: Doc, name: (id: unknown) => string, hookBeat: unknown): FlowItem {
  const line = typeof b['line'] === 'string' && b['line'] !== '';
  return { id: str(b['id']), kind: line ? 'line' : 'action', speaker: line ? name(b['speaker']) || null : null, delivery: line ? str(b['delivery']) : '', text: line ? str(b['line']) : str(b['action']), hook: b['id'] === hookBeat };
}

function scriptOf(v: number, s: Doc, outline: Doc | null): ScriptView {
  const name = namer(outline);
  return {
    v,
    episodes: episodesIn(s).map((e) => {
      const scenes = listOf(e, 'scenes').map((sc, i) => ({
        id: str(sc['id']),
        n: i + 1,
        location: name(sc['sceneId']),
        lighting: str(sc['lighting']),
        characters: strs(sc['characters']).map(name),
        props: strs(sc['props']).map(name),
        flow: listOf(sc, 'flow').map((b) => flowItem(b, name, e['hookBeat'])),
      }));
      return { id: str(e['id']), ep: num(e['ep']), targetSeconds: num(e['targetSeconds']) || null, hook: str(e['hook']), cliff: str(e['cliff']), beatsClaimed: strs(e['beatsClaimed']), lines: scenes.reduce((n, sc) => n + sc.flow.filter((b) => b.kind === 'line').length, 0), scenes };
    }),
  };
}

export async function outlinePage(project: Project, id: string): Promise<OutlinePage> {
  const cur = current(project.db, 'outline');
  return { project: projectHead(project, id), gates: cur ? await stageGates(project, 'outline').catch(() => null) : null, outline: cur ? outlineOf(cur.v, cur.doc) : null };
}

export async function scriptPage(project: Project, id: string): Promise<ScriptPage> {
  const cur = current(project.db, 'script');
  return { project: projectHead(project, id), gates: cur ? await stageGates(project, 'script').catch(() => null) : null, script: cur ? scriptOf(cur.v, cur.doc, docOf(project.db, 'outline')) : null };
}

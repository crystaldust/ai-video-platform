// 角色与美术页：大纲名单 + 角色卡、美术场景与道具；每个角色出场几集几场、几切、几句台词（数剧本与分镜）。
// 参考图要付费生成（Phase 5），这里只给提示词与「待生成」位。
import { listOf, type Doc } from '../../executor/recipe-kit.ts';
import type { Project } from '../../project.ts';
import { stageGates, type GateResult } from './checkup.ts';
import { docOf, episodesIn, projectHead, type ProjectHead } from './common.ts';

const TIER: Readonly<Record<string, string>> = { lead: '主角', support: '配角', functional: '功能角色' };
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const ids = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);
/** 锚点是 {name, desc}：列表只显示名字（旧格式是纯字符串也认） */
const anchorNames = (x: unknown): string[] => (Array.isArray(x) ? x.map((a) => (typeof a === 'string' ? a : str((a as Doc)?.['name']))).filter(Boolean) : []);

export interface CharacterView {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly role: string;
  /** 功能角色不出图 */
  readonly drawn: boolean;
  readonly card: { readonly oneLiner: string; readonly gender: string; readonly ageRange: string; readonly identity: string; readonly appearance: string; readonly personality: readonly string[]; readonly voice: string; readonly imagePrompt: string; readonly sheet: string; readonly voicePrompt: string } | null;
  readonly usage: { readonly episodes: number; readonly scenes: number; readonly cuts: number; readonly lines: number };
}

export interface ArtItemView {
  readonly id: string;
  readonly kind: 'scene' | 'prop';
  readonly name: string;
  readonly note: string;
  readonly anchors: readonly string[];
  readonly states: readonly string[];
  readonly prompt: string;
}

export interface CastView {
  readonly project: ProjectHead;
  readonly characters: readonly CharacterView[];
  readonly art: readonly ArtItemView[];
  readonly gates: { readonly cast: GateResult | null; readonly art: GateResult | null };
}

function usage(script: Doc | null, board: Doc | null, id: string) {
  const eps = episodesIn(script);
  const scenes = eps.flatMap((e) => listOf(e, 'scenes').filter((sc) => ids(sc['characters']).includes(id)));
  return {
    episodes: eps.filter((e) => listOf(e, 'scenes').some((sc) => ids(sc['characters']).includes(id))).length,
    scenes: scenes.length,
    cuts: episodesIn(board).flatMap((e) => listOf(e, 'segments').flatMap((g) => listOf(g, 'cuts'))).filter((c) => ids(c['characters']).includes(id)).length,
    lines: eps.flatMap((e) => listOf(e, 'scenes').flatMap((sc) => listOf(sc, 'flow'))).filter((b) => b['speaker'] === id && b['line']).length,
  };
}

export async function castView(project: Project, id: string): Promise<CastView> {
  const { db } = project;
  const outline = docOf(db, 'outline');
  const cast = listOf(docOf(db, 'cast'), 'characters');
  const art = docOf(db, 'art');
  const script = docOf(db, 'script');
  const board = docOf(db, 'storyboard');
  const characters = listOf(outline, 'characters').map((c): CharacterView => {
    const cid = str(c['id']);
    const card = cast.find((x) => x['id'] === cid || x['name'] === c['name']);
    const persona = (card?.['persona'] ?? {}) as Doc;
    const image = (card?.['image'] ?? {}) as Doc;
    const voice = (card?.['voice'] ?? {}) as Doc;
    return {
      id: cid,
      name: str(c['name']),
      tier: TIER[str(c['tier'])] ?? str(c['tier']),
      role: str(c['role']),
      drawn: c['tier'] !== 'functional',
      card: card
        ? {
            oneLiner: str(card['oneLiner']),
            gender: str(persona['gender']),
            ageRange: str(persona['ageRange']),
            identity: str(persona['identity']),
            appearance: str(persona['appearance']),
            personality: ids(persona['personality']),
            voice: [voice['timbre'], voice['pace'], voice['emotion']].filter(Boolean).join('；'),
            imagePrompt: str(image['prompt']),
            sheet: str(image['sheet']),
            voicePrompt: str(voice['prompt']),
          }
        : null,
      usage: usage(script, board, cid),
    };
  });
  const scenes = listOf(art, 'scenes').map((s): ArtItemView => ({
    id: str(s['id']),
    kind: 'scene',
    name: str(s['name']),
    note: s['variantOf'] ? `${str(s['variantOf'])} 的变体` : s['primary'] ? '主场景' : '场景',
    anchors: anchorNames(s['anchors']),
    states: listOf(s, 'lighting').map((l) => str(l['state'])),
    prompt: str((s['image'] as Doc | undefined)?.['prompt']),
  }));
  const props = listOf(art, 'props').map((p): ArtItemView => ({
    id: str(p['id']),
    kind: 'prop',
    name: str(p['name']),
    note: `道具${p['scale'] ? ` · ${str(p['scale'])}` : ''}`,
    anchors: anchorNames(p['anchors']),
    states: listOf(p, 'states').map((x) => str(x['state'])),
    prompt: str((p['image'] as Doc | undefined)?.['prompt']),
  }));
  const [castGates, artGates] = await Promise.all([stageGates(project, 'cast').catch(() => null), stageGates(project, 'art').catch(() => null)]);
  return { project: projectHead(project, id), characters, art: [...scenes, ...props], gates: { cast: castGates, art: artGates } };
}

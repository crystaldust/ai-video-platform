// 「附意见打回」的选择逻辑（纯函数，组件只管画）：哪些阶段能打回、默认选哪个、这一下会重写多少。
// 没有产物的阶段打回不了（服务端会拒），不能让人点进去才知道；按集负责的阶段没选集就是重写全部集，要说清并先确认。
import { epLabel } from './format.ts';
import type { Stage } from './types.ts';

const ALL: readonly Stage[] = ['outline', 'cast', 'art', 'script', 'staging', 'storyboard'];
export const PER_EPISODE: readonly Stage[] = ['script', 'staging', 'storyboard'];
export const STAGE_TITLE: Record<Stage, string> = { outline: '大纲', cast: '角色', art: '美术', script: '剧本', staging: '站位', storyboard: '分镜' };

export interface RejectChoices {
  readonly stages: readonly { readonly stage: Stage; readonly enabled: boolean }[];
  /** 没有能打回的阶段时为 null */
  readonly initial: Stage | null;
}

/**
 * preferred：想默认选的阶段，按优先级（上游点名的在前，当前项所在的阶段在后）。
 * 都没有产物时，退到离最后一个最近、有产物的上游。
 */
export function rejectChoices(opts: { cards: readonly { stage: Stage; artifactV: number | null }[]; perEpisode: boolean; preferred: readonly Stage[] }): RejectChoices {
  const has = new Set(opts.cards.filter((c) => c.artifactV !== null).map((c) => c.stage));
  const stages = (opts.perEpisode ? PER_EPISODE : ALL).map((stage) => ({ stage, enabled: has.has(stage) }));
  const enabled = stages.filter((x) => x.enabled).map((x) => x.stage);
  const direct = opts.preferred.find((p) => enabled.includes(p));
  if (direct) return { stages, initial: direct };
  const anchor = opts.preferred.at(-1);
  const before = anchor ? ALL.slice(0, ALL.indexOf(anchor)).reverse().find((s) => enabled.includes(s)) : undefined;
  return { stages, initial: before ?? enabled[0] ?? null };
}

export interface RejectScope {
  readonly text: string;
  /** 要先确认时的提示语；不用确认是 null */
  readonly confirm: string | null;
  /** 范围大，提示要醒目 */
  readonly warn: boolean;
}

/** episodes：多选的集号（一次打回多集）；不给或只有一集时照单集说。 */
export function rejectScope(opts: { stage: Stage; episode: number | null; episodes?: readonly number[]; totalEpisodes: number }): RejectScope {
  const title = STAGE_TITLE[opts.stage];
  const many = [...new Set(opts.episodes ?? [])].sort((a, b) => a - b);
  if (many.length > 1) {
    const list = many.map(epLabel).join('、');
    return { text: `依次重跑第 ${list} 集的${title}`, confirm: `按同一条意见依次重跑第 ${list} 集（共 ${many.length} 集）的${title}，每集调一次文本模型，会花钱；下游受影响的集会标需复核。\n\n确定？`, warn: false };
  }
  // 只勾了一集：以勾的那集为准（可能不是打开面板时的那集）
  const one = many.length === 1 ? many[0]! : opts.episode;
  if (one !== null) return { text: `只重跑第 ${epLabel(one)} 集的${title}`, confirm: null, warn: false };
  if (!PER_EPISODE.includes(opts.stage)) return { text: `重跑整个${title}`, confirm: null, warn: false };
  const all = `全部 ${opts.totalEpisodes} 集`;
  return {
    text: `没选集：将重写${all}的${title}`,
    confirm: `没有选中某一集，这次会按意见重写${all}的${title}，下游也要整份重跑。只想改一集的话，先在左边分集表里点那一集。\n\n确定重写${all}？`,
    warn: true,
  };
}

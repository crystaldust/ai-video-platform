// 生成任务页与付费确认弹窗的纯逻辑：状态 → 颜色与文字、进度数字、费用文字、预览切换、视图名、确认弹窗里要扣掉的已生成项。
// 不碰 DOM，根目录的 node:test 直接测（test/generation-view.test.ts）。
import type { GateSummary, SkipByNode, TaskCard } from './types.ts';

export type Tone = 'ok' | 'warn' | 'err' | 'run' | 'idle';
type Status = TaskCard['status'];

const TONE: Readonly<Record<Status, Tone>> = {
  planned: 'idle',
  submitting: 'run',
  submitted: 'run',
  running: 'run',
  succeeded: 'run',
  collected: 'ok',
  failed: 'err',
  rejected: 'warn',
  cancelled: 'idle',
  unknown: 'warn',
};

const LABEL: Readonly<Record<Status, string>> = {
  planned: '排队',
  submitting: '提交中',
  submitted: '生成中',
  running: '生成中',
  succeeded: '下载中',
  collected: '已完成',
  failed: '失败',
  rejected: '被拒',
  cancelled: '已取消',
  unknown: '结果未知',
};

export const taskTone = (status: Status): Tone => TONE[status];
export const taskLabel = (status: Status): string => LABEL[status];

/** 页面上该怎么说一条任务：排队中的任务，生成没在跑时是「未提交」，超了上限是「预算停下」。 */
export function taskState(card: Pick<TaskCard, 'status' | 'costEstimate'>, ctx: { readonly running: boolean; readonly spent: number; readonly cap: number | null }): { tone: Tone; label: string } {
  if (card.status !== 'planned') return { tone: taskTone(card.status), label: taskLabel(card.status) };
  if (!ctx.running && ctx.cap !== null && ctx.spent + (card.costEstimate ?? 0) > ctx.cap + 1e-9) return { tone: 'idle', label: '预算停下' };
  return { tone: 'idle', label: ctx.running ? '排队' : '未提交' };
}

const ACTIVE: readonly Status[] = ['submitting', 'submitted', 'running', 'succeeded'];
const FAILED: readonly Status[] = ['failed', 'unknown'];

export interface Progress {
  readonly total: number;
  readonly done: number;
  readonly active: number;
  readonly queued: number;
  readonly failed: number;
  readonly rejected: number;
  /** 0–1：完成的占比 */
  readonly ratio: number;
  /** 0–1：失败与被拒的占比（进度条尾巴的红色） */
  readonly badRatio: number;
}

export function progressOf(g: Pick<GateSummary, 'counts' | 'total'>): Progress {
  const c = g.counts;
  const sum = (xs: readonly Status[]) => xs.reduce((a, s) => a + (c[s] ?? 0), 0);
  const failed = sum(FAILED);
  const rejected = c.rejected ?? 0;
  const done = c.collected ?? 0;
  return { total: g.total, done, active: sum(ACTIVE), queued: c.planned ?? 0, failed, rejected, ratio: g.total ? done / g.total : 0, badRatio: g.total ? (failed + rejected) / g.total : 0 };
}

const yuan = (n: number): string => `¥${n.toFixed(2)}`;

/** 缩略图下面那行费用：完成的给实际（没有就预估），失败、被拒没花钱的写「不计费」，没提交的写预估。 */
export function costText(card: Pick<TaskCard, 'status' | 'costEstimate' | 'costActual'>): string {
  if (card.costActual === 0) return '不计费';
  if (card.costActual !== null) return yuan(card.costActual);
  if (card.costEstimate === null) return '—';
  return card.status === 'collected' ? yuan(card.costEstimate) : `${yuan(card.costEstimate)} 预估`;
}

/** 预览里左右切换：到头就停在头上（不绕回去），没找到当前的从第一个开始。 */
export function nextPreview<T>(list: readonly T[], current: T | null, dir: 1 | -1): T | null {
  if (!list.length) return null;
  const i = current === null ? -1 : list.indexOf(current);
  if (i < 0) return list[0]!;
  return list[Math.min(list.length - 1, Math.max(0, i + dir))]!;
}

const VIEW_TITLE: Readonly<Record<string, string>> = {
  'front-full': '正面全身',
  'face-front': '正脸大头照',
  'side-full': '90° 侧面全身',
  'back-full': '背面全身',
  'face-45': '45° 大头照',
};
export const viewTitle = (view: string): string => VIEW_TITLE[view] ?? view;

export const NODE_TITLE: Readonly<Record<string, string>> = { 'image:character-refs': '角色参考图', 'image:keyframe': '关键帧', 'video:segment': '视频' };

/**
 * 确认弹窗：按现在的勾选，会跳过多少已生成的、省多少钱。
 * refs：角色参考图勾没勾；picked：「节点|集 id」。
 */
export function skippedFor(skip: SkipByNode, refs: boolean, picked: ReadonlySet<string>): { count: number; cny: number; byNode: Record<string, { count: number; cny: number }> } {
  const byNode: Record<string, { count: number; cny: number }> = {};
  for (const [node, s] of Object.entries(skip)) {
    const eps = Object.entries(s.byEpisode);
    const hit = eps.length ? eps.filter(([ep]) => picked.has(`${node}|${ep}`)).reduce((a, [, e]) => ({ count: a.count + e.count, cny: a.cny + e.cny }), { count: 0, cny: 0 }) : node === 'image:character-refs' && refs ? { count: s.count, cny: s.cny } : { count: 0, cny: 0 };
    if (hit.count) byNode[node] = hit;
  }
  const all = Object.values(byNode);
  return { count: all.reduce((a, x) => a + x.count, 0), cny: all.reduce((a, x) => a + x.cny, 0), byNode };
}

/** 确认单勾了什么，一句话：「角色参考图 · 关键帧 2 集 · 视频 1 集」。 */
export function selectionText(selection: unknown): string {
  if (!selection || typeof selection !== 'object') return '—';
  const parts = Object.entries(selection as Record<string, unknown>).flatMap(([node, v]) => {
    const title = NODE_TITLE[node] ?? node;
    if (v === true) return [title];
    return Array.isArray(v) && v.length ? [`${title} ${v.length} 集`] : [];
  });
  return parts.length ? parts.join(' · ') : '—';
}

/** 生成失败时页面上的直达操作：要请求的接口（项目内路径）和参数、按钮文字、确认语。 */
export interface Remedy {
  readonly label: string;
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly confirm: string;
}

/**
 * 从失败原因认出能一键补救的情况。目前只有一种：角色卡缺出图提示词（计划报「先重跑角色阶段」）→ 只补出图提示词（不重写角色卡）。
 * 别的原因（凭据、单价、分镜改过…）只显示原因，不给按钮。
 */
export function remedyFor(error: string | null | undefined): Remedy | null {
  if (!error || !error.includes('先重跑角色阶段')) return null;
  return {
    label: '补提示词',
    path: '/refs',
    body: {},
    confirm: '补出图提示词：给出图角色补上出图提示词，不改角色卡正文，外形不变，分镜不会因此需复核。会调一次文本模型，花一点钱。跑完后回生成任务页点「继续生成」。确定？',
  };
}

export type GatePhase = 'running' | 'failed' | 'pending' | 'progress';

/**
 * 确认单在全貌付费条、生成任务页上显示成哪种样子：
 * 在跑 → running；有原因 → failed（「没开始」或「出错停下」）；一条任务都没建、开跑会建几条 → pending（「待开始」）；
 * 其余（有任务，或者同样的输入都生成过了）→ progress。
 */
export function gatePhase(g: { readonly running: boolean; readonly error: string | null; readonly toCreate: number | null; readonly total: number }): GatePhase {
  if (g.running) return 'running';
  if (g.error) return 'failed';
  if (g.total === 0 && (g.toCreate ?? 0) > 0) return 'pending';
  return 'progress';
}

/**
 * 全貌「确认付费生成」按钮：有等待确认的确认单就打开它（open）；没有就先按当前估算开一张（create）。
 * 有后台任务在跑、或者估算算不出来时不能点，disabledReason 说为什么。
 */
export function paidButton(s: { readonly gateId: number | null; readonly busy: boolean; readonly hasEstimate: boolean }): { action: 'open' | 'create'; gateId: number | null; disabledReason: string | null } {
  const action = s.gateId === null ? 'create' : 'open';
  const disabledReason = s.busy ? '有任务在跑，等它结束' : !s.hasEstimate ? '估算算不出来（看付费条上的原因），没法开确认单' : null;
  return { action, gateId: s.gateId, disabledReason };
}

/**
 * 因为项目已有后台任务在跑而置灰的按钮，悬停和提示行都用这一句说明原因。没有任务为 null。
 * 付费生成可以在生成任务页停下，顺带提一句。
 */
export function busyReason(job: { readonly kind: string; readonly detail: string } | null | undefined): string | null {
  if (!job) return null;
  const tail = job.kind === 'generate' || job.kind === 'resume' ? '（生成任务页可以停止）' : '';
  return `「${job.detail}」正在跑，等它跑完再操作${tail}`;
}

/**
 * 一次打回多集结束时的一句汇总（job-end 的 result.episodes）；单集或不是打回的结果返回 null。
 * 例：「打回分镜：第 02、04 集通过，第 05 集失败（…余额不足）」。
 */
export function rejectSummary(result: unknown): { text: string; failed: boolean } | null {
  const r = result as { stage?: unknown; episodes?: unknown } | null;
  if (!r || !Array.isArray(r.episodes) || r.episodes.length < 2) return null;
  const eps = r.episodes as { ep: number | null; status: string; error: string | null }[];
  const label = (e: { ep: number | null }) => (e.ep === null ? '?' : String(e.ep).padStart(2, '0'));
  const ok = eps.filter((e) => e.status === 'passed');
  const bad = eps.filter((e) => e.status !== 'passed');
  const titles: Readonly<Record<string, string>> = { outline: '大纲', cast: '角色', art: '美术', script: '剧本', staging: '站位', storyboard: '分镜' };
  const skipped = bad.filter((e) => e.status === 'skipped');
  const failed = bad.filter((e) => e.status !== 'skipped');
  const parts = [
    ok.length ? `第 ${ok.map(label).join('、')} 集通过` : '',
    ...failed.map((e) => `第 ${label(e)} 集${e.status === 'needs_human' ? '转人工' : '失败'}${e.error ? `（${e.error.slice(0, 40)}）` : ''}`),
    skipped.length ? `第 ${skipped.map(label).join('、')} 集没再试（前面连着出同样的错）` : '',
  ].filter(Boolean);
  return { text: `打回${titles[String(r.stage)] ?? ''}：${parts.join('，')}`, failed: bad.length > 0 };
}

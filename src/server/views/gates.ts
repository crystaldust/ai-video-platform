// 付费确认弹窗：确认单里存的估算，加上每集现在的状态（需复核、分镜还没有的集默认不勾）。
// 确认记下勾选与上限、改状态；路由随后开后台任务跑付费生成（routes/actions.ts）。
import { previewGeneration } from '../../generate/planner.ts';
import type { PriceSources } from '../../pricing/prices.ts';
import { isPaidNode } from '../../repo/tasks.ts';
import { pendingCells } from '../../orchestrate/review-matrix.ts';
import type { Project } from '../../project.ts';
import type { ProjectEstimate } from '../../estimate/estimate.ts';
import { createPaidGate, decidePaidGate, getPaidGate, listPaidGates, type PaidGateRow } from '../../repo/paid-gates.ts';
import { HttpError } from '../http.ts';
import { listOf } from '../../executor/recipe-kit.ts';
import { docOf, episodesIn, STAGE_TITLES } from './common.ts';

/** 会被跳过的已生成项（同样的输入以前入库过，不再出、不计费）：按节点，按集算的节点再按集拆开。 */
export interface SkipCount {
  readonly count: number;
  readonly cny: number;
}
export type SkipByNode = Readonly<Record<string, SkipCount & { readonly byEpisode: Readonly<Record<string, SkipCount>> }>>;

export interface GateView {
  readonly gate: PaidGateRow;
  readonly skipByNode: SkipByNode;
  /** 按节点：计划不出来的原因（比如角色卡缺出图提示词）。弹窗里勾了这个节点就不能确认 */
  readonly planErrors: Readonly<Record<string, string>>;
  readonly episodes: readonly { readonly id: string; readonly ep: number; readonly state: 'ok' | 'stale' | 'missing'; readonly note: string | null }[];
  /** 出参考图的人物（功能角色不出图） */
  readonly characters: readonly string[];
}

/**
 * 按节点各预览一遍（每个节点「全部都勾」）：会跳过的项按节点、按集给出，弹窗再按实际勾选挑出来、从合计里扣掉
 * （web/src/generation.ts 的 skippedFor），改勾选不用再请求。哪个节点计划不出来（比如角色卡缺出图提示词），
 * 原因记在 planErrors 里，弹窗勾了这个节点就不让确认——确认了也只会在后台失败。
 * 视频要连关键帧一起计划（依赖），只取视频那部分的跳过项；关键帧计划不出来时视频也不能勾（原因带上关键帧的）。
 */
function skips(project: Project, gate: PaidGateRow, prices: PriceSources): { skipByNode: SkipByNode; planErrors: Readonly<Record<string, string>> } {
  const all = (node: string): true | string[] | undefined => {
    const n = gate.estimate.nodes.find((x) => x.node === node);
    return n ? (n.episodes ? n.episodes.map((e) => e.episode) : true) : undefined;
  };
  const out: Record<string, { count: number; cny: number; byEpisode: Record<string, SkipCount> }> = {};
  const planErrors: Record<string, string> = {};
  for (const node of gate.estimate.nodes.map((n) => n.node).filter(isPaidNode)) {
    if (node === 'video:segment' && planErrors['image:keyframe']) {
      planErrors[node] = `要先有关键帧，关键帧计划不出来：${planErrors['image:keyframe']}`;
      continue;
    }
    const selection = node === 'video:segment' ? { 'image:keyframe': all('image:keyframe'), [node]: all(node) } : { [node]: all(node) };
    try {
      for (const s of previewGeneration(project.db, { id: gate.id, estimate: gate.estimate, selection }, prices).skipped.filter((x) => x.node === node)) {
        const n = (out[node] ??= { count: 0, cny: 0, byEpisode: {} });
        n.count += 1;
        n.cny += s.costCny ?? 0;
        if (s.episodeKey) {
          const ep = n.byEpisode[s.episodeKey] ?? { count: 0, cny: 0 };
          n.byEpisode[s.episodeKey] = { count: ep.count + 1, cny: ep.cny + (s.costCny ?? 0) };
        }
      }
    } catch (e) {
      planErrors[node] = (e as Error).message;
    }
  }
  return { skipByNode: out, planErrors };
}

export function gateView(project: Project, gateId: number, prices: PriceSources): GateView {
  const { db } = project;
  const gate = getPaidGate(db, gateId);
  if (!gate) throw new HttpError(404, `没有这张付费确认单：${gateId}`);
  const cells = pendingCells(db);
  const boarded = new Set(episodesIn(docOf(db, 'storyboard')).map((e) => e['id']));
  const episodes = episodesIn(docOf(db, 'outline')).map((e) => {
    const id = String(e['id']);
    const stale = cells.filter((c) => c.episode === id);
    const state = !boarded.has(id) ? ('missing' as const) : stale.length ? ('stale' as const) : ('ok' as const);
    const note = state === 'missing' ? '还没有分镜' : state === 'stale' ? `${[...new Set(stale.map((c) => STAGE_TITLES[c.stage]))].join('、')}需复核` : null;
    return { id, ep: Number(e['ep']), state, note };
  });
  const characters = listOf(docOf(db, 'outline'), 'characters').filter((c) => c['tier'] !== 'functional').map((c) => String(c['name']));
  return { gate, ...skips(project, gate, prices), episodes, characters };
}

/** 勾选：节点 → 集 id 列表（按集算的节点）或 true（整个节点，如角色参考图）。只接受确认单里有的节点和集。 */
export function checkSelection(gate: PaidGateRow, selection: unknown): Record<string, true | string[]> {
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) throw new HttpError(400, 'selection 应该是对象');
  const out: Record<string, true | string[]> = {};
  for (const [node, value] of Object.entries(selection as Record<string, unknown>)) {
    const est = gate.estimate.nodes.find((n) => n.node === node);
    if (!est) throw new HttpError(400, `确认单里没有节点 ${node}`);
    if (value === true) {
      out[node] = true;
      continue;
    }
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new HttpError(400, `${node} 的勾选应该是集 id 列表或 true`);
    const known = new Set(est.episodes?.map((e) => e.episode) ?? []);
    const unknown = value.filter((v) => !known.has(v));
    if (unknown.length) throw new HttpError(400, `${node} 没有这些集的估算：${unknown.join('、')}`);
    out[node] = value;
  }
  return out;
}

export function decideGate(project: Project, gateId: number, body: { action: string; selection?: unknown; budgetCap?: unknown }): PaidGateRow {
  const gate = getPaidGate(project.db, gateId);
  if (!gate) throw new HttpError(404, `没有这张付费确认单：${gateId}`);
  if (body.action === 'cancel') return decidePaidGate(project.db, gateId, { status: 'cancelled' });
  if (body.action !== 'confirm') throw new HttpError(400, 'action 只能是 confirm 或 cancel');
  // 没给就是不设上限；给了（包括 null、NaN 序列化出来的 null）就必须是正数，免得打错字静默变成「不设上限」
  const budgetCap = body.budgetCap === undefined ? undefined : Number(body.budgetCap);
  if (budgetCap !== undefined && !(Number.isFinite(budgetCap) && budgetCap > 0)) throw new HttpError(400, `单次上限要是正数：${String(body.budgetCap)}`);
  return decidePaidGate(project.db, gateId, { status: 'confirmed', selection: checkSelection(gate, body.selection ?? {}), ...(budgetCap !== undefined ? { budgetCap, currency: 'CNY' } : {}) });
}

/**
 * 页面上的「确认付费生成」：已有等待确认的确认单就用它；没有就按当前估算开一张（不挂编排，不必空跑一遍文本阶段）。
 * 有需复核的集也能开：弹窗里那些集默认不勾，可以先只出角色图。估算失败就不开，回 400 说原因。
 */
export function openGate(project: Project, estimate: () => ProjectEstimate): { id: number; created: boolean } {
  const waiting = listPaidGates(project.db).filter((g) => g.status === 'awaiting_confirmation').at(-1);
  if (waiting) return { id: waiting.id, created: false };
  let est: ProjectEstimate;
  try {
    est = estimate();
  } catch (e) {
    throw new HttpError(400, `估算失败，没有开确认单：${(e as Error).message}`);
  }
  return { id: createPaidGate(project.db, { orchestrationId: null, estimate: est }).id, created: true };
}

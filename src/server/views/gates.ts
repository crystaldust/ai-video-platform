// 付费确认弹窗：确认单里存的估算，加上每集现在的状态（需复核、分镜还没有的集默认不勾）。
// 确认只记勾选与上限、改状态；实际生成在 Phase 5。
import { pendingCells } from '../../orchestrate/review-matrix.ts';
import type { Project } from '../../project.ts';
import { decidePaidGate, getPaidGate, type PaidGateRow } from '../../repo/paid-gates.ts';
import { HttpError } from '../http.ts';
import { listOf } from '../../executor/recipe-kit.ts';
import { docOf, episodesIn, STAGE_TITLES } from './common.ts';

export interface GateView {
  readonly gate: PaidGateRow;
  readonly episodes: readonly { readonly id: string; readonly ep: number; readonly state: 'ok' | 'stale' | 'missing'; readonly note: string | null }[];
  /** 出参考图的人物（功能角色不出图） */
  readonly characters: readonly string[];
}

export function gateView(project: Project, gateId: number): GateView {
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
  return { gate, episodes, characters };
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

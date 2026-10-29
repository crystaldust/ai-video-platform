// 费用估算：用量区间 × 价格（按来源链取），每个节点、整个项目给出区间。只读，不写库。
// 查不到价格的节点显示「无价格」、不按 0 计，合计标出「不完整」。所有数字仅供参考。
import type { DatabaseSync } from 'node:sqlite';
import { resolveNodeModel } from '../repo/models.ts';
import { loadPresets, type Preset, type PresetDirs } from '../presets/presets.ts';
import { describeHit, loadFx, loadPriceSources, lookupPrice, type Fx, type PriceSources } from '../pricing/prices.ts';
import { estimateUsage, type NodeUsage, type Range } from './usage.ts';

const PER_MILLION = 1_000_000;

export interface NodeEstimate {
  readonly node: NodeUsage['node'];
  readonly model: string;
  readonly params: Readonly<Record<string, string>>;
  readonly from: 'override' | 'preset';
  readonly usage: NodeUsage['parts'];
  /** USD；有任何一项查不到价格就是 null */
  readonly cost: Range | null;
  readonly prices: readonly string[];
  readonly assumptions: readonly string[];
}

export interface ProjectEstimate {
  readonly preset: string;
  readonly nodes: readonly NodeEstimate[];
  readonly total: Range;
  /** 有节点没价格：合计只算了有价格的部分 */
  readonly incomplete: boolean;
  readonly currency: 'USD';
  readonly fx: Fx;
  readonly note: string;
}

export interface EstimateOptions {
  /** 不给就用项目当前预设（含节点覆盖）；给了就看「整套换成这个预设」会怎样（不算节点覆盖） */
  readonly preset?: string;
  readonly presetDirs?: PresetDirs;
  readonly prices?: PriceSources;
  readonly fx?: Fx;
  /** 已读好的预设，免得每个节点重读一遍 */
  readonly presets?: readonly Preset[];
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

function priceNode(usage: NodeUsage, model: string, params: Readonly<Record<string, string>>, prices: PriceSources): { cost: Range | null; notes: string[] } {
  let low = 0;
  let high = 0;
  const notes: string[] = [];
  for (const part of usage.parts) {
    const hit = lookupPrice(prices, model, part.unit, params);
    if (hit && hit.entry.currency !== 'USD') {
      notes.push(`${part.unit}：价格币种是 ${hit.entry.currency}，估算统一按 USD，未计入`);
      return { cost: null, notes };
    }
    if (!hit) {
      notes.push(`${part.unit}：无价格`);
      return { cost: null, notes };
    }
    const per = part.unit === 'token_in' || part.unit === 'token_out' ? hit.entry.price / PER_MILLION : hit.entry.price;
    low += part.qty.low * per;
    high += part.qty.high * per;
    notes.push(`${part.unit} $${hit.entry.price}${part.unit.startsWith('token') ? '/百万' : ''}（${describeHit(hit)}）`);
  }
  return { cost: { low: round(low), high: round(high) }, notes };
}

export function estimateProject(db: DatabaseSync, opts: EstimateOptions = {}): ProjectEstimate {
  const prices = opts.prices ?? loadPriceSources();
  const fx = opts.fx ?? loadFx();
  const usages = estimateUsage(db);
  const presets = opts.presets ?? loadPresets(opts.presetDirs);
  let presetName = opts.preset ?? '';
  const nodes = usages.map((usage): NodeEstimate => {
    const resolved = resolveNodeModel(db, usage.node, { presets, ...(opts.preset ? { preset: opts.preset, ignoreOverrides: true } : {}) });
    presetName = resolved.preset;
    const { cost, notes } = usage.parts.length ? priceNode(usage, resolved.model, resolved.params, prices) : { cost: null, notes: ['没有用量可估'] };
    return { node: usage.node, model: resolved.model, params: resolved.params, from: resolved.from, usage: usage.parts, cost, prices: notes, assumptions: usage.assumptions };
  });
  const priced = nodes.filter((n) => n.cost);
  return {
    preset: presetName,
    nodes,
    total: { low: round(priced.reduce((a, n) => a + n.cost!.low, 0)), high: round(priced.reduce((a, n) => a + n.cost!.high, 0)) },
    incomplete: priced.length < nodes.length,
    currency: 'USD',
    fx,
    note: '仅供参考：价格来自内置表或接口拉取，生成后以实际费用为准',
  };
}

/** 几套预设并排比较。 */
export function compareEstimates(db: DatabaseSync, names: readonly string[], opts: Omit<EstimateOptions, 'preset'> = {}): ProjectEstimate[] {
  const shared = { ...opts, prices: opts.prices ?? loadPriceSources(), fx: opts.fx ?? loadFx(), presets: opts.presets ?? loadPresets(opts.presetDirs) };
  return names.map((preset) => estimateProject(db, { ...shared, preset }));
}

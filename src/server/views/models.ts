// 模型与预设页：预设（各自的估算合计）、每个节点当前用的模型（是否覆盖、生产级预设用什么、本节点估算）、
// 可选模型、凭据状态（只显示是否配置与末 4 位，永不回传 key）。
import { listCredentials } from '../../config/credentials.ts';
import { compareEstimates, estimateProject, type ProjectEstimate } from '../../estimate/estimate.ts';
import { NODES, capabilityOfNode, type Node } from '../../model/capabilities.ts';
import { MODELS } from '../../model/registry.ts';
import { loadPresets, presetChoice } from '../../presets/presets.ts';
import type { Project } from '../../project.ts';
import { currentPresetName, resolveNodeModel } from '../../repo/models.ts';
import type { App } from '../app.ts';
import { projectHead, toCny, type ProjectHead } from './common.ts';

export interface ModelsView {
  readonly project: ProjectHead;
  readonly presets: readonly { readonly name: string; readonly title: string; readonly description: string; readonly current: boolean; readonly total: { readonly low: number; readonly high: number } | null; readonly incomplete: boolean }[];
  readonly nodes: readonly {
    readonly node: Node;
    readonly capability: string;
    readonly model: string;
    readonly params: Readonly<Record<string, string>>;
    readonly overridden: boolean;
    /** 别的预设在这个节点上用什么 */
    readonly others: readonly { readonly preset: string; readonly model: string | null; readonly params: Readonly<Record<string, string>> }[];
    readonly estimate: { readonly low: number; readonly high: number } | null;
  }[];
  readonly models: readonly { readonly id: string; readonly title: string; readonly capability: string; readonly params: Readonly<Record<string, readonly string[]>> }[];
  readonly credentials: readonly { readonly provider: string; readonly source: string | null; readonly masked: string | null }[];
  readonly fx: { readonly usdToCny: number; readonly source: string } | null;
  readonly estimateError: string | null;
}

const cny = (r: { low: number; high: number } | null, e: ProjectEstimate) => (r ? { low: toCny(r.low, e.fx), high: toCny(r.high, e.fx) } : null);

export function modelsView(app: App, project: Project, id: string): ModelsView {
  const { db } = project;
  const dirs = app.config.presetDirs;
  const presets = loadPresets(dirs);
  const current = currentPresetName(db);
  let estimates: ProjectEstimate[] = [];
  let estimateError: string | null = null;
  try {
    // 当前预设算节点覆盖；其他预设看「整套换过去」
    const mine = app.config.estimate ? app.config.estimate(db) : estimateProject(db, dirs ? { presetDirs: dirs } : {});
    const others = app.config.estimate ? [] : compareEstimates(db, presets.map((p) => p.name).filter((n) => n !== current), dirs ? { presetDirs: dirs } : {});
    estimates = [mine, ...others];
  } catch (error) {
    estimateError = error instanceof Error ? error.message : String(error);
  }
  const mine = estimates[0];
  return {
    project: projectHead(project, id),
    presets: presets.map((p) => {
      const e = estimates.find((x) => x.preset === p.name);
      return { name: p.name, title: p.title, description: p.description, current: p.name === current, total: e ? cny(e.total, e) : null, incomplete: e?.incomplete ?? false };
    }),
    nodes: NODES.map((node) => {
      const r = resolveNodeModel(db, node, dirs ? { dirs } : {});
      const est = mine?.nodes.find((n) => n.node === node);
      return {
        node,
        capability: capabilityOfNode(node),
        model: r.model,
        params: r.params,
        overridden: r.from === 'override',
        others: presets.filter((p) => p.name !== current).map((p) => {
          const c = presetChoice(p, node);
          return { preset: p.name, model: c?.model ?? null, params: c?.params ?? {} };
        }),
        estimate: est && mine ? cny(est.cost, mine) : null,
      };
    }),
    models: MODELS.map((m) => ({ id: m.id, title: m.title, capability: m.capability, params: m.params ?? {} })),
    credentials: listCredentials(app.config.credentials),
    fx: mine ? { usdToCny: mine.fx.usdToCny, source: mine.fx.source } : null,
    estimateError,
  };
}

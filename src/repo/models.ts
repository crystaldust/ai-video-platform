// 项目的模型选择：用哪套预设（默认 budget），哪些节点单独覆盖。切换预设不改代码，覆盖可撤销。
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../domain/clock.ts';
import { isNode, type Node } from '../model/capabilities.ts';
import { checkChoice, findPreset, presetChoice, type NodeChoice, type Preset, type PresetDirs } from '../presets/presets.ts';

export const DEFAULT_PRESET = 'budget';

export function currentPresetName(db: DatabaseSync): string {
  const row = db.prepare('SELECT preset FROM project_preset ORDER BY id DESC LIMIT 1').get() as { preset: string } | undefined;
  return row?.preset ?? DEFAULT_PRESET;
}

/** 换预设：先确认预设存在且通过校验，再记下。 */
export function usePreset(db: DatabaseSync, name: string, dirs: PresetDirs = {}): void {
  findPreset(name, dirs);
  db.prepare('INSERT INTO project_preset (preset, set_at) VALUES (?, ?)').run(name, nowIso());
}

function assertNode(node: string): asserts node is Node {
  if (!isNode(node)) throw new Error(`不认识的节点：${node}`);
}

export function setNodeModel(db: DatabaseSync, node: string, choice: NodeChoice): void {
  assertNode(node);
  const problems = checkChoice(node, choice);
  if (problems.length) throw new Error(problems.join('；'));
  db.prepare('INSERT INTO node_model_override (node, model, params, set_at) VALUES (?, ?, ?, ?)').run(node, choice.model, JSON.stringify(choice.params), nowIso());
}

export function clearNodeModel(db: DatabaseSync, node: string): void {
  assertNode(node);
  db.prepare(`INSERT INTO node_model_override (node, model, params, set_at) VALUES (?, NULL, '{}', ?)`).run(node, nowIso());
}

function currentOverride(db: DatabaseSync, node: Node): NodeChoice | null {
  const row = db.prepare('SELECT model, params FROM node_model_override WHERE node = ? ORDER BY id DESC LIMIT 1').get(node) as
    | { model: string | null; params: string }
    | undefined;
  return row?.model ? { model: row.model, params: JSON.parse(row.params) } : null;
}

export interface ResolvedModel extends NodeChoice {
  readonly from: 'override' | 'preset';
  readonly preset: string;
}

/** 节点现在用哪个模型：节点覆盖优先，其次当前预设。`preset` 参数用于估算「换成另一套会怎样」。 */
export function resolveNodeModel(db: DatabaseSync, node: Node, opts: { preset?: string; dirs?: PresetDirs; presets?: readonly Preset[]; ignoreOverrides?: boolean } = {}): ResolvedModel {
  const presetName = opts.preset ?? currentPresetName(db);
  const override = opts.ignoreOverrides ? null : currentOverride(db, node);
  if (override) return { ...override, from: 'override', preset: presetName };
  const preset = opts.presets ? opts.presets.find((p) => p.name === presetName) : findPreset(presetName, opts.dirs);
  if (!preset) throw new Error(`没有预设 ${presetName}`);
  const choice = presetChoice(preset, node);
  if (!choice) throw new Error(`预设 ${presetName} 没有给节点 ${node} 配模型`);
  return { ...choice, from: 'preset', preset: presetName };
}

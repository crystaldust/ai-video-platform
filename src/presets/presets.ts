// 预设：一组「节点 → 模型 + 参数」的默认选择。仓库内置两套（presets/），用户配置目录里同名的覆盖它们。
// 预设是外部 JSON：逐字段校验，模型必须在注册表里、能力和节点对得上、参数值在允许范围内。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../config/paths.ts';
import { capabilityOfNode, isNode, NODES, type Node } from '../model/capabilities.ts';
import { findModel, isCommandModel } from '../model/registry.ts';

export const BUILTIN_PRESET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'presets');

export interface NodeChoice {
  readonly model: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface Preset {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** 键是节点名，或 `text:*` 这类通配 */
  readonly nodes: Readonly<Record<string, NodeChoice>>;
  /** 来自哪里：builtin / user */
  readonly origin: 'builtin' | 'user';
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const WILDCARD = /^(text|image|video):\*$/;

/** 校验一个节点上的选择：模型存在、能力对得上、参数值合法。返回问题清单。 */
export function checkChoice(node: Node | string, choice: NodeChoice): string[] {
  if (isCommandModel(choice.model)) return node.startsWith('text:') ? [] : [`${node} 不能用命令行模型 ${choice.model}`];
  let info;
  try {
    info = findModel(choice.model);
  } catch (error) {
    return [`${node}：${error instanceof Error ? error.message : String(error)}`];
  }
  const want = node.split(':')[0];
  if (info.capability !== want) return [`${node} 需要${want}模型，${choice.model} 是 ${info.capability} 模型`];
  return Object.entries(choice.params).flatMap(([k, v]) => {
    const allowed = info.params?.[k];
    if (!allowed) return [`${node}：${choice.model} 没有参数 ${k}`];
    return allowed.includes(v) ? [] : [`${node}：${choice.model} 的 ${k} 只能是 ${allowed.join(' / ')}，不是 ${v}`];
  });
}

function parseChoice(x: unknown, where: string, problems: string[]): NodeChoice | null {
  if (!isRecord(x) || typeof x['model'] !== 'string') {
    problems.push(`${where} 必须是 { model, params? }`);
    return null;
  }
  const params = x['params'] ?? {};
  if (!isRecord(params) || Object.values(params).some((v) => typeof v !== 'string')) {
    problems.push(`${where}.params 必须是字符串值的对象`);
    return null;
  }
  return { model: x['model'], params: params as Record<string, string> };
}

export function parsePreset(doc: unknown, origin: Preset['origin'], file: string): Preset {
  if (!isRecord(doc)) throw new Error(`预设 ${file} 不是 JSON 对象`);
  const problems: string[] = [];
  const name = typeof doc['name'] === 'string' && NAME.test(doc['name']) ? doc['name'] : '';
  if (!name) problems.push(`name 不合法：${String(doc['name'])}`);
  const raw = isRecord(doc['nodes']) ? doc['nodes'] : null;
  if (!raw) problems.push('nodes 必须是对象');
  const nodes: Record<string, NodeChoice> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!isNode(key) && !WILDCARD.test(key)) {
      problems.push(`不认识的节点：${key}（可选 ${NODES.join(' / ')}，或 text:* 这类通配）`);
      continue;
    }
    const choice = parseChoice(value, `nodes.${key}`, problems);
    if (choice) {
      problems.push(...checkChoice(key, choice));
      nodes[key] = choice;
    }
  }
  if (problems.length) throw new Error(`预设 ${file} 有 ${problems.length} 处问题：\n  ${problems.join('\n  ')}`);
  return {
    name,
    title: typeof doc['title'] === 'string' ? doc['title'] : name,
    description: typeof doc['description'] === 'string' ? doc['description'] : '',
    nodes,
    origin,
  };
}

function loadDir(dir: string, origin: Preset['origin']): Preset[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        throw new Error(`预设 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
      }
      return parsePreset(doc, origin, path);
    });
}

export interface PresetDirs {
  readonly builtin?: string;
  readonly user?: string;
}

/** 内置 + 用户目录（`<配置目录>/presets/`），用户的同名预设覆盖内置的。 */
export function loadPresets(dirs: PresetDirs = {}): Preset[] {
  const builtin = loadDir(dirs.builtin ?? BUILTIN_PRESET_DIR, 'builtin');
  const user = loadDir(dirs.user ?? join(configDir(), 'presets'), 'user');
  const byName = new Map(builtin.map((p) => [p.name, p]));
  for (const p of user) byName.set(p.name, p);
  return [...byName.values()];
}

export function findPreset(name: string, dirs: PresetDirs = {}): Preset {
  const all = loadPresets(dirs);
  const p = all.find((x) => x.name === name);
  if (!p) throw new Error(`没有预设 ${name}（可选 ${all.map((x) => x.name).join(' / ')}）`);
  return p;
}

/** 节点在预设里的选择：具体节点优先于通配；都没有就是 null。 */
export function presetChoice(preset: Preset, node: Node): NodeChoice | null {
  return preset.nodes[node] ?? preset.nodes[`${capabilityOfNode(node)}:*`] ?? null;
}

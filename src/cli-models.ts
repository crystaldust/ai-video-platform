// 模型、预设、费用、价格、凭据相关的命令。表格写 stderr 给人看，JSON 写 stdout 给程序用。
// cred set 只从 stdin 读 key，不接受命令行参数（避免进 shell 历史）。
import { need, withProject } from './cli-shared.ts';
import { isProvider, listCredentials, PROVIDERS, removeCredential, setCredential } from './config/credentials.ts';
import { compareEstimates, estimateProject, type ProjectEstimate } from './estimate/estimate.ts';
import { CAPABILITIES, NODES } from './model/capabilities.ts';
import { MODELS } from './model/registry.ts';
import { loadPresets } from './presets/presets.ts';
import { loadPriceSources, lookupPrice, describeHit, PRICE_UNITS } from './pricing/prices.ts';
import { refreshPriceCache } from './pricing/openrouter.ts';
import { clearNodeModel, currentPresetName, resolveNodeModel, setNodeModel, usePreset } from './repo/models.ts';
import type { CommandResult } from './cli-nodes.ts';

export const MODEL_USAGE = `  models [--capability text|image|video]       列出内置模型与能力
  preset list                                   列出预设（内置 + 用户目录）
  preset use <dir> <name>                       项目换预设
  model show <dir>                              各节点现在用哪个模型（预设 / 覆盖）
  model set <dir> <node> <model> [--param k=v]  单独给一个节点换模型（节点：${NODES.join(' ')}）
  model clear <dir> <node>                      撤销节点覆盖，回到预设
  estimate <dir> [--preset current|budget|production|all]
                                                费用估算（区间，仅供参考）
  prices show [--model <id>]                    查价格及来源层、日期、是否核对官方
  prices refresh                                从 OpenRouter 拉文本价格写进缓存
  cred list | cred set <provider> | cred rm <provider>
                                                凭据（供应商：${PROVIDERS.join(' / ')}）；set 从 stdin 读 key`;

const done = (output: unknown): CommandResult => ({ output, exitCode: 0 });

/** --param k=v[,k2=v2]：每一项都要有 = 和非空的键、值。 */
export function parseParams(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(',').map((pair) => {
      const i = pair.indexOf('=');
      const [k, v] = [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
      if (i <= 0 || !k || !v) throw new Error(`--param 要写成 键=值（多个用逗号分隔）：${pair}`);
      return [k, v];
    }),
  );
}
const err = (line: string) => process.stderr.write(`${line}\n`);
const money = (r: { low: number; high: number } | null) => (r ? `$${r.low.toFixed(2)}–${r.high.toFixed(2)}` : '无价格');

function printEstimates(list: readonly ProjectEstimate[]): void {
  const nodes = list[0]?.nodes ?? [];
  err(['节点'.padEnd(22), ...list.map((e) => e.preset.padEnd(26))].join(''));
  for (const [i, n] of nodes.entries()) {
    err([n.node.padEnd(22), ...list.map((e) => `${money(e.nodes[i]!.cost)} ${e.nodes[i]!.model.split(':')[1]}`.padEnd(26))].join(''));
  }
  err(['合计'.padEnd(22), ...list.map((e) => `${money(e.total)}${e.incomplete ? '（不完整）' : ''}`.padEnd(26))].join(''));
  const fx = list[0]?.fx;
  if (fx) err(`≈ ${list.map((e) => `¥${(e.total.low * fx.usdToCny).toFixed(0)}–${(e.total.high * fx.usdToCny).toFixed(0)}`).join(' / ')}（1 USD = ${fx.usdToCny} CNY，${fx.source}）`);
  err(list[0]?.note ?? '');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function cmdModel(args: string[], flags: Record<string, string>): Promise<CommandResult> {
  const [sub, dir, node, model] = args;
  if (sub === 'show') {
    return done(await withProject(need(dir, 'model show <dir>'), (p) => ({ preset: currentPresetName(p.db), nodes: NODES.map((n) => ({ node: n, ...resolveNodeModel(p.db, n) })) })));
  }
  if (sub === 'set') {
    const usage = 'model set <dir> <node> <model> [--param k=v]';
    need(model, usage);
    const params = parseParams(flags['param']);
    return done(await withProject(need(dir, usage), (p) => {
      setNodeModel(p.db, need(node, usage), { model: model!, params });
      return resolveNodeModel(p.db, node as (typeof NODES)[number]);
    }));
  }
  if (sub === 'clear') {
    const usage = 'model clear <dir> <node>';
    return done(await withProject(need(dir, usage), (p) => {
      clearNodeModel(p.db, need(node, usage));
      return resolveNodeModel(p.db, node as (typeof NODES)[number]);
    }));
  }
  throw new Error('用法：model show <dir> | model set <dir> <node> <model> | model clear <dir> <node>');
}

async function cmdPrices(args: string[], flags: Record<string, string>): Promise<CommandResult> {
  if (args[0] === 'refresh') {
    const r = await refreshPriceCache();
    for (const p of r.problems) err(`⚠ ${p}`);
    err(`✓ 拉到 ${r.entries.length} 条，写进 ${r.path}`);
    return done(r);
  }
  if (args[0] !== 'show') throw new Error('用法：prices show [--model <id>] | prices refresh');
  const src = loadPriceSources();
  const models = flags['model'] ? [flags['model']] : MODELS.map((m) => m.id);
  const rows = models.flatMap((model) => {
    const info = MODELS.find((m) => m.id === model);
    const combos = info?.params ? Object.entries(info.params).flatMap(([k, vs]) => vs.map((v) => ({ [k]: v }))) : [{}];
    return combos.flatMap((params) =>
      PRICE_UNITS.flatMap((unit) => {
        const hit = lookupPrice(src, model, unit, params);
        return hit ? [{ model, params, unit, price: hit.entry.price, currency: hit.entry.currency, from: describeHit(hit), source: hit.entry.source }] : [];
      }),
    );
  });
  // 参数无关的价格（如参考图）在每个参数组合下都会命中一次，去重
  const unique = [...new Map(rows.map((r) => [`${r.model}|${r.unit}|${r.price}|${JSON.stringify(r.params)}`, r])).values()];
  for (const r of unique) err(`${r.model.padEnd(30)}${JSON.stringify(r.params).padEnd(22)}${r.unit.padEnd(16)}${String(r.price).padEnd(8)}${r.currency}  ${r.from}`);
  err('仅供参考');
  return done(unique);
}

async function cmdCred(args: string[]): Promise<CommandResult> {
  const [sub, provider] = args;
  if (sub === 'list') {
    const rows = listCredentials();
    for (const r of rows) err(`${r.provider.padEnd(10)}${r.masked ? `${r.masked}（${r.source}）` : '未配置'}`);
    return done(rows);
  }
  if (!isProvider(provider)) throw new Error(`用法：cred ${sub ?? 'set'} <provider>（${PROVIDERS.join(' / ')}）`);
  if (sub === 'set') {
    if (process.stdin.isTTY) err(`粘贴 ${provider} 的 key 后按回车，再按 Ctrl-D：`);
    setCredential(provider, await readStdin());
    return done({ provider, saved: true });
  }
  if (sub === 'rm') return done({ provider, removed: removeCredential(provider) });
  throw new Error('用法：cred list | cred set <provider> | cred rm <provider>');
}

const COMMANDS: Readonly<Record<string, (args: string[], flags: Record<string, string>) => Promise<CommandResult>>> = {
  models: async (_args, flags) => {
    const cap = flags['capability'];
    if (cap !== undefined && !(CAPABILITIES as readonly string[]).includes(cap)) throw new Error(`--capability 只能是 ${CAPABILITIES.join(' / ')}`);
    return done(MODELS.filter((m) => !cap || m.capability === cap));
  },
  preset: async (args) => {
    if (args[0] === 'list') return done(loadPresets());
    if (args[0] === 'use') {
      const usage = 'preset use <dir> <name>';
      const name = need(args[2], usage);
      return done(await withProject(need(args[1], usage), (p) => {
        usePreset(p.db, name);
        return { preset: currentPresetName(p.db) };
      }));
    }
    throw new Error('用法：preset list | preset use <dir> <name>');
  },
  model: cmdModel,
  estimate: async (args, flags) => {
    const dir = need(args[0], 'estimate <dir> [--preset current|budget|production|all]');
    const which = flags['preset'] ?? 'current';
    const list = await withProject(dir, (p) =>
      which === 'current' ? [estimateProject(p.db)] : which === 'all' ? compareEstimates(p.db, loadPresets().map((x) => x.name)) : [estimateProject(p.db, { preset: which })],
    );
    printEstimates(list);
    return done(list);
  },
  prices: cmdPrices,
  cred: cmdCred,
};

export async function modelCommand(cmd: string, args: string[], flags: Record<string, string>): Promise<CommandResult | null> {
  const handler = COMMANDS[cmd];
  return handler ? handler(args, flags) : null;
}


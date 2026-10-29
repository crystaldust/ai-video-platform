// 从 OpenRouter 公开的模型列表拉文本价格，写进拉取缓存。OpenRouter 价格是它的转售价，未必等于直连价：
// 记作 verified=false 并注明来源，只当参考层之一。pricing 字段是字符串、单位是 USD/token。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config/paths.ts';
import { loadPriceSources, type PriceEntry } from './prices.ts';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface FetchResult {
  readonly entries: readonly PriceEntry[];
  /** 拉到了但用不上的条目（字段缺失、不是数字、列表里没有） */
  readonly problems: readonly string[];
}

const PER_MILLION = 1_000_000;

export async function fetchOpenRouterPrices(wanted: readonly PriceEntry[], fetchFn: typeof fetch = globalThis.fetch, today = new Date().toISOString().slice(0, 10)): Promise<FetchResult> {
  const targets = new Map<string, string>();
  for (const e of wanted) if (e.openrouterId) targets.set(e.openrouterId, e.model);
  if (!targets.size) return { entries: [], problems: [] };
  const res = await fetchFn(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`OpenRouter 模型列表 HTTP ${res.status}`);
  const doc = (await res.json()) as { data?: { id?: unknown; pricing?: Record<string, unknown> }[] };
  const byId = new Map((doc.data ?? []).map((m) => [String(m.id), m.pricing ?? {}]));
  const entries: PriceEntry[] = [];
  const problems: string[] = [];
  for (const [orId, model] of targets) {
    const pricing = byId.get(orId);
    if (!pricing) {
      problems.push(`OpenRouter 列表里没有 ${orId}（${model}）`);
      continue;
    }
    for (const [field, unit] of [['prompt', 'token_in'], ['completion', 'token_out']] as const) {
      const perToken = Number(pricing[field]);
      if (!Number.isFinite(perToken) || perToken < 0) {
        problems.push(`${orId} 的 pricing.${field} 不是数字：${String(pricing[field])}`);
        continue;
      }
      entries.push({ model, unit, price: perToken * PER_MILLION, currency: 'USD', source: OPENROUTER_MODELS_URL, checkedAt: today, verified: false, openrouterId: orId, note: 'OpenRouter 转售价' });
    }
  }
  return { entries, problems };
}

/** 拉一次并写缓存（<配置目录>/prices-cache.json）。 */
export async function refreshPriceCache(dir: string = configDir(), fetchFn: typeof fetch = globalThis.fetch, now = new Date()): Promise<FetchResult & { path: string }> {
  // 不读旧缓存：它可能正是坏掉、等着被这次刷新覆盖的那个
  const src = loadPriceSources(dir, undefined, { skipCache: true });
  const result = await fetchOpenRouterPrices([...src.builtin, ...src.user], fetchFn, now.toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'prices-cache.json');
  writeFileSync(path, `${JSON.stringify({ fetchedAt: now.toISOString(), entries: result.entries }, null, 2)}\n`);
  return { ...result, path };
}

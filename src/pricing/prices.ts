// 价格：按「用户覆盖 → 拉取缓存 → 仓库内置」取第一个有的，并说明取自哪一层、哪个来源、哪天核对、是否核对过官方。
// 所有数字都是参考：多数供应商没有价格接口，界面统一标「仅供参考」，生成后记下实际费用校准。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../config/paths.ts';

export const PRICE_UNITS = ['token_in', 'token_in_cached', 'token_out', 'image', 'ref_image', 'video_second', 'ref_image_extra'] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export interface PriceEntry {
  readonly model: string;
  /** 只在这些参数取值下适用；不写表示通用 */
  readonly params?: Readonly<Record<string, string>>;
  readonly unit: PriceUnit;
  /** token 单位为每百万 token；其余为每张 / 每秒 */
  readonly price: number;
  readonly currency: string;
  readonly source: string;
  readonly checkedAt: string;
  /** false：没能在官方页面核对，只是参考 */
  readonly verified: boolean;
  readonly openrouterId?: string;
  readonly note?: string;
}

export type PriceLayer = 'user' | 'cache' | 'builtin';

export interface PriceHit {
  readonly entry: PriceEntry;
  readonly layer: PriceLayer;
  /** 拉取缓存超过 7 天 */
  readonly stale: boolean;
}

export interface Fx {
  readonly usdToCny: number;
  readonly checkedAt: string;
  readonly source: string;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prices');
export const BUILTIN_PRICES = join(ROOT, 'builtin.json');
const BUILTIN_FX = join(ROOT, 'fx.json');
const STALE_MS = 7 * 24 * 3600_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

/** 价格表是外部 JSON：逐条校验，坏的一条点名报错（不悄悄跳过，免得按 0 计费）。 */
export function parsePriceTable(doc: unknown, file: string): PriceEntry[] {
  const list = isRecord(doc) && Array.isArray(doc['entries']) ? doc['entries'] : null;
  if (!list) throw new Error(`价格表 ${file} 缺少 entries 数组`);
  return list.map((e, i) => {
    const where = `价格表 ${file} 第 ${i + 1} 条`;
    if (!isRecord(e)) throw new Error(`${where}不是对象`);
    const ok =
      typeof e['model'] === 'string' &&
      (PRICE_UNITS as readonly unknown[]).includes(e['unit']) &&
      typeof e['price'] === 'number' &&
      e['price'] >= 0 &&
      typeof e['currency'] === 'string' &&
      typeof e['source'] === 'string' &&
      e['source'] !== '' &&
      typeof e['checkedAt'] === 'string' &&
      DATE.test(e['checkedAt']) &&
      typeof e['verified'] === 'boolean' &&
      (e['params'] === undefined || (isRecord(e['params']) && Object.values(e['params']).every((v) => typeof v === 'string')));
    if (!ok) throw new Error(`${where}字段不全或不合法（需要 model、unit、price ≥ 0、currency、source、checkedAt YYYY-MM-DD、verified）`);
    return e as unknown as PriceEntry;
  });
}

function readTable(path: string): PriceEntry[] {
  if (!existsSync(path)) return [];
  return parsePriceTable(JSON.parse(readFileSync(path, 'utf8')), path);
}

/** 拉取缓存：{ fetchedAt, entries }。 */
export function readCache(path: string): { fetchedAt: string | null; entries: PriceEntry[] } {
  if (!existsSync(path)) return { fetchedAt: null, entries: [] };
  const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const fetchedAt = isRecord(doc) && typeof doc['fetchedAt'] === 'string' ? doc['fetchedAt'] : null;
  return { fetchedAt, entries: parsePriceTable(doc, path) };
}

export interface PriceSources {
  readonly user: readonly PriceEntry[];
  readonly cache: readonly PriceEntry[];
  readonly cacheFetchedAt: string | null;
  readonly builtin: readonly PriceEntry[];
}

export function loadPriceSources(dir: string = configDir(), builtinPath: string = BUILTIN_PRICES, opts: { skipCache?: boolean } = {}): PriceSources {
  const cache = opts.skipCache ? { fetchedAt: null, entries: [] } : readCache(join(dir, 'prices-cache.json'));
  return { user: readTable(join(dir, 'prices.json')), cache: cache.entries, cacheFetchedAt: cache.fetchedAt, builtin: readTable(builtinPath) };
}

/** 条目的参数都和请求一致才算适用；越具体（参数越多）越优先。 */
function best(entries: readonly PriceEntry[], model: string, unit: PriceUnit, params: Readonly<Record<string, string>>): PriceEntry | null {
  const fits = entries.filter((e) => e.model === model && e.unit === unit && Object.entries(e.params ?? {}).every(([k, v]) => params[k] === v));
  return fits.sort((a, b) => Object.keys(b.params ?? {}).length - Object.keys(a.params ?? {}).length)[0] ?? null;
}

export function lookupPrice(src: PriceSources, model: string, unit: PriceUnit, params: Readonly<Record<string, string>> = {}, now: Date = new Date()): PriceHit | null {
  const user = best(src.user, model, unit, params);
  if (user) return { entry: user, layer: 'user', stale: false };
  const cached = best(src.cache, model, unit, params);
  if (cached) {
    const age = src.cacheFetchedAt ? now.getTime() - Date.parse(src.cacheFetchedAt) : Infinity;
    return { entry: cached, layer: 'cache', stale: !(age <= STALE_MS) };
  }
  const builtin = best(src.builtin, model, unit, params);
  return builtin ? { entry: builtin, layer: 'builtin', stale: false } : null;
}

/** 一条价格的说明文字：来源层、日期、是否核对过官方。 */
export const describeHit = (h: PriceHit): string =>
  `${h.layer === 'user' ? '用户价格表' : h.layer === 'cache' ? '接口拉取' : '内置价格表'} ${h.entry.checkedAt}${h.entry.verified ? '' : '（未核对官方）'}${h.stale ? '（可能过期）' : ''}`;

export function loadFx(dir: string = configDir()): Fx {
  for (const path of [join(dir, 'fx.json'), BUILTIN_FX]) {
    if (!existsSync(path)) continue;
    const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isRecord(doc) && typeof doc['usdToCny'] === 'number' && doc['usdToCny'] > 0) {
      return { usdToCny: doc['usdToCny'], checkedAt: String(doc['checkedAt'] ?? ''), source: String(doc['source'] ?? path) };
    }
    throw new Error(`汇率文件 ${path} 缺少正数 usdToCny`);
  }
  throw new Error('找不到汇率文件');
}

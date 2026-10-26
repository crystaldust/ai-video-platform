// 内容指纹：键序不同但内容相同的 JSON 必须得到同一个哈希，
// 否则重复导入同一份产物会凭空长出新版本。
import { createHash } from 'node:crypto';

export const sha256 = (x: string | Uint8Array): string => createHash('sha256').update(x).digest('hex');

function normalize(x: unknown): unknown {
  if (Array.isArray(x)) return x.map((v) => (v === undefined ? null : normalize(v)));
  if (x !== null && typeof x === 'object') {
    const entries = Object.entries(x as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, normalize(v)] as const);
    return Object.fromEntries(entries);
  }
  return x;
}

/**
 * 规范化 JSON：对象键递归排序，数组保持顺序，undefined 字段丢弃（与 JSON.stringify 一致）。
 * 只用于来自 JSON 的数据：Date、Map 这类非纯对象会被当成 {}，BigInt 会抛错。
 */
export const canonicalJson = (x: unknown): string => JSON.stringify(normalize(x)) ?? 'null';

export const contentHash = (x: unknown): string => sha256(canonicalJson(x));

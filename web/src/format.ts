// 显示用的格式：人民币、区间、时长、时刻、集号、质量门。
import type { GateResult } from './types.ts';

export const yuan = (n: number | null | undefined, digits = 2): string => (n === null || n === undefined ? '—' : `¥${n.toFixed(digits)}`);

export const yuanRange = (r: { low: number; high: number } | null | undefined, digits = 1): string =>
  r ? `¥${r.low.toFixed(digits)}–${r.high.toFixed(digits)}` : '无价格';

/** 毫秒 → mm:ss（满一小时 h:mm:ss） */
export function clock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return hh ? `${hh}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`;
}

/** 秒 → 「1 分 5 秒」 */
export const seconds = (s: number): string => (s >= 60 ? `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒` : `${Math.round(s)} 秒`);

export const epLabel = (ep: number): string => String(ep).padStart(2, '0');

/** ISO 时间 → 「10-29 08:35」，今天的只给时刻 */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  const today = new Date().toDateString() === d.toDateString();
  return today ? `${two(d.getHours())}:${two(d.getMinutes())}` : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 毫秒时间戳 → 运行记录里的时刻：今天的给「时:分:秒」，更早的带日期 */
export function stamp(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return new Date().toDateString() === d.toDateString() ? time : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${time}`;
}

export const aspectLabel = (a: string | undefined): string | null => (a === '9:16' ? '竖屏 9:16' : a === '16:9' ? '横屏 16:9' : null);

/** 「6 集 · 竖屏 9:16 · 小成本验证」：缺的项不显示 */
export const joinDot = (...parts: (string | null | undefined | false)[]): string => parts.filter(Boolean).join(' · ');

/** 质量门一句话：几道过了几道；只有 validate 的 skill 说违规数。 */
export const gateText = (label: string, g: GateResult | null): string =>
  !g ? `${label}还没有` : g.total !== null ? `${label}质量门 ${g.passed}/${g.total}` : g.failed.length ? `${label} ${g.failed.length} 处违规` : `${label}质量门通过`;
export const gateTone = (g: GateResult | null): 'idle' | 'err' | 'ok' => (!g ? 'idle' : g.failed.length ? 'err' : 'ok');

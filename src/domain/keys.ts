// 稳定键：所有对象靠它互相引用，不靠文件名或人名猜。
// 格式沿用上游 skill 已有的编号（C01/S01/P01/B01、段号 E01-01），
// 只为上游没有编号的集、剧本场次、分镜补上确定性的键。
import type { EntityKind } from './types.ts';

export const KEY_PATTERNS: Readonly<Record<EntityKind, RegExp>> = {
  episode: /^E\d{2,}$/,
  character: /^C\d{2,}$/,
  location: /^S\d{2,}$/,
  prop: /^P\d{2,}$/,
  beat: /^B\d{2,}$/,
  script_scene: /^E\d{2,}-SC\d{2,}$/,
  segment: /^E\d{2,}-\d{2,}$/,
  cut: /^E\d{2,}-\d{2,}\.c\d+$/,
};

export const isValidKey = (kind: EntityKind, key: unknown): key is string =>
  typeof key === 'string' && KEY_PATTERNS[kind].test(key);

const isPositiveInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;
const pad2 = (n: number) => String(n).padStart(2, '0');

function assertPositiveInt(n: unknown, label: string): asserts n is number {
  if (!isPositiveInt(n)) throw new Error(`${label}必须是正整数：${String(n)}`);
}

/** 集：E01；100 集以上原样 E100。 */
export function episodeKey(ep: unknown): string {
  assertPositiveInt(ep, '集号');
  return `E${pad2(ep)}`;
}

/** 按集组织的键（E01、E01-SC02、E01-03、E01-03.c1）所属的集号；其他键返回 null。 */
export function episodeOfKey(key: string): number | null {
  const m = /^E(\d{2,})(?:$|-)/.exec(key);
  return m ? Number(m[1]) : null;
}

/** 剧本场次：集 + 这一集的第几场（1 起）。 */
export function scriptSceneKey(ep: unknown, index: unknown): string {
  assertPositiveInt(index, '场次序号');
  return `${episodeKey(ep)}-SC${pad2(index)}`;
}

/** 分镜：段号 + 段内序号（1 起），与素材文件 f<切序>.png 的序号一致。 */
export function cutKey(segmentId: string, index: unknown): string {
  if (!isValidKey('segment', segmentId)) throw new Error(`段号格式不对：${segmentId}（应形如 E01-01）`);
  assertPositiveInt(index, '分镜序号');
  return `${segmentId}.c${index}`;
}

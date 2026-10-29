// 稳定键：所有对象靠它互相引用，不靠文件名、人名或位置猜。
// 人物、场景、道具、爽点沿用上游的 C01/S01/P01/B01；
// 集、剧本场次、分镜段、分镜切直接用上游 skill 3.0 分配的稳定 id（ep_/sc_/sg_/ct_ + 8 位 Crockford base32）。
// 「第 3 集」「E01-02」这类编号只是显示，插一集、插一场就会变，不能当键。
import type { EntityKind } from './types.ts';

const stableId = (prefix: string): RegExp => new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{8}$`);

export const KEY_PATTERNS: Readonly<Record<EntityKind, RegExp>> = {
  episode: stableId('ep'),
  character: /^C\d{2,}$/,
  location: /^S\d{2,}$/,
  prop: /^P\d{2,}$/,
  beat: /^B\d{2,}$/,
  script_scene: stableId('sc'),
  segment: stableId('sg'),
  cut: stableId('ct'),
};

export const isValidKey = (kind: EntityKind, key: unknown): key is string =>
  typeof key === 'string' && KEY_PATTERNS[kind].test(key);

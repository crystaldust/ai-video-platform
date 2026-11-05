// 「重跑」按钮的请求：默认沿用之前写好、过了门的集；勾了「整份重写」就要先确认，并带 fresh 让服务端不沿用。
import { STAGE_TITLE } from './reject.ts';
import type { Stage } from './types.ts';

export interface RerunRequest {
  /** 要先确认时的提示语；不用确认是 null */
  readonly confirm: string | null;
  readonly body: { readonly only: Stage; readonly fresh?: true };
}

export function rerunRequest(stage: Stage, fresh: boolean): RerunRequest {
  if (!fresh) return { confirm: null, body: { only: stage } };
  return { confirm: `会把${STAGE_TITLE[stage]}全部集从头重写，不沿用之前已写好、已过门的集。确定？`, body: { only: stage, fresh: true } };
}

const yuanRange = (r: { low: number; high: number }): string => `¥${r.low.toFixed(1)}–${r.high.toFixed(1)}`;

/** 阶段卡上「重跑」的确认语：单阶段重跑是从头重写（不按现有内容改），下游会标需复核；写出这一阶段的估算（人民币）。 */
export function stageRerunConfirm(stage: Stage, cny: { low: number; high: number } | null): string {
  const title = STAGE_TITLE[stage];
  const cost = cny ? `预计 ${yuanRange(cny)}` : '费用算不出来（没有单价或用量）';
  return `重跑${title}阶段：从头重写${title}，不按现有内容改；跑完后下游会标需复核。${cost}。\n\n确定？`;
}

/** 「补提示词」的确认语。 */
export function refsConfirm(): string {
  return '补出图提示词：给出图角色补上出图提示词，不改角色卡正文，外形不变，分镜不会因此需复核。会调一次文本模型，花一点钱。\n\n确定？';
}

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

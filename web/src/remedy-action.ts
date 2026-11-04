// 生成失败提示里的「重跑角色阶段」：先确认（要花 DeepSeek 的钱），再开后台的单阶段重跑。
// 全貌付费条、生成任务页、确认弹窗三处共用。返回给 toast 的话；人取消了返回 null。
import { api, projectPath } from './api.ts';
import type { Remedy } from './generation.ts';

export async function runRemedy(projectId: string, remedy: Remedy): Promise<string | null> {
  if (!window.confirm(remedy.confirm)) return null;
  await api.post(projectPath(projectId, '/go'), remedy.body);
  return `开始${remedy.label}：跑完回生成任务页点「继续生成」`;
}

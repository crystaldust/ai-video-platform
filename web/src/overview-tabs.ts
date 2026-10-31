// 全貌下半部分分成「分集全貌 / 运行记录」两个 tab，免得运行中两块上下叠着、页面拉得很长。
export type OverviewTab = 'episodes' | 'log';

/** picked 是人点过的 tab；没点过（或任务刚开始、刚结束，页面把它清掉了）就跟着有没有任务在跑。 */
export const overviewTab = (picked: OverviewTab | null, running: boolean): OverviewTab => picked ?? (running ? 'log' : 'episodes');

/** 右侧：看运行记录且在跑时是「正在进行」，其余是详情面板（打回、复核都在那里）。 */
export const sidePanel = (tab: OverviewTab, running: boolean): 'current' | 'detail' => (tab === 'log' && running ? 'current' : 'detail');

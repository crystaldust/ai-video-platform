# 实施报告：需复核原因写明变了哪些字段（backlog #38）

## 概要
- **之前：** 原因只写「C01 · 角色 v3 → v4」或「character C01 的角色：v3 → v4」，看不出变了什么。
- **现在：**
  - `findStaleRefs` 比对读取视图时，顺手算出变了的字段，`StaleRef` 新增 `toName`、`changed`、`retired`。
  - 服务端用 `staleReasonText` 统一写成「沈知微 · 角色：外貌、别名（v3 → v4）」，上游删了写「已删除」，超过 3 个字段写「…等 N 项」。
  - 全貌「为什么要复核」读 `PendingItem.targets`，单集详情横条也是同一写法。
- 需复核的判断和 ack 都没变。

## 计划与实际
| 指标 | 计划 | 实际 |
|---|---|---|
| 复杂度 | Medium | Medium |
| 改动文件 | 9 | 13（新建 1 测试；另改了 server.test.ts、e2e 和 backlog） |

## 任务
| # | 任务 | 状态 | 备注 |
|---|---|---|---|
| 1 | reads.ts：FIELD_LABELS、changedFields、entityName | 完成 | |
| 2 | StaleRef 带字段差异（compareRead） | 完成 | |
| 3 | staleReasonText；overview targets；episode 原因 | 完成 | 复核后单集横条也去重 |
| 4 | DetailPanel 用 targets；e2e 断言 | 完成 | |
| 5 | 文档与 backlog | 完成 | |

## 验证
| 项 | 结果 |
|---|---|
| `npm run typecheck` / `npm run web:typecheck` | 0 错误 |
| `npm test` | 419/419 |
| 覆盖率（相关测试） | reads.ts 行 100%、分支 97.5%；lineage.ts 100% |
| `npm run test:e2e` | 2/2 |
| 冒烟副本 `node src/cli.ts stale` | `[]`（和 #34 之后一样，0 条） |

用测试数据实际跑出来的原因：
- `沈知微 · 角色：别名、外貌（v1 → v2）`
- `第 1 集 渡口栈桥 · 剧本：节拍（v1 → v2）`

## 代码复核（ecc:code-reviewer）
结论 APPROVE：0 个严重、0 个高危、2 个中等、3 个低。
- **中等 1：** 单集横条的原因没去重。已改成 `[...new Set(...)]`。
- **中等 2：** targets 按文字去重。两个同名、同阶段、同字段的上游会合成一行。很少见，未改。
- **低：** 字段中文名不全时显示英文键名，这是有意的；子键不带父键名。

## 偏离计划
- **剧本场次的名字（人工测试后用户要求）：** 原计划没有名字的写编号，场次就显示成内部 id `sc_x3xq2c82`。现在改为「第 N 集 场景名」：`findStaleRefs` 用场次的 `sceneId` 查场景卡名字，用所属集查集号，同一次查询内按对象缓存。pen 稿规则同步改了。
- 单集横条加了去重（复核意见）。
- 在 `test/server.test.ts` 补了全貌 targets 和单集横条一致的断言。

## 人工测试
- 用户在本地假模型服务上测了 3 个场景：两个字段、五个字段、删除角色。写法都符合预期。
- 唯一意见是剧本场次显示编号，已改，见「偏离计划」。

## 后续
- [ ] 角色页「大纲里有这个角色，但角色卡里还没有他的卡片」里的「他」宜改成「这个角色」（与 #38 无关）。

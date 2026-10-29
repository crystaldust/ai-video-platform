# Implementation Report: 稳定 id ② — novel-script + novel-staging

## Summary
shuohao-skills（worktree `feat/stable-ids`）完成了以下改动：

**novel-script 3.0.0**
- 集 id 照抄大纲；每场带 `sc_` id，每拍带 `bt_` id。
- `hookBeat` 改为指向节拍 id，全集第几拍按当前顺序现算。
- 爽点认领按 `episodeRef` 对上集 id。
- 新增 `ids` 门（第一道，门数 11）。
- 新增 `ids` / `migrate` 命令。

**novel-staging 3.0.0**
- 每场新增 `sceneRef`，`validate --script` 按 id 查找剧本场次。
- `ep` / `scene` 保留为显示缓存，由 `ids` 门对照剧本检查。
- 新增 `ids` 门（第一道，门数 9）。
- 新增 `migrate --script` 命令。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large |
| Files Changed | 约 22 个 | 25 个（全部为更新） |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 夹具换成 3.0 上游 | [done] | 换完以后两个自测照常通过 |
| 2 | script 自测先行 | [done] | RED 已确认 |
| 3 | script 实现 | [done] | |
| 4 | 迁移 script 样例 | [done] | 改用 `--seed 渡口-script`，见偏差 2 |
| 5 | staging 自测先行 | [done] | RED 已确认 |
| 6 | staging 实现 | [done] | |
| 7 | 迁移 staging 样例 | [done] | 原文件里的 `0.0` / `1.0` 被规范化成 `0` / `1`，见偏差 3 |
| 8 | 文档 | [done] | 共 36 处替换 |
| 9 | 提交 | [done] | b2b3bf3 / a75ec73 |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Unit Tests | [done] Pass | script 154 → 193、staging 99 → 122；其余五个 skill、ids 同步（23）、报告合并（92）全部通过 |
| Integration | [done] Pass | script `checkup`（带上游）11/11，staging `checkup --script` 9/9；两个 skill 的 upstream 夹具与上游样例逐字节一致；合并报告正常 |
| Edge Cases | [done] Pass | 场次 / 节拍 / 集 id 缺失、格式错、跨集重复、不在大纲里、集号不一致；hookBeat 缺失、2.x 写法、悬空、指向别的集、超出窗口；插一拍；sceneRef 缺失、格式错、重复、不在剧本里、编号过期；剧本插一场；两个 migrate 的点名报错 |
| Static / Build | N/A | 纯 .mjs，没有类型检查和构建步骤 |

## Deviations from Plan
1. **站位保留 `scene` 场号作为显示缓存**（规划阶段修正设计文档，已提交 25512cb）。原设计要删掉它，改成按站位文件内的顺序推算。但站位文件可能只覆盖其中几场，推算出来的场号会错。改为和集号同样的做法：保留场号，由 `ids` 门对照剧本检查。
2. **剧本样例的种子改为 `渡口-script`**。用 `渡口` 作种子时，剧本里的节拍 id 与大纲的集 id 后缀相同（`bt_t4vnthc9` 对 `ep_t4vnthc9`）。前缀不同所以不算错误，但读起来容易误以为两者有关联。改种子后，除了照抄过来的集 id，两份样例之间没有后缀相同的 id。
3. **staging 样例的数字规范化**。`JSON.stringify` 会把原文件里的 `0.0` / `1.0` 写成 `0` / `1`，数值不变。如果保留原写法，`--write` 写回的结果就做不到和样例逐字节一致，所以接受这 4 行格式变化。
4. **测试期望值**：staging 现有的报错文案在场次标签后面带一个空格（「第 2 集第 1 场 缺 sceneRef」），测试改为按现有风格断言，代码不改。
5. **测试数据修正**：插入场次时用来生成节拍 id 的写法 `` `bt_0000000${i}`.slice(0, 11) `` 在第 10 拍以后会生成重复的 id，改用 `padStart(8, '0')`。

## Issues Encountered
- 没有新的问题。文档和代码的批量修改都通过那个一次性 Node 替换脚本完成：每处原文必须恰好出现一次，已经改过的跳过。全部 36 处文档替换一次成功。

## Tests Written

| Test File | New | Coverage |
|---|---|---|
| `skills/novel-script/scripts/selftest.mjs` | +39 | ids 门 7 种击穿、hookBeat 4 种情况、爽点按 episodeRef 对账、assignScriptIds（可复现、不改入参、集 id 只能来自大纲）、插一拍、migrateScript（含报错）、CLI |
| `skills/novel-staging/scripts/selftest.mjs` | +23 | seed 的 sceneRef 与前提检查、ids 门 6 种击穿、剧本插一场、migrateStaging（与样例逐字节相同、报错）、CLI |

## Next Steps
- [ ] 计划 ③：novel-storyboard（段 / 切 id、`sceneRef`、`beatIds`、导出按 id 命名）+ 收尾（CHANGELOG 3.0.0、AGENTS.md、夹具一致性检查、storyboard 的 upstream 夹具）
- [ ] 平台改键计划
- [ ] 全部完成后：`v2-final` 标签、推送、PR（等用户确认）

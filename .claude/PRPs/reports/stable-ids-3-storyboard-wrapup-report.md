# Implementation Report: 稳定 id ③ — novel-storyboard 3.0.0 + 收尾

## Summary
shuohao-skills（worktree `feat/stable-ids`）完成了以下改动：

**novel-storyboard 3.0.0**
- 集 id 照抄剧本；段 id 改为 `sg_`，切新增 `ct_` id。
- `sceneRef` 取代 `sceneIndex`；`beatIds` 逐拍列出认领的节拍 id，取代 `beats: [起, 止]`。
- `segment-id` 连号门换成 `ids` 门（第一道），门数仍为 18。
- 覆盖门按节拍 id 序列比对：漏拍、重拍、乱序、认领别场的拍各报各的。
- 导出与 `--frames` 改为 `<段 id>/<切 id>.png`；manifest 每段带 `label`、`order`、`ep`。
- 新增 `ids` 和 `migrate --script` 命令。

**收尾**
- `scripts/fixtures-sync-selftest.mjs`：按各 `upstream/README.md` 的来源清单逐字节比对夹具。
- CHANGELOG 3.0.0。
- AGENTS.md 新增"身份用 id，不用位置"。
- 根 README 的路径示例和自测命令。
- novel-characters 的大纲夹具刷新为 3.0 版。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large |
| Files Changed | 约 25 个 | 21 个（新建 1，更新 20） |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 夹具换成 3.0 上游 | [done] | 换完以后 storyboard 自测仍是 336 项通过（旧代码按集号取，位置没变） |
| 2 | 自测先行 | [done] | RED 已确认（缺导出） |
| 3 | expandScript / 标签 / 查找 | [done] | |
| 4 | ids 门、assign、migrate、validate | [done] | 见偏差 1 |
| 5 | 覆盖、台词、stats、seedance | [done] | 覆盖检查单独抽成 `coverageProblems` |
| 6 | 导出、渲染、seed、CLI | [done] | |
| 7 | 迁移样例 | [done] | 共补 45 个 id；把 git 里的 2.x 原样例重新迁移一次，结果与提交的样例逐字节一致 |
| 8 | 夹具一致性检查 | [done] | 58 项；改动一个字节确认会失败 |
| 9 | 文档 | [done] | 共 47 处替换 |
| 10 | CHANGELOG / AGENTS.md / 提交 | [done] | 531ffe8 / 5e2494e |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static / Build | N/A | 纯 .mjs，没有类型检查和构建步骤 |
| Unit Tests | [done] Pass | storyboard 336 → 406；其余六个 skill 照旧通过；报告合并 92、ids 同步 23、夹具同步 58 |
| Integration | [done] Pass | checkup 带全部上游 18/18；validate 通过；export 产出 `sg_…/` 文件夹，prompt.md 的对照表与 manifest 的 label、order 正确；合并报告的分镜面板显示段标签与段 id，锚点统一加 `storyboard--` 前缀，能正常跳转 |
| Edge Cases | [done] Pass | ids 门 16 种击穿；覆盖门 6 种击穿；剧本插一拍；段重排；2.x 迁移的越界报错；3.0 文件再迁移一次原样不变；剧本缺 id 时 seed 与 migrate 拒绝 |

## Deviations from Plan
1. **`migrateStoryboard` 改为幂等**：自查 diff 时发现，对已经是 3.0 的文件运行 migrate 会报"sceneIndex undefined 找不到"。改为没有 `sceneIndex` 的段、没有 `beats` 的切原样保留，并补一条自测（3.0 文件再迁移一次原样不变）。为此把每段的转换抽成 `migrateSegment`，函数也更短。
2. **报告段卡**：段标签后面附一个小号灰字的段 id（`.sid`）；markdown 版的段头末尾加 `` `sg_…` ``。计划里写了做法，这里记录最终的样子。
3. **`refs` 门**：原来的"集在剧本里不存在 / sceneIndex 不存在"两条移到 ids 门，refs 门只管人物和道具对账，`bad.id` 删除。计划已写明，这里确认已执行。

## Issues Encountered
- GateGuard 拦下 scratchpad 里的 `rm -rf`（删除临时导出目录）。改为导出到新目录，不删除任何文件。
- 做夹具检查的反例验证时，第一次命令因为脚本还没写入（Write 被 GateGuard 拦下）而直接报错；被临时追加空格的夹具已经用备份还原，`git status` 和 `cmp` 都确认无改动。

## Tests Written

| Test File | New | Coverage |
|---|---|---|
| `skills/novel-storyboard/scripts/selftest.mjs` | +70（336 → 406） | expandScript 的 id 与位置、segLabel、ids 门 16 种击穿、覆盖门 6 种击穿、剧本插一拍、段重排、导出路径与 manifest、seed 的 id、assign（不改入参、可复现、集 id 只能来自剧本）、migrate（逐字节一致、幂等、报错）、CLI ids / migrate |
| `scripts/fixtures-sync-selftest.mjs` | 58 | 五个 skill 的上游夹具来源清单与逐字节一致 |

## Next Steps
- [ ] 代码评审（`/ecc:code-review`）
- [ ] 平台（ai-video-platform）改键计划：键改用这些 id，覆盖范围按集 id，更新 duko 夹具
- [ ] 用户确认后：`v2-final` 标签（打在 origin/main 5612d2a）、推送、PR

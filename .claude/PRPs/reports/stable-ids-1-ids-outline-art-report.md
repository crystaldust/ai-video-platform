# Implementation Report: 稳定 id ① — 公共 ids 模块 + novel-outline + novel-art

## Summary
在 shuohao-skills（worktree `~/Development/ai-video/shuohao-skills-stable-ids`，分支 `feat/stable-ids`）完成了以下改动：
- **公共 ids 模块**：五个 skill 各带一份相同的 `ids.mjs`，`scripts/ids-sync-selftest.mjs` 保证五份一致。
- **novel-outline 3.0.0**：
  - 每一集有 `ep_` 集 id，爽点用 `episodeRef` 归属，`episode` 集号作为显示缓存。
  - 新增 `ids` 门（第一道，门数 15）。
  - 新增命令 `ids` / `renumber` / `migrate`。
- **novel-art 3.0.0**：
  - `usage.episodes` 改为记集 id。
  - render 新增 `--outline`，用来显示集号。
  - 新增命令 `migrate --outline`。
  - 合并报告的美术面板改为同时传入大纲。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large |
| Confidence | — | 一次实施到位，没有返工 |
| Files Changed | 约 22 个 | 25 个（新建 6，更新 19） |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | ids.mjs 权威副本 | [done] | |
| 2 | 复制四份副本 | [done] | |
| 3 | ids-sync-selftest | [done] | 23 项 |
| 4 | outline 自测先行 | [done] | RED 已确认（缺导出） |
| 5 | outline 实现 | [done] | 追加：`episodeRef` 紧跟在 `episode` 后面，样例 diff 更好读 |
| 6 | 迁移 outline 样例 | [done] | `--seed 渡口`；diff 只多 10 行 |
| 7 | art 自测先行 | [done] | RED 已确认 |
| 8 | art 实现 | [done] | |
| 9 | 迁移 art 样例 | [done] | diff 只涉及 `usage.episodes` |
| 10 | 文档 | [done] | |
| 11 | 提交 | [done] | b020747 / 021cd74 / 64c4e4a |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | N/A | 仓库没有类型检查和 lint（纯 .mjs）；`node -e import` 加载正常 |
| Unit Tests | [done] Pass | outline 249 → 287、art 151 → 168、ids 同步 23；其余五个 skill 原样通过 |
| Build | N/A | 无构建步骤 |
| Integration | [done] Pass | 报告合并自测 92 项通过；合并报告里美术出现集显示集号（出现 4 处） |
| Edge Cases | [done] Pass | 缺 id、格式错、重复、悬空、集号与归属不一致、插入一集、beats 档、幂等、2.x 迁移 |

## Files Changed（shuohao-skills）

| File | Action |
|---|---|
| `skills/{novel-outline,novel-art,novel-script,novel-staging,novel-storyboard}/scripts/ids.mjs` | CREATED（×5，内容相同） |
| `scripts/ids-sync-selftest.mjs` | CREATED |
| `skills/novel-outline/scripts/novel-outline.mjs` | UPDATED |
| `skills/novel-outline/scripts/selftest.mjs` | UPDATED |
| `skills/novel-outline/examples/渡口-outline.json` | UPDATED |
| `skills/novel-outline/{SKILL.md,README.md,README.en.md,references/schema.md,references/episode-pass.md}` | UPDATED |
| `skills/novel-art/scripts/{novel-art.mjs,selftest.mjs}` | UPDATED |
| `skills/novel-art/examples/渡口-art.json`、`references/test-fixtures/upstream/渡口-outline.json` | UPDATED |
| `skills/novel-art/{SKILL.md,README.md,README.en.md,references/schema.md}` | UPDATED |
| `scripts/report.mjs` | UPDATED |
| `README.md`、`README.zh.md` | UPDATED（大纲门数 14 → 15） |

## Deviations from Plan
1. **`scripts/report.mjs`**：美术面板的 `needs` 加上 `--outline`。计划里没有列出这一处，是实施时发现的：不加的话，合并报告里的出现集只会显示「N 集」。
2. **根目录 README / README.zh 的大纲门数**：计划原定在 ③ 收尾时更新，这次提前改了。它是事实性数字，分开改容易出现前后不一致。
3. **`episodeRef` 的位置**：插在 `episode` 后面，而不是追加在对象末尾。计划里没写这一点，为了让样例 diff 更好读而加。

## Issues Encountered
- 第一次 perl 批量替换时，替换文字里的 `/` 与分隔符冲突，脚本在第二个文件上报错，但第一个文件（outline SKILL.md）已经改好了。之后改用一个 Node 一次性替换脚本：每处替换要求原文恰好出现一次，已经改过的地方跳过。最终没有重复修改，也没有漏改。
- zsh 不会把 `$G` 拆成多个参数，第一次提交命令失败。当时只暂存了文件，没有产生提交；改成写出完整命令后重新执行。

## Tests Written

| Test File | New | Coverage |
|---|---|---|
| `scripts/ids-sync-selftest.mjs` | 23 | 副本一致、格式、撞号、种子、assignIds 不改入参、collectIds、duplicateIds |
| `skills/novel-outline/scripts/selftest.mjs` | +38 | ids 门 6 种击穿、beats 档、assign 可复现、插入一集与 renumber、CLI ids/migrate/renumber 幂等 |
| `skills/novel-art/scripts/selftest.mjs` | +17 | seed 记集 id、拒绝 2.x 大纲、validate、render 有无大纲、migrate、CLI |

## Next Steps
- [ ] 计划 ②：novel-script（场次 / 节拍 id、hookBeat）+ novel-staging（`sceneRef`）
- [ ] 计划 ③：novel-storyboard + 收尾（CHANGELOG 3.0.0、AGENTS.md、夹具一致性检查）
- [ ] 之后：平台（ai-video-platform）改键计划
- [ ] 全部完成后：`v2-final` 标签、推送、PR（等用户确认）

# Implementation Report: 平台改键（3.0 稳定 id）

## Summary
集、剧本场次、分镜段、分镜切四类对象的键改为上游 skill 3.0 的稳定 id（`ep_/sc_/sg_/ct_`）；按集负责的退役改按集 id 判断；对象版本新增所属集（迁移 v2）；duko 夹具换成 3.0 样例。插一集、插一场之后，原有对象的键和版本都不再漂移。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Files Changed | 约 15 | 22（含 5 份夹具、1 个新测试文件） |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 键正则改为稳定 id，删除按位置推算键的函数 | done | `src/domain/keys.ts` |
| 2 | 迁移 v2：`entity_version.episode_key` | done | `src/db/schema-v2.ts` |
| 3 | 仓储写入 / 读出所属集；`sceneEpisodeIndex` | done | 内容相同但集变了也算新版本；退役版本沿用原来的集 |
| 4 | 覆盖范围按集 id；投影上下文加场次 → 集 | done | `import-artifact.ts` |
| 5 | outline / script / staging / storyboard 投影按 id 定键、按 id 引用 | done | payload 不再塞推算出的位置（`ep`、`index`） |
| 6 | 夹具换成 3.0 样例，测试改用样例 id | done | id 集中在 `test/helpers.ts` 的 `DUKO` |
| 7 | 回归测试：插集、插场、按集 id 退役、站位前置、跨集段 | done | `test/stable-ids.test.ts` |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc -p .` 零错误 |
| Unit / Integration | Pass | 96 个测试（原 91：删 5 个推算键测试，新增 10 个） |
| Coverage | Pass | 行 99.32% / 分支 94.59% / 函数 99.34% |
| 变异验证 | Pass | 6 处关键判断逐一改坏，测试都失败：退役不看集、复用不看集、不查跨集段、站位不查剧本、退役不带集、场次 payload 带位置 |

## 行为变化

- 爽点按 `episodeRef` 指向集；`episode`（集号）不再参与对账。
- 站位场次按 `sceneRef` 对上剧本；所属集从库里剧本侧面查，**必须先导入剧本**，否则整体拒绝并提示。
- 分镜段按 `sceneRef` 指向剧本场次；场次属于别的集时整体拒绝。
- 缺 id 的 2.x 产物导入时逐条报问题，并提示先运行对应 skill 的 `ids --write`（或按上游 CHANGELOG 迁移）。
- 集的显示名（「第3集」）仍取大纲集号，插集后跟着更新；它只用于显示，不进版本。

## Deviations from Plan
- 剧本集侧面的 payload 保留了文档里的 `ep`：它是上游文档本身的内容，不是平台推算的。插集时这些集侧面会长出新版本，但同一次导入里引用它们的场次会一起复核，下游（站位、分镜）引用的是场次，不受影响——插集测试验证了没有过期。

## Issues Encountered
- 旧格式（v1）项目库里的 `E01-SC01` 这类键不做迁移：Phase 1 还没有真实项目。用旧库导入 3.0 产物会留下旧键孤儿对象，重建项目即可。

## Next Steps
- [ ] 设计稿：补画不依赖 Phase 5–7 的页面

# Implementation Report: 一键编排、打回重跑与「需复核」（PRD Phase 4a）

## Summary
在 Phase 2 执行器之上做了编排：
- **`go` 一键跑**：按依赖图分层跑完六个文本阶段，同层并发。某阶段没过，只阻断依赖它的下游。文本层结束后估一次费用，生成付费确认单，停在付费阶段之前。中断后再 `go` 会从断的地方接着跑：没产物的从头跑，需复核的只改受影响的集，其余跳过。
- **四个专用配方**：角色、美术、站位、分镜各补了一个专用配方，替换原来的 single-pass。
- **staging-carry 平台门**：分镜每场第一段的 blocking 必须照抄站位的开场走位句。PRD 指出的「站位 → 分镜」断点就此补上。
- **打回**：`reject` 带意见在当前版本上重跑。剧本、站位、分镜可以只打回一集，其他集不受影响。
- **需复核矩阵**：按阶段 × 集列出受影响的格子，可以用 `review --keep` 确认保持，也可以用 `go --only-stale` 重跑消除。
- **数据**：迁移 v5，新增编排、打回意见、复核确认、付费确认单四张表，`node_run` 增三列。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | XL（拆为 4a/4b） | XL：源码新建 14、修改 13；测试新建 10、修改 6 |
| Confidence | — | 测试全过；真实模型两轮手工验证通过 |
| Files Changed | 新建 ~12、修改 ~6 | 源码 + 文档：新建 15、修改 13（另有测试夹具：四个 skill 的副本、渡口原文） |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 迁移 v5 与仓储 | [done] Complete | 打回意见、复核确认的读写放在 `repo/revisions.ts`；`orchestration` 加了 `pid` 列 |
| 2 | 依赖图 | [done] Complete | `layers`、`downstreamOf`、环检测 |
| 3 | 四个专用配方 + staging-carry 门 | [done] Complete | 配方共用部分拆到 `recipe-kit.ts`，四个专用配方在 `stage-recipes.ts` |
| 4 | 编排器 | [done] Complete | 并发池、阻断传播、断点续跑、付费确认单 |
| 5 | 需复核矩阵与复核确认 | [done] Complete | `StaleRef.from` 增加所属集 |
| 6 | 打回与单集重跑 | [done] Complete | 集号、集 id 都能认，集号按当前大纲认 |
| 7 | CLI | [done] Complete | `go` / `reject` / `review` / `matrix` / `gates`；新增不带取值的开关 `--only-stale`、`--keep` |
| 8 | 文档 | [done] Complete | 新增 `docs/orchestration.md`，更新 `docs/node-protocol.md` 的配方表 |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | [done] Pass | `pnpm typecheck` 零错误（项目没有 lint） |
| Unit Tests | [done] Pass | 196 个全部通过（原 158 个），新增 38 个 |
| Coverage | [done] Pass | 行 98.7% / 分支 87.1% / 函数 97.7%（门槛 80 / 70 / 80） |
| Build | N/A | Node 直接跑 TS，没有构建步骤 |
| Integration | [done] Pass | CLI 冒烟（命令行模型按内容作答）：`go` → `matrix` → `gates` → `reject --ep` → `review` |
| Manual（真实模型） | [done] Pass | 见下 |

### 真实模型手工验证（DeepSeek Flash，《渡口》2 集 × 60 秒，`projects/渡口-phase4a-验证`）

**第一轮：`go` 一键跑。**

- 六个阶段全部通过，用时 788 秒，停在付费前生成确认单 #1，预估 $5.53–6.43（budget 预设）。
- 角色、美术、剧本三个阶段的模型调用在记录里交错出现，确实是并发跑的。
- 分镜第 1–2 集那一批撞上输出上限：用了 32768 tokens，其中推理 24092。批次自动拆成单集重写，后面又修复了一轮。
- 剧本修复了一轮。
- 上游 `checkup` 复查：大纲、剧本、美术、站位、分镜全部通过。
- 本轮实际费用 $0.31。

**第二轮：打回 → 矩阵 → `--only-stale`。**

- `reject script --ep 2 --note …` 通过。
- 矩阵只出现第 2 集的两格：站位 1 处过期，分镜 4 处过期。
- `go --only-stale` 只重跑了这两格（都只跑第 2 集），跑完矩阵清空，并生成确认单 #2，旧单作废。
- 第 1 集的剧本、站位、分镜仍是 v1，没有长新版本。
- 两轮累计费用 $0.36。

全程只用 CLI 命令，没有靠对话推进。

## Files Changed

| File | Action |
|---|---|
| `src/db/schema-v5.ts` | CREATED |
| `src/db/migrations.ts` | UPDATED |
| `src/repo/orchestrations.ts`、`src/repo/paid-gates.ts`、`src/repo/revisions.ts` | CREATED |
| `src/repo/runs.ts` | UPDATED（新列；导出 `isAlive`） |
| `src/repo/lineage.ts` | UPDATED（`StaleRef.from.episode`） |
| `src/orchestrate/deps.ts`、`orchestrator.ts`、`review-matrix.ts`、`revisions.ts` | CREATED |
| `src/executor/recipe-kit.ts` | CREATED（从 recipes.ts 拆出类型与工具，新增 `allChecks`、`episodeNumbers` 等） |
| `src/executor/stage-recipes.ts` | CREATED（novel-characters / art / staging / storyboard） |
| `src/executor/gates/staging-carry.ts` | CREATED |
| `src/executor/scoped.ts` | CREATED（把单集结果并回整份文档） |
| `src/executor/recipes.ts` | UPDATED（打回的底稿、只跑几集；注册新配方） |
| `src/executor/run-node.ts` | UPDATED（只跑几集、在当前版本上改、`runMounted`、整份复查只提示） |
| `src/executor/prompt.ts` | UPDATED（【作者意见】【底稿】和额外段落） |
| `src/import/import-artifact.ts` | UPDATED（`artifactDoc` 选项） |
| `src/cli-orchestrate.ts` | CREATED |
| `src/cli.ts`、`src/cli-shared.ts`、`src/cli-nodes.ts` | UPDATED |
| `packs/novel.pack.json` | UPDATED（四个阶段换成专用配方） |
| `docs/orchestration.md` | CREATED |
| `docs/node-protocol.md` | UPDATED |
| `test/fixtures/skills/novel-{characters,art,staging,storyboard}/` | CREATED（上游 `9dd7129` 副本） |
| `test/fixtures/duko/渡口.txt` | CREATED（上游样例原文） |
| `test/fixtures/skills/UPSTREAM.md` | UPDATED |

## Deviations from Plan

1. **单集重跑的导入方式**
   - 改了什么：计划只写了「构造只含这一集的文档导入」。实际导入时只对这一集负责，但存进产物版本库的是并回后的整份文档（新增 `importArtifact` 的 `artifactDoc` 选项和 `executor/scoped.ts`）。
   - 原因：下游用最新产物当上游。如果最新版只有一集，下游就只看得到这一集。
2. **上游变了的重跑也在当前版本上改**
   - 改了什么：`go` 和 `--only-stale` 遇到需复核的格子时，以当前版本为底稿，附上「上游有改动：按新的上游修改这一版，没受影响的内容保持不变」。
   - 原因：计划没规定这种情况。从空白重写会让没受影响的内容也变掉，下游跟着连锁需复核。
3. **站位单集重跑沿用已有认图**
   - 改了什么：只重跑几集时，已经认过图的地点不再交给模型重认。
   - 原因：认图是跨集共用的，重认一次会让其他集的站位都需复核。
4. **新确认单生成时作废之前在等确认的旧单**
   - 原因：旧单里的估算已经过时，留着容易被误确认。
5. **`--only <stage>` 一律从头重跑**
   - 改了什么：不带底稿。
   - 原因：用户点名要重跑，要的是重新生成。
6. **上游已经没有的集不重跑**
   - 改了什么：需复核格子所在的集已经不在上游里时，`go` 不重跑它，在汇总里说明，格子留在矩阵里等人用 `review --keep` 确认。
   - 原因：按集重跑必然失败。整阶段重跑也清不掉这一格：按集负责的导入不会退役文档里没出现的集，结果每次 `go` 都会重跑一遍。
7. **角色卡的名单以大纲为准**
   - 改了什么：配方给大纲里的每个角色都出一张卡，测试样例补了大纲独有的原创角色 C05（更夫）。
   - 原因：上游 SKILL.md 规定有大纲就以它定名单。
8. **staging 没有 `ids` 命令**
   - 改了什么：计划写了「`ids`（若有）」，实际的上游站位脚本没有这个命令，站位配方就不跑。
   - 原因：站位不分配新 id，只引用剧本的场次 id。

## Issues Encountered

代码审查代理报了 2 个 HIGH、2 个 MEDIUM、4 个 LOW。

**已修复：**

- **HIGH，多集重跑顺序乱**：矩阵按集 id 排序，集 id 是随机的。一次重跑几集时，分批可能拼出倒着的区间。现在执行器统一按上游的集顺序排好再分批，并补了乱序的回归测试。
- **HIGH，上游删掉一集后反复失败**：这样的格子每次 `go` 都会失败，并阻断下游。处理方式见偏差 6，补了测试。
- **MEDIUM，同层一个阶段出错打断其他阶段**：解析模型、做计划、进度回调里任何一步出错，原来会冒出去打断同层还在跑的阶段，留下没有编排认领的运行。现在只算这一个阶段失败，进度回调出错也不影响编排。补了测试。
- **LOW，`--only` 带着「上游有改动」**：改法见偏差 5。

**记下、没有改：**

- **MEDIUM，同层看不到彼此的可选上游**：首次 `go` 时，剧本拿不到同层的美术，美术也拿不到同层的角色卡，它们的 validate 也就少对账这一项。这是计划里定的取舍：分层只看硬依赖，换来并发。
- **LOW，打回失败后 `go` 不补跑**：打回的运行转人工或失败后，`go` 不会自动补跑，因为产物没变、也没有需复核的格子。要在汇总里提示「有没落实的打回」，留到 4b 全貌界面来做。
- **LOW，站位并回按集号认场次**：集号整体移位、但那几场本身没有标需复核时，有极小概率删错场次。
- **LOW，打回运行没开起来时留下孤儿记录**：比如阶段正忙时打回，会留下一条没有运行对应的打回意见。这条记录无害，但能看到。

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `test/orchestration-repo.test.ts` | 4 | 编排锁、中断收尾、确认单作废、打回与复核确认的读写 |
| `test/migrations.test.ts` | +1 | v5 的表、列与约束 |
| `test/deps.test.ts` | 4 | 分层、部分阶段、下游、环检测 |
| `test/stage-recipes.test.ts` | 11 | 四个配方各自通过或修复、站位单集重跑（意见、底稿、沿用认图、只动这一集）、乱序多集、整份负责的阶段拒绝、staging-carry 的解析与判定、并回整份 |
| `test/orchestrate.test.ts` | 9 | 一键全过（分层并发、确认单含视频秒数）、转人工、阻断传播、断点续跑、并发锁、没有输入、没挂载、`--only`、上游删集、模型解析出错 |
| `test/review-matrix.test.ts` | 4 | 按集聚合、跨集共用部分归到集为空的格子、确认后消失、上游再改又出现 |
| `test/revisions.test.ts` | 4 | 集号与集 id、打回单集到 only-stale 清空、拒绝条件、整阶段打回 |
| `test/cli.test.ts` | +1 | 编排命令冒烟 |
| `test/support/duko-model.ts` 等 | — | 按提示词作答的测试模型（并发安全）与命令行版 |

## Next Steps
- [ ] Phase 4b：全貌界面（基于 `reviewMatrix` 和运行、编排、确认单数据）
- [ ] 提交并开 PR（`/prp-pr`）

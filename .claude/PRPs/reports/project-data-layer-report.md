# Implementation Report: 项目数据层（Phase 1）

## Summary
实现了每个项目一个 SQLite 文件的数据底座：
- 稳定 ID（`E01`、`E01-SC01`、`E01-01`、`E01-01.c1`、沿用的 C/S/P/B 编号）。
- 按侧面只追加的版本，以及按内容哈希去重。
- 钉版本的引用，过期在查询时现算；上游删掉的对象自动退役。
- 6 种 novel-* 产物的纯函数投影与事务化导入。
- 内容寻址的素材库与核验。
- 生成任务、候选、审阅、选用、剪辑的预留表，以及验证 082 案例的场景测试。
- 用于手工验证的 CLI。
- 运行时零依赖：Node 25 直接运行 `.ts`，存储用 `node:sqlite`。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large |
| Confidence | 8/10 | 计划内的部分一次通过；代码审查发现了 3 个 HIGH 设计缺口，见下文 |
| Files Changed | 约 36 个 | 新建 44 个（src 21、test 13、fixture 6、配置 4）；更新 PRD 1 个 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 工程脚手架 | [done] | 另外生成了 `pnpm-lock.yaml` |
| 2 | 渡口样例 + 测试工具 | [done] | |
| 3 | 领域类型、键、哈希 | [done] | 另加 `src/domain/clock.ts`（统一时间戳） |
| 4 | 连接与迁移 | [done] | 偏差：`withTransaction` 单独放在 `src/db/transaction.ts`，避免 connection ↔ migrations 循环导入 |
| 5 | 项目创建与打开 | [done] | 审查后补上了建库失败时的清理 |
| 6 | 产物与对象仓储 | [done] | 审查后增加退役版本、按权威来源决定显示名、重名检测 |
| 7 | 6 个投影 | [done] | 审查后增加覆盖范围 `covers` |
| 8 | 事务化导入 | [done] | 审查后改为"重新导入即复核"，并增加退役逻辑；计划里的 `import-all.test.ts` 合并进了 `import.test.ts` |
| 9 | 追溯与过期 | [done] | 改走 `live_ref` 视图；深度相同的路径固定取同一条 |
| 10 | 素材库 | [done] | 审查后改为"先拷到临时文件、对拷贝算哈希、再改名就位" |
| 11 | 082 场景测试 | [done] | |
| 12 | CLI | [done] | |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | [done] Pass | `tsc -p .` 零错误；项目没有配置 lint（计划里也没有） |
| Unit Tests | [done] Pass | 88 个测试全部通过 |
| Coverage | [done] Pass | 行 99.31%、分支 95.54%、函数 99.34%（门槛 80/70/80） |
| Build | N/A | 无构建步骤，Node 直接运行 `.ts` |
| Integration | [done] Pass | CLI 冒烟测试；新建 scratch 项目全量导入后 `user_version=1`、`foreign_key_check` 为空、`integrity_check` 为 ok、73 个对象、`stale` 为空 |
| Edge Cases | [done] Pass | 非对象输入、键格式、引用缺失时回滚、文档缩短、分批导入、素材并发、篡改、丢失、路径越界、建库失败 |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `package.json` / `tsconfig.json` / `.gitignore` / `pnpm-lock.yaml` | CREATED | 配置 |
| `src/domain/{types,keys,hash,clock}.ts` | CREATED | 约 160 |
| `src/db/{connection,migrations,schema-v1,transaction}.ts` | CREATED | 约 230 |
| `src/repo/{artifacts,entities,lineage,media}.ts` | CREATED | 约 520 |
| `src/import/{projection,import-artifact}.ts` + `projections/*.ts`（7 个） | CREATED | 约 560 |
| `src/project.ts` / `src/cli.ts` | CREATED | 约 215 |
| `test/*.ts`（13 个） | CREATED | 约 1150 |
| `test/fixtures/duko/渡口-*.json`（6 个） | CREATED | 原样复制自 skill examples |
| `.claude/PRPs/prds/ai-short-drama-platform.prd.md` | UPDATED | Phase 1 状态与链接 |

## Deviations from Plan

1. **`withTransaction` 放在独立文件** `src/db/transaction.ts`。原因：计划把它放在 `connection.ts`，而 `connection` 要导入 `migrations`，`migrations` 又要用事务，会形成循环导入。
2. **新增 `src/domain/clock.ts`**。原因：时间戳在 4 处使用，按 DRY 抽出。
3. **表结构 v1 直接修改**（加了 `entity_version.retired`、`live_ref` 视图、`ref_from` 索引），没有新增迁移。原因：v1 还没有发布，也没有任何现存的库。
4. **引用语义从"只为新版本写引用"改为"重新导入即复核"**：产物里每个对象的引用都按目标的当前版本重新钉一次，`live_ref` 只认最新钉住的版本。原因：审查 H1，见下文。由此带来的变化：计划 Task 9 预期 4 条过期引用，实际是 3 条。S03 的 variant-of 和 S02 在同一份 art 里，会随这次导入一起复核，不再算过期。
5. **新增退役机制**（`Projection.covers` + `retireMissing`）。原因：审查 H2。剧本、站位、分镜只对文档里出现的集负责，以支持分批写作。站位里的地点认图结果跨集共用，不会退役。
6. **`ProjectionContext` 增加 `ambiguousNames`**，`characterKeyIndex` 改为返回 `{ byName, ambiguous }`。原因：审查 L6，重名时宁可拒绝也不对错人。
7. **显示名**：只有大纲能覆盖已有的 title，其他来源只能补空名。原因：审查 L1，避免显示名随导入顺序来回翻。

## Issues Encountered

**代码审查**（ecc:typescript-reviewer）结果：0 CRITICAL、3 HIGH、7 MEDIUM、6 LOW。处理如下：

| # | 问题 | 处理 |
|---|---|---|
| H1 | 复用的旧版本永远不会重钉引用，过期清不掉，同一份文档还会对自己报过期 | 已修：改为"重新导入即复核"，加 `live_ref` 视图；新增 3 个测试 |
| H2 | 产物里删掉的对象一直算作当前版本 | 已修：退役版本 + 覆盖范围；新增 5 个测试（含分批导入不误伤其他集） |
| H3 | `createProject` 中途失败时泄漏连接并留下半成品库 | 已修：关闭连接并删除库文件；新增测试（用只读目录真实触发失败） |
| M1 | 两个进程同时打开新库时迁移有竞争 | 已修：在写锁内重读版本号；`busy_timeout` 移到最前 |
| M2 | ROLLBACK 可能盖掉真正的错误 | 已修：先检查 `db.isTransaction` |
| M3 | 素材并发入库、哈希与拷贝不一致、信任残缺旧文件 | 已修：临时文件 → 对拷贝算哈希 → 改名就位；UNIQUE 冲突时改为读取已有行；文件丢失时补回；新增 3 个测试 |
| M4 | `verifyMedia` 无限并发 | 已修：改为顺序执行 |
| M5 | `rel_path` 越出项目目录 | 已修：做包含检查，越界的按不一致报出；新增测试 |
| M6 | 原样重新导入补不回之前缺的可选引用 | 随 H1 一起修好；新增测试 |
| M7 | 过期查询在大数据量下慢；深度相同时 role 不确定 | role 已改为确定性选择；**性能未处理**，60 集规模到 Phase 4 实测后再定 |
| L1 | 显示名随导入顺序翻转 | 已修 |
| L2 | 引用计数把被忽略的重复也算进去 | 已修：`insertRef` 返回是否真的写入 |
| L3 | `canonicalJson` 不适用于非 JSON 值 | 已补注释 |
| L4 | `process.exit` 可能截断管道输出 | 已修：改用 `process.exitCode` |
| L5 | 库函数层没有校验 stage | 已修；新增测试 |
| L6 | 重名人物会被静默覆盖 | 已修；新增 2 个测试 |
| — | CLI 读坏 JSON 时报错不带路径 | 已修；新增断言 |

另外：
- 我误执行了一次 `git add -N .`，随即用 `git reset` 撤销，暂存区恢复为用户原来的状态。
- 我写的第一个"建库失败"测试其实没有触发清理分支（被前面的路径检查拦下），是覆盖率报告暴露出来的，已改成真实触发失败的版本。

## Known Limitations（需要决策）

- **按位置定的键会随插入而漂移**。上游 skill 的剧本场次和分镜没有 id，平台按"第几场 / 第几切"定键。在中间插入一场，后面所有场次的键都会后移，它们的历史会挂到别的内容上。退役机制只能处理删除，处理不了插入。根治办法是让 skill 输出稳定 id（比如 script 的 `scenes[].id`），这需要改上游 skill，建议在 Phase 2（节点协议）一并决定。
- 站位里的地点认图结果不会退役：一个地点从所有站位里消失后，它的 staging 侧面仍然有效。
- "重新导入即复核"意味着下游原样重新导入就会清掉过期标记。这是有意的语义（人确认过仍然成立），但误操作也会清掉。将来 UI 应该把"复核"做成显式动作。

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `test/keys.test.ts` | 6 | 键生成、校验 |
| `test/hash.test.ts` | 6 | 规范化 JSON 与指纹 |
| `test/migrations.test.ts` | 5 | 迁移、外键、JSON 校验、库版本过新、回滚 |
| `test/project.test.ts` | 5 | 创建、打开、建库失败时的清理 |
| `test/entities.test.ts` | 7 | 版本、侧面、显示名、引用、人名索引、退役 |
| `test/projections.test.ts` | 18 | 6 个投影的样例数量与全部拦截规则 |
| `test/import.test.ts` | 18 | 全量导入、幂等、新版本、回滚、退役、分批导入、复核 |
| `test/lineage.test.ts` | 11 | 追溯、深度、侧面、旧版本可见、过期与复核 |
| `test/media.test.ts` | 9 | 去重、并发、补回丢失文件、残缺旧文件、篡改、越界 |
| `test/scenario-082.test.ts` | 2 | 三态 + 剪辑版本 + 防重复付费 |
| `test/cli.test.ts` | 3 | 端到端冒烟与参数错误 |

## Next Steps
- [ ] 决定上面的"按位置定的键"问题（建议在 Phase 2 计划里处理）
- [ ] 提交：`/prp-commit`（当前分支 `feat/project-data-layer`；`main` 还没有任何提交）
- [ ] 下一阶段：`/prp-plan .claude/PRPs/prds/ai-short-drama-platform.prd.md`（Phase 2 与 Phase 3 可以并行）

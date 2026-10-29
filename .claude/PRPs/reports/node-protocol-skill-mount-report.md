# Implementation Report: 节点协议与 skill 挂载（PRD Phase 2）

## Summary
skill 包清单与注册（读 SKILL.md 的名称版本、记哈希、探测脚本能力、按主版本把关）、阶段挂载；项目输入；文本模型接口与命令行模型；执行器按配方跑节点：调模型 → 补 id → 跑 skill 的 validate → 平台门（投影干跑）→ 不过就带违规原文修复、用尽转人工 → 通过后自动入库；每次模型调用的完整提示词、输出、违规、用量都落库。配方：novel-outline（骨架 → 分批分集）、novel-script（按批 seed → 写 → 合并）、single-pass（通用，只有提示词的 skill 也能跑）。CLI：`pack register` / `mount` / `input` / `run` / `runs` / `import --run`。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large |
| Files Changed | 新建 ~16，修改 ~4 | 源码新建 15、修改 5；测试新建 5、修改 2；夹具 15（上游副本） |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 迁移 v3 与 project_input | done | |
| 2 | frontmatter 与清单校验 | done | |
| 3 | 脚本执行与能力探测 | done | 能力多探测了 `blocking`（Phase 4 的 staging → storyboard 衔接要用） |
| 4 | 包注册与挂载 | done | |
| 5 | 模型接口与命令行模型 | done | |
| 6 | 输出解析与提示词装配 | done | |
| 7 | 配方 | done | 偏离：配方写成 async 函数而不是步骤数组（见下） |
| 8 | 执行器主循环 | done | 偏离：`node_run` 增加 `pid`（见下） |
| 9 | CLI | done | 节点命令放在新文件 `src/cli-nodes.ts`，`cli.ts` 只分发 |
| 10 | 测试夹具 | done | 上游 novel-outline、novel-script 副本 + prompt-only 假 skill，来源见 `test/fixtures/skills/UPSTREAM.md` |
| 11 | 文档 | done | `docs/node-protocol.md` |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc -p .` 零错误 |
| Unit + Integration | Pass | 125 个测试（原 96，新增 29） |
| Coverage | Pass | 全部文件 行 98.2% / 分支 88.6% / 函数 95.8% |
| Build | N/A | 无构建步骤（Node 直接跑 TS） |
| 变异验证 | Pass | 7 处关键判断逐一改坏，补测试后全部被抓到：修复不设上限、跳过平台门、不查并发、不查版本、不查越界路径、不记跳过的拍板、任意运行可结案 |
| 真实模型验证 | Pass | 2026-10-29，DeepSeek `deepseek-flash`，见下节「真实模型验证」 |

## Files Changed

| File | Action |
|---|---|
| `src/db/schema-v3.ts`、`src/db/migrations.ts` | CREATED / UPDATED |
| `src/repo/inputs.ts`、`src/repo/skills.ts`、`src/repo/runs.ts` | CREATED |
| `src/repo/artifacts.ts` | UPDATED（`latestArtifactDoc`） |
| `src/import/import-artifact.ts` | UPDATED（返回 `artifactId`） |
| `src/skills/frontmatter.ts`、`src/skills/manifest.ts`、`src/skills/script-runner.ts` | CREATED |
| `src/model/text-model.ts`、`src/model/command-model.ts` | CREATED |
| `src/executor/json-output.ts`、`prompt.ts`、`recipes.ts`、`run-node.ts` | CREATED |
| `src/cli-nodes.ts` | CREATED |
| `src/cli.ts`、`src/project.ts` | UPDATED |
| `packs/novel.pack.json` | CREATED |
| `docs/node-protocol.md` | CREATED |
| `test/node-protocol.test.ts`、`test/executor.test.ts`、`test/support/*` | CREATED |
| `test/cli.test.ts`、`test/migrations.test.ts` | UPDATED |
| `test/fixtures/skills/**` | CREATED |

## Deviations from Plan
1. **配方是 async 函数，不是步骤数组**。大纲（骨架 → 拍板 → 分批分集）和剧本（按批 seed → 写 → 合并）都有分支与循环，用步骤数组得再造一层小 DSL；函数加上执行器提供的 `ask` / `gate` / `runSkill` / `check` 上下文更直接，测试同样容易。
2. **`node_run` 增加 `pid` 列**。计划写的是「启动时把 running 的运行标 failed」，这会误伤另一个进程里正在跑的运行；改为只收尾原进程已不在的运行，同时用它实现「同一阶段有活着的运行就拒绝再开」。
3. **人工结案在 CLI 层做**（`import --run`），没有把 `runId` 塞进 `importArtifact`；导入前先 `assertResolvable`，避免「导进去了却结不了案」。`importArtifact` 只多返回一个 `artifactId`。
4. **能力探测多了 `blocking`**，为 Phase 4 补 staging → storyboard 衔接预留。

## Issues Encountered
- 无阻塞问题。所有执行器集成测试第一次运行即通过；变异验证发现「任意状态的运行都能结案」没被测到，已补测试。

## 真实模型验证（Phase 2 success signal）

- 环境：本分支代码；skill 包 `crystaldust/shuohao-skills@9dd7129`（7 个 skill 全部注册、6 个文本阶段挂载）；输入《渡口》原文 812 字，6 集 × 60 秒，题材悬疑；模型 `deepseek-flash`，经 `--model-cmd` 接一个临时的命令行包装（读 `~/.config/ai-video-platform/deepseek.key`，不进仓库）
- **outline**（run 1）：passed。骨架 1 次输出被截断后重问通过 → `validate --stage beats` ✓ → 6 集一批写完 → 补 id → `validate` ✓ → 平台门 ✓；skill `checkup` 全部通过；跳过的人工拍板 1 处已记录
- **script**（run 3）：passed。1–3、4–6 两批写完 → 补 id → `validate` 两轮修复后 ✓ → 平台门 ✓；skill `checkup --outline` 全部通过（没有美术产物，对账美术一项跳过）
- 用量：10 次调用（含失败尝试），输入 102,411 tokens（缓存命中 63,872）、输出 111,829（其中推理 46,013）；按第三方参考价约 $0.17
- 验证中发现并修复：`SKILL.md` 的版本写在 `metadata.version`（novel-characters、character-refs）时注册失败 → frontmatter 解析支持 `metadata` 块，顶层优先，补测试
- 验证中发现、留给 Phase 3：推理模型的推理 token 计入 `max_tokens`，上限不够时正文为空、`finish_reason: length`，执行器只能看到「没找到 JSON」并原样重试（run 2 因此转人工，提高上限后 run 3 通过）。改法已写进 `model-adapters-presets-cost.plan.md`「截断要单独处理」

## Code Review 修复（10 条全部修复）

| # | 问题 | 修复 | 回归测试 |
|---|---|---|---|
| 1 | 平台门修复可能改坏内容，却不重跑 skill 的 validate | 平台门同时复查配方最后一道 skill 门 | 假 skill `gated-storyboard`：修复引入 `bad` 后被拦 |
| 2 | 平台门修复不补 id | 平台门修复后照样跑配方的 post（ids） | 同上：修复后自动盖章，不多问一轮 |
| 3 | 一个脚本探测失败拖垮整包注册 | 探测异常只记该 skill 的问题 | 假 skill `hangs` 超时，其余照常注册 |
| 4 | 建运行记录后出错会卡在 running | 建记录后全部步骤在 try 内；本进程按「执行名单」认残留 | 进度回调抛错 → failed，马上能再跑 |
| 5 | 修复时模型给不出 JSON，`out/` 里存的是垃圾输出 | 交给人的是最后一版能解析的文档，原始输出另存 `<stage>.raw.txt` | 三次非 JSON → out 仍是上一版文档 |
| 6 | 旧的 needs_human 运行能在新运行通过后结案，覆盖新结果 | 结案前检查之后是否已有通过 / 结案的运行 | 旧修复被拒 |
| 7 | 进程号复用会永久锁住阶段 | `runs unlock <dir> --id N`；本进程残留按执行名单自动收尾 | 解锁后能再跑；非 running 不能解锁 |
| 8 | 只试第一个代码块 | 依次试 json 块、其他块、花括号片段 | 前置说明块、字符串里含 ``` |
| 9 | 重新注册升级后的同名 skill 不换挂载 | 自动换挂载并在 `remounted` 报告；别的 skill 占着时提示 | 重新注册换到新行 |
| 10 | CLI 工具函数重复、清单坏 JSON 不点名文件 | 抽出 `src/cli-shared.ts`；`latestArtifact` 与 `latestArtifactDoc` 共用一条查询 | 坏清单报错带路径 |

顺带：`runNode` 拆成 `prepare` / `NodeRun`（ask、gate、context、finalGate、handOver）/ `execute` / `settle`，原「主体约 150 行」的问题一并解决。修复后 134 个测试全部通过；10 条修复逐条撤回，测试都会失败。

## Known Gaps / Follow-ups
- novel-characters / art / staging / storyboard 目前走 single-pass，专用多遍配方在 Phase 4a。
- 正式的供应商文本适配器、费用记录在 Phase 3。

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `test/node-protocol.test.ts` | 16 | frontmatter、清单、脚本执行与超时、能力探测、注册（含版本把关、缺目录）、挂载、输入、JSON 抽取、提示词、分批合并、命令行模型、人工结案条件 |
| `test/executor.test.ts` | 11 | 大纲一次通过、骨架修复、坏 JSON 重问、用尽转人工、缺输入、缺上游、剧本按批、平台门修复、模型出错、中断收尾、并发拒绝 |
| `test/cli.test.ts` | +1 | register → input → run（回放模型）→ runs → 转人工 → import --run 结案 |
| `test/migrations.test.ts` | +1 | v3 表与 CHECK 约束 |

## Next Steps
- [x] 真实模型验证（DeepSeek，见上）
- [ ] Code review
- [ ] 提交并发 PR（分支 `feat/node-protocol`，基于 `feat/project-data-layer`）

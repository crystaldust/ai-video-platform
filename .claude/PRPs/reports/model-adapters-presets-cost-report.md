# Implementation Report: 模型适配、预设与费用估算（PRD Phase 3）

## Summary
按能力分类的模型注册表（文本 / 图片 / 视频）；OpenAI 兼容文本适配器（DeepSeek：重试、Retry-After、错误分类、带回结束原因与推理 / 缓存 token）；两套内置预设与节点覆盖（迁移 v4）；价格来源链（用户 → OpenRouter 拉取缓存 → 内置表，每条带来源、日期、是否核对官方）；费用估算器（每节点区间、假设逐条写明、无价格不按 0 计）；执行器接入：按预设选模型、每次调用记实际费用与结束原因、**截断不原样重试而是拆批**；凭据（env → credentials.json → `<provider>.key`，600 权限）；CLI `models` / `preset` / `model` / `estimate` / `prices` / `cred`。

## Assessment vs Reality
| Metric | Predicted | Actual |
|---|---|---|
| Complexity | Large | Large |
| Files | 新建 ~16，修改 ~5 | 源码新建 15、修改 7；测试新建 2、修改 2；数据文件 4 |

## Tasks Completed
| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 配置目录与凭据 | done | 偏离：多读一层 `<provider>.key`（作者已放的 deepseek.key 直接可用） |
| 2 | 能力与注册表 | done | 偏离：图片模型定为 `qwen-image-3.0` / `-pro`（见下） |
| 3 | OpenAI 兼容适配器 | done | `TextResult` 增加 `finishReason`、`cachedInputTokens`、`reasoningTokens` |
| 4 | 预设 | done | |
| 5 | 迁移 v4 与项目模型选择 | done | `node_attempt` 另加 `finish_reason` |
| 6 | 价格表与来源链 | done | 每条加 `verified` 字段 |
| 7 | OpenRouter 拉取 | done | |
| 8 | 估算器 | done | 文本每集用量按 Phase 2 真实运行折算 |
| 9 | 接入执行器 | done | 含截断拆批（Phase 2 验证发现的问题） |
| 10 | CLI | done | 新文件 `src/cli-models.ts` |
| 11 | 文档 | done | `docs/models-and-pricing.md` |

## Validation Results
| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc -p .` 零错误 |
| Tests | Pass | 158 个（原 135，新增 23，含评审修复的回归测试） |
| Coverage | Pass | 行 98.1% / 分支 86.6% / 函数 96.1% |
| 变异验证 | Pass | 8 处逐一改坏都被抓到：无价格按 0 计、截断照样重试、截断不拆批、凭据不查权限、节点覆盖不生效、用户价格不优先、能力不校验、适配器不重试 |
| 不出网 | Pass | 全部测试用假 fetch 与临时配置目录 |
| 真实模型验证 | Pass | 2026-10-29：新项目 `run outline` 不带 `--model-cmd`，预设 budget → `deepseek:deepseek-flash`，凭据来自 `deepseek.key`；骨架 → 分集 → validate 修复 1 轮 → 平台门，passed，skill `checkup` 全部通过；3 次调用均 `finish_reason: stop`，记下推理 / 缓存 token 与费用，合计约 $0.028 |

## 价格核对（2026-10-29）
- **已核对官方**：MiniMax H3（768P $0.08/s、2K $0.13/s）、H3-Lite（480P $0.025/s、768P $0.04/s）、超额参考图；Qwen-Image 3.0（1K / 2K $0.03/张、输入图 $0.003/张）与 3.0 Pro（1K $0.04、2K $0.075），新加坡国际站价。
- **未核对**：DeepSeek Flash（$0.30 / $1.20 每百万，第三方转述）；DeepSeek V4 Pro 无可靠价格，生产级估算标「不完整」。
- 估算（Phase 2 验证项目，6 集 × 60 秒）：小成本 **$12.5–16.2**（视频 $9–10.4 占大头），生产级 $35.7–44.3（不含文本）。

## Deviations from Plan
1. **图片模型**：计划写「qwen-image / qwen-image-edit」；官方价目表里当前是 `qwen-image-3.0` 系列，且同一个模型就能接收输入图片（参考图另按张计费），不需要单独的编辑模型。两套预设都改用 3.0（小成本 1K、生产级 Pro 2K）。
2. **凭据多读 `<provider>.key`**：兼容作者为 Phase 2 验证手工放的 key 文件。
3. **截断拆批**（计划 Notes 里来自 Phase 2 验证的补充）：配方的分集批次遇到截断对半拆开；修复阶段被截断时交出最后一版可用文档。
4. **价格条目加 `verified`**：没能在官方页面核对的价格要能在界面上标出来。

## Known Gaps
- DeepSeek 两个模型的官方单价、上下文与输出上限没能从官方页面取到（快速开始页不含价格），注册表用 128k / 32k，已验证 32k 输出可用；Phase 8 用实际账单校准。
- 估算的文本用量只有大纲、剧本是实测折算，其余阶段是粗估。
- 图片、视频适配器的调用在 Phase 5。

## Tests Written
| File | Tests | Area |
|---|---|---|
| `test/models.test.ts` | 9 | 配置目录、凭据层级与权限、注册表、适配器（请求体、用量、截断、429/500/401/400/网络/非 JSON） |
| `test/pricing.test.ts` | 7 | 预设与覆盖、模型选择、价格来源链、OpenRouter、估算（有分镜 / 只有大纲 / 两套并排） |
| `test/executor.test.ts` | +2 | 截断拆批与费用记录；拆到一集仍截断转人工 |
| `test/cli.test.ts` | +1 | models / preset / model / estimate / prices / cred |

## Code Review 修复（10 条）
凭据坏 JSON 不回显内容；截断说明区分分批 / 不分批；模型没单价、价格文件读不了时运行开头提示「本次不记费用」；估算不把非 USD 价格混进 USD；缓存命中有单价就按它计（`token_in_cached`）；Retry-After 超过 120 秒不等、直接报限流；`prices refresh` 不读将被覆盖的旧缓存；`--param` 支持多个并校验 `键=值`；估算只读一次预设与价格。8 处修复逐一撤回都被测试抓到。V4 Pro 的价格不编造，仍显示「无价格」并在运行时提示。

## Next Steps
- [x] 真实模型验证
- [x] Code review（10 条已修）
- [ ] PR

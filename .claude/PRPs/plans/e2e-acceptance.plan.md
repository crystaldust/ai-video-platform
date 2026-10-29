# Plan: 端到端验收（PRD Phase 8）

## Summary
用一个全新的梗概在平台里完整做出一集 30–60 秒成片，执行 082 局部返工案例，并采集 PRD Success Metrics 的度量：零对话推进、082 返工时其他镜头重新生成 0 次、入选素材 100% 可追溯、重复付费 0 次，以及人工投入时长和「估算 vs 实际」费用偏差两项基线。本阶段主要交付两样东西：一个可重复执行的验收脚本与审计命令（`cli audit`），以及一份验收报告。

## User Story
作为作者，我想确认平台真的能把我从梗概带到成片、返工时只动出问题的镜头、每一分钱和每一个输入都查得到，从而决定它能不能取代现在的对话式流程。

## Problem → Solution
各阶段单独验证过，但没有整链验证与度量 → 一次真实的端到端运行 + 自动审计 + 度量基线。

## Metadata
- **Complexity**: Medium（代码少，运行与记录多）
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`
- **PRD Phase**: Phase 8 端到端验收
- **Depends**: Phase 6、Phase 7
- **Estimated Files**: ~8

---

## UX Design
N/A — 验收阶段，不新增界面；度量结果显示在验收报告里。可选：全貌页加一个「度量」小卡（用时、实际花费、估算偏差）。

---

## Mandatory Reading
| Priority | File | Why |
|---|---|---|
| P0 | PRD「Success Metrics」与「Key Hypothesis」 | 验收口径 |
| P0 | Phase 5–7 计划 | 任务、候选、审阅、剪辑的数据 |
| P1 | `test/scenario-082.test.ts` | 082 案例的结构化表达，审计规则照此写 |

---

## 关键设计

### 1. 审计命令 `cli audit <dir> [--episode]`
逐条检查并输出通过 / 不通过与证据：
| 检查 | 规则 | 对应指标 |
|---|---|---|
| 可追溯 | 每个被选用、进入最新剪辑的候选：有任务、计划输入、实际输入、模型、参数、skill 版本（其目标版本对应的分镜产物的 skill 字段）、预估与实际费用 | 可追溯性 100% |
| 重复付费 | `generation_task` 中同一内容指纹、同一目标、`attempt_of` 为空的成功任务不超过 1 个；`(provider, provider_task_id)` 无重复 | 重复付费 = 0 |
| 对话推进 | 编排与 run 的触发来源全部是 CLI / 界面（run 记录 `trigger` 字段，本阶段补上：`cli` / `web` / `api`） | 零对话推进 |
| 局部返工 | 给定返工目标（如 082），返工期间其他目标新建任务数 = 0 | 082 案例 |
| 成片引用 | 最新成片的剪辑版本中，返工目标引用的是新选用的候选 | 082 案例 |

### 2. 度量采集
- **人工投入时长**：界面与 CLI 记录「人工操作事件」（打回、复核、审阅、选用、确认），按会话聚合活跃时长（相邻事件间隔 > 10 分钟视为离开）；同时提供手动计时字段，二者都写进报告。
- **估算 vs 实际**：每个付费节点的确认单估算区间 vs 实际费用合计，算偏差百分比；文本节点同理。
- 结果写入 `metrics` 表（迁移 v9：`metric(name, value, unit, context JSON, measured_at)`），报告从这里生成。

### 3. 验收运行手册（`docs/acceptance/runbook.md`）
1. 准备：全新梗概（不是《渡口》，避免模型「见过」样例），小成本预设，凭据就绪，ffmpeg 就绪。
2. 新建项目 → 一键 → 在全貌上审阅并处理所有待办（只用界面）。
3. 付费确认（设上限）→ 生成 → 审阅、选用 → 自动拼剪 → 导出。
4. 082 案例：挑一段标不合格（时间点意见）→ 选一种修订路径 → 新版合格并选用 → 剪辑自动出新版本 → 重新导出。
5. 中断测试：生成过程中 `kill -9`，重启恢复（Phase 5 已测，这里在真实运行中再做一次）。
6. `cli audit` → 全部通过；导出度量。
7. 写验收报告 `docs/acceptance/<日期>-report.md`：每项指标的结果与证据、问题清单、费用明细、人工时长。

---

## Files to Change
| File | Action |
|---|---|
| `src/audit/audit.ts`、`src/audit/checks/*.ts` | CREATE |
| `src/metrics/collect.ts` | CREATE |
| `src/db/schema-v9.ts`、`migrations.ts` | CREATE / UPDATE（metric 表、node_run / orchestration / 人工事件的 `trigger` 字段） |
| `src/cli.ts` | UPDATE（`audit`、`metrics`） |
| `docs/acceptance/runbook.md`、`docs/acceptance/report-template.md` | CREATE |
| `test/audit.test.ts` | CREATE（用构造数据覆盖每条审计规则的通过与不通过） |

## NOT Building
- 新功能；验收中发现的问题记录进报告，按严重程度另开修复计划
- 多集验收（第一版只验收 1 集，数据结构保留 N 集能力）

---

## Step-by-Step Tasks
1. 迁移 v9：metric 表与 trigger 字段（存量记录 trigger 为 null，审计时视为「未知」并报告）。
2. 审计检查（每条规则一个文件 + 单测，通过与不通过各至少一个用例）。
3. 度量采集（人工事件、费用偏差）。
4. CLI `audit` / `metrics`。
5. 运行手册与报告模板。
6. 真实运行一次，写验收报告；PRD 状态更新（Phase 8 complete、Success Metrics 填实测值、Open Questions 中已解决的勾掉）。

## Testing Strategy
| Test | 期望 |
|---|---|
| 可追溯缺字段 | 构造缺实际输入的选用候选 → 审计不通过并点名 |
| 重复付费 | 构造同指纹两个成功任务 → 不通过 |
| 082 局部返工 | 返工期间其他目标有新任务 → 不通过 |
| 成片引用 | 最新剪辑仍引用旧候选 → 不通过 |
| 全部合规 | → 全部通过 |

## Validation Commands
```bash
pnpm typecheck && pnpm test && pnpm coverage
cli audit <验收项目目录>
```

### Manual Validation（Phase 8 success signal）
- [ ] Success Metrics 前 5 项达标：端到端跑通 1 集 30–60 秒、零对话推进、082 返工其他镜头 0 次重新生成且成片自动引用新版、可追溯 100%、重复付费 0
- [ ] 后 2 项得到基线：费用估算偏差、人工投入时长

## Acceptance Criteria
- [ ] `cli audit` 在验收项目上全部通过
- [ ] 验收报告提交，PRD 更新
- [ ] 审计规则有单测

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 真实运行暴露前面阶段的问题 | H | M | 记录、分级、另开修复计划；不在验收阶段临时改功能 |
| 费用超出预期 | M | M | 小成本预设 + 确认单上限；只做 1 集 |
| 人工时长难以客观测量 | H | L | 事件推算 + 手动计时双轨，报告里说明口径 |

## Notes
- 验收用的梗概建议由作者现写一个，避免和样例《渡口》重合。

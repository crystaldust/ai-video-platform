# Plan: 审阅、三态与局部重做（PRD Phase 6）

## Summary
在 Phase 5 的候选素材之上做镜头级审阅：逐段 / 逐切看候选，按时间点写意见，标记「合格 / 不合格」，选用其中一个。三态（执行成功 / 素材合格 / 被选用）分开记录、分开显示。不合格时给出修订路径（同参数重出、改提示词、换参考图或首帧、打回分镜文本），**只重新生成被修订的那一段**；新旧版本并排对比；上游（分镜、关键帧、角色参考图）变了时，列出受影响的候选与选用，但已选用的素材继续引用原来的具体版本，不被静默替换。

## User Story
作为作者，我希望能像审片一样逐镜头看候选、在具体秒数上写意见、选定合格的版本，发现 082 有问题时只重做 082，并能把新旧两版放在一起比较，从而让不合格的素材不再流进剪辑、返工只动必要的部分。

## Problem → Solution
「任务成功」被当成「素材可用」，返工整段重来 → 三态分开；修订路径只重做指定镜头；影响列表说明上游变更波及了谁。

## Metadata
- **Complexity**: Large
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`
- **PRD Phase**: Phase 6 审阅、三态与局部重做
- **Depends**: Phase 5；可与 Phase 7 并行
- **Estimated Files**: ~20

---

## UX Design
```
素材与候选 › 第 01 集 › 段 082（sg_tbkve4z7）
┌ v1 ─────────────┐ ┌ v2 ─────────────┐
│ ▶ 0:00 / 0:12   │ │ ▶ 0:00 / 0:12   │   并排对比，可同步播放
│ ✗ 不合格          │ │ ✓ 合格 · 已选用   │
│ 2.4s 多了一个贝内特 │ │ note：光线偏冷     │
└─────────────────┘ └─────────────────┘
执行：succeeded · $0.96   计划输入 ≠ 实际输入（首尾帧被拒，改单首帧）
[同参数重出] [改提示词…] [换首帧 / 参考图…] [打回分镜文本…]
```
- 设计稿：Phase 6 开始前在 .pen 补画「素材与候选」审阅页与「修订」弹窗（Phase 5 画的是列表 / 任务视角，本阶段补审阅视角）。

---

## Mandatory Reading
| Priority | File | Why |
|---|---|---|
| P0 | `src/db/schema-v1.ts` 的 candidate / review / selection / candidate_state | 三态已有表与视图 |
| P0 | `test/scenario-082.test.ts` | 082 案例的既有表达 |
| P0 | Phase 5 计划：任务状态机、`attempt_of`、计划 / 实际输入 | 修订就是带变更的重新生成 |
| P0 | Phase 4a 计划：`reject`（打回分镜文本）、`reviewMatrix` | 修订路径之一、影响计算的复用 |
| P1 | `src/repo/lineage.ts` | 候选 → 任务 → 目标版本 → 上游 的追溯 |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| HTML5 video | MDN `<video>`、`timeupdate`、`currentTime` | 时间点意见取 `currentTime`；并排对比用同一个时钟驱动两个播放器 |
No other external research needed.

---

## 关键设计

### 1. 三态
- **执行**：`generation_task.status`（Phase 5）。
- **合格**：最近一条非 note 的 review（`pass` / `fail`），已有视图 `candidate_state`。
- **选用**：该目标最近一条 selection。
- 规则：**只有合格的候选能被选用**（在仓储层校验，界面置灰）；撤销合格（新 review = fail）时，如果它正被选用，自动追加一条「撤销选用」selection 并在影响列表中提示——避免不合格素材留在选用里。
- `usableForEdit(candidate)` = 执行 collected ∧ 合格 pass ∧ 被选用；Phase 7 只接受这样的候选。

### 2. 时间点意见
- review 增加 `at_seconds`（已有）与 `frame`（可选，按帧率换算）；note 类意见不影响合格状态。
- 意见可以关联「修订路径」：从一条 fail 意见直接发起修订，修订记录引用它。

### 3. 修订路径（revision）
| 路径 | 动作 | 代价 |
|---|---|---|
| 同参数重出 | Phase 5 `regenerate`，计划输入不变 | 付费 |
| 改提示词 | 生成「段提示词覆盖」（只影响这次修订，原分镜不变），新任务的计划输入用覆盖后的提示词 | 付费 |
| 换首帧 / 参考图 | 从该段已有关键帧候选或角色参考图里重新选择，新任务引用新选择 | 付费 |
| 打回分镜文本 | 调 4a 的 `reject storyboard --ep`，附意见；分镜更新后该段进入「上游已变」 | 文本，便宜 |
- 迁移：`revision`（id、target_entity_id、from_review_id、path、changes JSON、task_id、created_at）。
- 每条修订都只建一个新任务，目标是被修订的段（或切）；不触发其他段。

### 4. 版本对比
- 同一目标的候选按 label 排序，任意两版并排；显示两版的计划输入差异（JSON diff：提示词、参考图、参数）、费用、审阅记录。

### 5. 影响列表
- 对每个候选：它的任务钉在哪个目标版本（`target_version_id`）与哪些参考素材；若目标的当前版本更新了（分镜段改了）或参考素材所属的角色参考图被重出 / 改选，候选标「上游已变」。
- 影响列表 = 「上游已变」且「被选用」的候选（这些最需要关注），以及所有「上游已变」的候选。
- 选用不自动迁移：旧选用继续生效，直到作者重新审阅、重新选用。

---

## Files to Change
| File | Action |
|---|---|
| `src/db/schema-v7.ts`、`migrations.ts` | CREATE / UPDATE（revision 表、review.frame、selection 原因字段） |
| `src/review/tristate.ts` | CREATE（选用规则、撤销联动、`usableForEdit`） |
| `src/review/revisions.ts` | CREATE（四种修订路径） |
| `src/review/impact.ts` | CREATE（上游已变判定与影响列表） |
| `src/review/compare.ts` | CREATE（计划输入 diff） |
| `src/repo/reviews.ts` | CREATE |
| `src/server/routes/review.ts`、`web/src/pages/Review.tsx`、`web/src/components/{DualPlayer,ReviewNotes,RevisionDialog,ImpactList}.tsx` | CREATE |
| `src/cli.ts` | UPDATE（`review-asset` / `select` / `revise` / `impact`） |
| `designs/ai-short-video-platform.pen` | UPDATE（审阅页、修订弹窗） |
| `test/review-*.test.ts`、`web/e2e/review.spec.ts` | CREATE |

## NOT Building
- 自动质检（黑帧、时长异常、人物重复）——PRD Could
- 帧级精确标注工具（画框）——先做到时间点
- 剪辑（Phase 7）

---

## Step-by-Step Tasks
1. 迁移 v7 与仓储。
2. 三态规则：只能选合格的；撤销合格联动撤销选用；`usableForEdit`。
3. 时间点意见与 note。
4. 四种修订路径（付费路径复用 Phase 5 任务创建，带 `attempt_of` 与 revision 记录）。
5. 影响判定与列表。
6. 版本对比（计划输入 diff）。
7. CLI 与 API。
8. 设计稿补画 → 页面实现（双播放器同步、意见列表、修订弹窗、影响列表）。
9. E2E：082 不合格 → 改提示词修订 → 新版合格并选用 → 旧版仍可看。
10. 文档 `docs/review.md`。

## Testing Strategy
| Test | 期望 |
|---|---|
| 选用不合格候选 | 拒绝 |
| 已选用的候选被改判 fail | 自动撤销选用，影响列表出现该目标 |
| 082 修订 | 只为 082 建 1 个任务；其他段任务数不变（PRD success signal） |
| 旧版可查 | 修订后 v1 的文件、审阅、任务都在，可对比 |
| 上游变更 | 改分镜段 082 → 082 的候选「上游已变」，选用不变 |
| 计划输入 diff | 改提示词路径的 diff 只含提示词 |

## Validation Commands
```bash
pnpm typecheck && pnpm test && pnpm coverage && pnpm test:e2e
```
### Manual Validation（Phase 6 success signal）
- [ ] 把 082 标为不合格并重新生成，其他镜头的任务数不变，旧版本仍可查看、可并排对比

## Acceptance Criteria
- [ ] 三态分开记录与显示；只有合格的能被选用
- [ ] 四种修订路径可用，每次只动被修订的目标
- [ ] 影响列表正确，选用不被静默替换
- [ ] 测试与 E2E 通过

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 浏览器播放本地大文件慢 | M | L | 服务端支持 Range 请求；必要时生成低码率预览 |
| 「上游已变」判定过严导致满屏标记 | M | M | 区分「影响画面的变更」（提示词、参考图）与仅显示字段变更（编号）——后者不触发 |

## Notes
- 「上游已变」的判定沿用 Phase 1 的原则：引用钉具体版本、过期现算，不存标记。

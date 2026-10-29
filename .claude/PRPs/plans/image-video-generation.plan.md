# Plan: 图片/视频生成与可靠任务（PRD Phase 5）

## Summary
接入一家图片供应商（角色参考图 + 关键帧）和 MiniMax H3 视频，把付费生成做成持久化的任务状态机：**先写库、再请求**；拿到供应商任务 ID 立即落库；断线或重启后只做查询，绝不自动重新提交；「重新查询」与「重新生成」是两个不同的动作。每个任务记录计划输入与实际输入、失败或被拒原因、预估与实际费用；产出的文件进内容寻址素材库，成为候选（candidate）。只处理 Phase 4 付费确认单里已确认、且在预算上限内的项。

## User Story
作为作者，我希望确认费用后平台可靠地生成角色参考图、关键帧和视频，中途断网或重启不会重复扣费，每张图、每段视频都能查到用了什么输入、花了多少钱，从而放心地一键付费生成。

## Problem → Solution
生成靠手动调接口、结果散在本地，断线后不知道任务是否已提交 → 任务状态机 + 先写库再请求 + 恢复时对账，所有素材以候选形式挂到镜头上。

## Metadata
- **Complexity**: XL
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`
- **PRD Phase**: Phase 5 图片/视频生成与可靠任务
- **Depends**: Phase 3（模型注册表、价格、凭据）、Phase 4（付费确认单、界面）
- **Estimated Files**: ~25

---

## UX Design
```
全貌 → 付费确认（勾选、上限）→ 确认
  ▸ 角色参考图：沈知微 正面全身（锚点）… ✓   其余视图只参考锚点
  ▸ 关键帧 51 张：并发 4，✓ 49 · 重试 2 · ✗ 0
  ▸ 视频 15 段：已提交 15 · 生成中 6 · 完成 9
  ⏸ 实际花费 $18.2 / 上限 $50
（强制退出后重启）
  ▸ 恢复：15 个视频任务只做查询，0 个重新提交；2 个「提交中」状态的任务通过供应商任务列表对上了
```
界面：设计稿中「生成任务」「素材与候选」两页本阶段新增设计（Phase 5 开始前在 .pen 里补画），全貌的付费阶段卡片显示实时进度。

---

## Mandatory Reading
| Priority | File | Why |
|---|---|---|
| P0 | `src/db/schema-v1.ts` 中 generation_task / task_event / candidate / media_file | Phase 1 已建表，本阶段补字段与状态 |
| P0 | `test/scenario-082.test.ts` | 任务 / 候选 / 选用的既有用法与约束（同一供应商任务 ID 唯一） |
| P0 | `src/repo/media.ts` | 内容寻址入库 |
| P0 | Phase 3 计划的能力声明与价格表 | 适配器能力、按秒 / 按张计价 |
| P0 | Phase 4a 计划的 `paid_gate` | 只执行已确认的选择与上限 |
| P1 | 上游 `character-refs/SKILL.md` 与 `scripts/models.mjs` | 「先出正面全身锚点，其余视图只参考锚点」的流程与多后端出图的参考实现 |
| P1 | 上游 `novel-storyboard` 的 `export --protocol h3` | 每段 H3 提示词与 Picture 序的分镜图清单——视频任务的输入 |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| MiniMax 视频生成 | https://platform.minimax.io/docs/guides/video-generation.md （查询于 2026-10-29） | `POST https://api.minimax.io/v2/video_generation` 返回 `task_id`；`model` = `MiniMax-H3` / `MiniMax-H3-Max`；`content` 数组（`text` / `image_url` / `video_url` / `audio_url`，可带 `role`：`first_frame`、`last_frame`、`reference_image`…）；`duration` H3 4–15 s；`resolution` H3 768P / 2K（H3-Max 480P / 768P）；`ratio` 文生视频必填；提示词 ≤ 7000 字、参考图 ≤ 9 张、请求体 ≤ 64 MB |
| 查询与结果 | 同上 | `GET /v2/query/video_generation/{task_id}`；`succeeded` / `failed` / `cancelled` 为终态；建议 10 s 轮询；成功后 `task.content.url` 为下载地址（有效期未写明——拿到即下载）；**没有幂等键与回调**；List Tasks 可查最近 7 天 |
| MiniMax 定价 | Phase 3 计划 | H3 按秒计费；每任务 5 张参考图免费 |

```
KEY_INSIGHT: 供应商不提供幂等键，「提交成功但没来得及记下 task_id」时无法靠重试保证不重复
APPLIES_TO: 状态机与恢复
GOTCHA: 恢复时对 `submitting` 状态的任务绝不自动重提；先用 List Tasks（7 天内）按提交时间窗口 + 内容指纹对账，对不上的标 `unknown`，交给人决定

KEY_INSIGHT: H3 的视频时长 4–15 s，正好对应分镜「段 ≤ 15 秒」
APPLIES_TO: 段 → 视频任务一对一
GOTCHA: 段秒数 < 4 时按 4 提交并在实际输入里记录差异（计划输入 vs 实际输入）
```

---

## 关键设计

### 1. 任务状态机（扩展 Phase 1 的 generation_task）
```
planned ──提交前落库──▶ submitting ──拿到 task_id 落库──▶ submitted ──轮询──▶ running
   │                        │                                              │
   │                        └─崩溃后恢复：对账──▶ submitted / unknown        ├─▶ succeeded ─下载入库─▶ collected
   └─超出预算 / 取消──▶ cancelled                                           ├─▶ failed（原因）
                                                                            └─▶ rejected（审核拒绝，原因）
```
- 迁移：`generation_task.status` 增加 `submitting`、`collected`、`cancelled`、`unknown`；新增 `content_fingerprint`（计划输入规范化后的哈希）、`submitted_at`、`provider_status`、`attempt_of`（重新生成时指向原任务）、`paid_gate_id`。CHECK 约束随之更新（SQLite 改 CHECK 需重建表——迁移里用「新建表 → 复制 → 改名」，在一个事务内完成，并有迁移测试）。
- 每次状态变化写 `task_event`（含供应商原始响应的关键字段，不含凭据）。
- **重新查询**：对 `submitted` / `running` / `unknown`（有 task_id）的任务再查一次，不花钱。
- **重新生成**：新建一条任务（`attempt_of` 指向旧任务），需要用户在界面明确操作，计入预算。

### 2. 执行器（付费）
- 输入：已确认的 `paid_gate.selection`（节点 × 集）与上限。
- 顺序：角色参考图（每个角色先锚点，锚点成功后再并发出其余视图并只参考锚点）→ 关键帧（每切一张，参考对应角色锚点 + 场景）→ 视频（每段一个任务：H3 提示词 + 该段的关键帧作为 `reference_image` / `first_frame`）。
- 预算：每提交一个任务前，`已确认实际 + 在途预估 + 本任务预估 > 上限` 就暂停（状态 paused，界面提示）。
- 并发：图片默认 4，视频默认 3（可配）；轮询间隔 10 s，带抖动。
- 计划输入 vs 实际输入：计划输入来自分镜与参考图选择；实际输入是真正发出的请求体（去掉凭据、图片用素材库哈希表示）；不同就都存，界面标「计划与实际不一致」。

### 3. 适配器
- 视频：`minimax-video.ts` 实现 `VideoModel { submit(req) → providerTaskId; query(id) → status/url/error; listRecent(since) → [{id, createdAt, fingerprintHint}] }`。
- 图片：实施当天按 Phase 3 预设里选定的图片模型实现 `ImageModel`（同步或异步都包成同一状态机：同步接口视为「提交即完成」，仍先落库）。
- 下载：拿到 URL 立即下载到临时文件 → 校验大小 / 类型 → `addMediaFile` 入库 → 建 candidate（label = v1、v2…）→ 任务 collected。下载失败可单独重试（不重新生成）。

### 4. 恢复
进程启动（或 `tasks resume`）时：
1. `submitting`：调用 `listRecent(提交时间 − 2 min)`，按时间窗口 + 内容指纹匹配；唯一匹配 → 补记 task_id 转 submitted；无匹配 → 再等一个窗口仍无则标 `failed`（原因「提交未到达供应商」，可安全重新生成）；多个匹配 → `unknown`（交给人）。
2. `submitted` / `running`：继续轮询。
3. `succeeded` 但未 collected：重新下载。

---

## Files to Change
| File | Action |
|---|---|
| `src/db/schema-v6.ts`、`migrations.ts` | CREATE / UPDATE（重建 generation_task 以更新 CHECK） |
| `src/generate/state-machine.ts` | CREATE（合法转移表 + 转移函数，非法转移抛错） |
| `src/generate/planner.ts` | CREATE（从 paid_gate 生成任务计划：参考图 / 关键帧 / 视频） |
| `src/generate/runner.ts` | CREATE（并发、预算、轮询、下载） |
| `src/generate/recovery.ts` | CREATE |
| `src/model/minimax-video.ts`、`src/model/<image-provider>.ts` | CREATE |
| `src/repo/tasks.ts`、`src/repo/candidates.ts` | CREATE |
| `src/server/routes/tasks.ts`、`web/src/pages/Tasks.tsx`、`web/src/pages/Candidates.tsx` | CREATE |
| `src/cli.ts` | UPDATE（`generate` / `tasks` / `tasks resume` / `tasks requery <id>` / `tasks regenerate <id>`） |
| `designs/ai-short-video-platform.pen` | UPDATE（补画「生成任务」「素材与候选」） |
| `test/generate-*.test.ts` | CREATE |

## NOT Building
- 审阅、合格 / 选用、修订路径（Phase 6）
- 剪辑（Phase 7）
- 第二家视频供应商（PRD Could）
- 自动质检（黑帧、人物重复）（PRD Could）
- 配音 / TTS

---

## Step-by-Step Tasks
1. **迁移与状态机**：重建 generation_task（新状态与字段），`state-machine.ts` 的转移表；测试覆盖每条合法转移与非法转移。
2. **仓储**：任务、事件、候选的读写；同一 `(provider, provider_task_id)` 唯一约束保留。
3. **视频适配器**：submit / query / listRecent；用假 fetch 测：成功、failed、cancelled、审核拒绝（映射到 rejected 并保存原因）、网络错误、429。
4. **图片适配器**：同上。
5. **任务计划**：从确认单与分镜 / 角色 / 美术生成任务列表（参考图选择规则写成纯函数，计划输入可快照测试）。
6. **执行与预算**：并发、预算暂停、轮询、下载入库、候选建立。
7. **恢复**：三类状态的恢复，特别是 `submitting` 对账（唯一 / 无 / 多个匹配三种）。
8. **CLI 与 API / 界面**：任务列表（状态、费用、计划 vs 实际）、重新查询、重新生成；全貌付费卡片进度。
9. **设计稿**：补画两页并按其实现。
10. **文档**：`docs/generation.md`（状态机、恢复语义、费用记录）。

## Testing Strategy
| Test | 期望 |
|---|---|
| 先写库再请求 | 在 submit 之前强制抛错 → 库里有 planned/submitting 任务、供应商零调用 |
| 提交后崩溃 | submit 成功但写 task_id 前抛错 → 恢复对账唯一匹配 → submitted，**submit 总调用次数仍为 1** |
| 对账多个匹配 | → unknown，不自动重提 |
| 重新查询 vs 重新生成 | requery 不调用 submit；regenerate 新建任务且 attempt_of 指向旧任务 |
| 审核拒绝 | rejected 带原因；不计实际费用（按供应商规则，规则未写明时记 null 并标注） |
| 预算上限 | 预估超限 → paused，不提交 |
| 下载失败 | succeeded 未 collected → 重试下载，不重新生成 |
| 082 | 只对 082 段 regenerate → 其他段任务数不变 |

## Validation Commands
```bash
pnpm typecheck && pnpm test && pnpm coverage
```
### Manual Validation（Phase 5 success signal）
- [ ] 用小成本预设生成 1 集的参考图、关键帧、视频；中途 `kill -9` 进程，重启后 `tasks resume`：没有重复提交（对比供应商任务列表），全部任务最终 collected 或明确失败
- [ ] 每个候选都能查到计划输入、实际输入、模型、参数、费用

## Acceptance Criteria
- [ ] 强制中断再重启，任务能恢复，没有重复提交（PRD success signal）
- [ ] 重新查询与重新生成分开
- [ ] 计划 / 实际输入、失败 / 拒绝原因、预估 / 实际费用全部记录
- [ ] 预算上限生效

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 供应商无幂等键 | 已知 | H | 先写库 + List Tasks 对账 + unknown 交给人 |
| 下载地址过期 | M | M | 成功即下载；过期则只能重新查询拿新地址（若供应商支持），否则标记并提示 |
| 真实测试花钱 | H | M | 自动测试全用假 fetch；手工验证用小成本预设、1 集 |
| 参考图上传方式（URL vs base64，64 MB 限制） | M | M | 实施时确认；必要时本地起临时静态服务或改用供应商文件上传接口 |

## Notes
- 「生成任务」「素材与候选」两页依赖本阶段的数据形状，所以没在 Phase 4 画；本阶段开始时先补设计稿。

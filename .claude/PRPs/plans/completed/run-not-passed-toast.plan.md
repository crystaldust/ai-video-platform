# Plan: 后台任务里的运行没通过时，页面弹一句提示（backlog #37）

## Summary
单集打回、重跑某阶段、只重跑需复核、一键跑、补出图提示词，这几种运行转人工或失败时，后台任务照样正常结束（`job-end.ok === true`），页面没有任何提示。

改法分前后端：
- **服务端：** 在 `job-end` 里带上任务说明（`detail`）和没过的原因。
- **页面：** 用一个纯函数把 `job-end` 翻成一条提示：标题、原因、对应运行号/阶段/集。全貌页弹红色提示条，提示条上有按钮，点了把右侧详情切到对应的待处理项。

## User Story
作为在全貌页点「打回」「重跑」「补提示词」的用户，我希望运行没通过时页面直接告诉我哪一步、为什么没过，还能一键跳到那一项，这样就不用自己去翻阶段卡和运行日志。

## Problem → Solution
- **现在：** `job-end` 只有 `ok` 和 `result`。`OverviewPage` 只在两种情况下提示：`ok === false`，或者多集打回（`rejectSummary`）。
- **改后：** `job-end` 带 `detail`，结果里带没过的原因。新增 `jobEndNotice()` 统一生成提示；`useToast` 支持「标题 + 原因 + 按钮」。

## Metadata
- **Complexity**: Medium（前后端各一小块，约 7 个文件）
- **Source PRD**: N/A（backlog #37）
- **Estimated Files**: 7–8

---

## UX Design（pen 稿：`designs/ai-short-video-platform.pen`）
- 画面「全貌视图 · 运行没通过的提示 · Web 1440」（Q5skoO）：右下角红色提示条。
- 说明框「#37 提示条的几种情况」（DkwXH）列出五种情况：
  1. **单集打回 / 补提示词 / 重跑某阶段，转人工或失败：** 标题「打回分镜（第 05 集）转人工」，下面是原因，按钮「在待处理里看这一项」。
  2. **一键跑 / 只重跑需复核，有阶段没过：** 标题「只重跑需复核停下了」，原因如「剧本转人工；分镜、站位因上游没过没跑」，加按钮。
  3. **补出图提示词没过：** 和第 1 种同一个样子。
  4. **（可选，待用户定）通过了：** 深色提示「打回分镜（第 05 集）通过」，3 秒后消失。
  5. **后台任务本身出错：** 保持现状（「任务失败：…」）。
- 多集打回保持 `rejectSummary` 不变。
- 没通过的提示是红色、`role=alert`、不自动消失，点 × 或点提示条关掉。点按钮会切换右侧详情，并关掉提示。

### Interaction Changes
| 触点 | 之前 | 之后 |
|---|---|---|
| 单集打回转人工/失败 | 没提示 | 红色提示：标题、原因、跳转按钮 |
| 重跑某阶段 / 只重跑需复核 / 一键跑有阶段没过 | 没提示 | 红色提示：列出没过的阶段，按钮跳到第一个 |
| 补出图提示词没过 | 没提示 | 红色提示 |
| 通过（可选） | 没提示 | 深色提示，3 秒消失 |

---

## Mandatory Reading
| P | 文件 | 行 | 为什么 |
|---|---|---|---|
| P0 | `src/server/jobs.ts` | 69–140 | `start()` 发 `job-end`；`go`、`reject`、`refs` 的结果形状 |
| P0 | `web/src/generation.ts` | 160–205 | `busyReason`、`rejectSummary`：页面纯函数的写法，新函数也放这里 |
| P0 | `web/src/pages/OverviewPage.tsx` | 44–110 | 事件处理、`selectedItem` 的选择方式 |
| P0 | `web/src/components/ui.tsx` | 75–90 | `useToast` |
| P1 | `src/orchestrate/orchestrator.ts` | 25–60, 150–158 | `StageResult`、`StageStatus`、`overall()` |
| P1 | `src/executor/run-node.ts` | 73–80 | `RunOutcome`：`status` 是 passed / needs_human / failed，转人工或失败时带 `message` |
| P1 | `src/server/views/overview.ts` | 42–56 | `PendingItem`：`kind`、`stage`、`episode`、`runId` |
| P2 | `test/job-detail.test.ts` | 50–95 | 用 `collectEvents` 等 `job-end` 的服务端测试写法 |
| P2 | `test/generation-view.test.ts` | 105–115 | `rejectSummary` 的单元测试写法 |

## Patterns to Mirror
- **页面纯函数**（`web/src/generation.ts:181`）：`export function rejectSummary(result: unknown): { text: string; failed: boolean } | null`。入参是 `unknown`，先做窄化，返回 null 表示不提示；中文注释带例句。
- **集号显示：** `String(ep).padStart(2, '0')`；阶段标题在页面里用局部 `titles` 表（和 `rejectSummary` 一样）。
- **服务端测试：**
  ```ts
  const events = collectEvents(h, p('/events'), (e) => e.type === 'job-end');
  for (let i = 0; i < 200 && h.app.bus.subscribers(ID) === 0; i++) await new Promise((r) => setTimeout(r, 5));
  ```
- **提示：** `notify(text, 'err')`；`useToast` 返回 `[node, notify]`。

## Files to Change
| 文件 | 动作 | 说明 |
|---|---|---|
| `src/server/jobs.ts` | UPDATE | `job-end` 加 `detail`。`reject` 和 `refs` 的结果加 `message`。`go` 的结果加 `stages`：没过的阶段，每项含 stage、status、message、runId、episodes。 |
| `web/src/generation.ts` | UPDATE | 新增 `jobEndNotice(e)`。 |
| `web/src/components/ui.tsx` | UPDATE | `useToast` 的 notify 支持第三个参数 `{ title?, action? }`；有标题时分两行，有 action 时显示按钮。 |
| `web/src/components/ui.module.css` | UPDATE | 提示条的标题、原因、按钮样式（不改现有 `.toast` 位置和颜色）。 |
| `web/src/pages/OverviewPage.tsx` | UPDATE | 用 `jobEndNotice`；按钮点击时按运行号找待处理项，找不到再按阶段和集找。 |
| `test/generation-view.test.ts` | UPDATE | `jobEndNotice` 的单元测试。 |
| `test/job-detail.test.ts` | UPDATE | `job-end` 带 `detail`，`reject` 和 `go` 的结果带没过的原因。 |
| `docs/web-ui.md` | UPDATE | 提示规则写进文档。 |

## NOT Building
- 生成任务页（`TasksPage`）的付费生成提示：不变。
- 多集打回汇总：不变。
- 浏览器通知、声音、提示历史。
- 在别的页面（单集详情等）监听 `job-end`：这些操作都从全貌页发起。

---

## Step-by-Step Tasks

### Task 1: `job-end` 带任务说明和没过的原因（服务端）
- **IMPLEMENT**
  - `start()` 发事件时改成 `{ type: 'job-end', kind, detail, ok: true, result }`；失败分支也带 `detail`。
  - `reject` 返回 `{ runId, status, message: r.outcome.message ?? null, pending }`。
  - `refs` 返回 `{ runId, status, message }`。
  - `go` 返回再加 `stages: r.stages.filter((s) => s.status !== 'passed' && s.status !== 'skipped').map(({ stage, status, message, runId, episodes }) => ({ stage, status, message: message ?? null, runId: runId ?? null, episodes: episodes ?? null }))`。
- **GOTCHA**
  - `blocked` 阶段的 message 是「上游 X 未通过」，可以直接用。
  - 不要把整份 `stages` 都塞进去，只放没过的。
- **VALIDATE:** 先在 `test/job-detail.test.ts` 加测试（RED）：单集打回结果带 `message` 键，`job-end` 带 `detail`。fake 模型下怎么让运行转人工，按现有测试的做法来；造不出来就只断言键存在、通过时为 null。

### Task 2: `jobEndNotice()`（页面纯函数）
- **IMPLEMENT**：放在 `web/src/generation.ts`。
  ```ts
  export interface JobNotice { readonly title: string; readonly message: string | null; readonly failed: boolean; readonly runId: number | null; readonly stage: string | null; readonly episode: string | null }
  export function jobEndNotice(e: { ok?: unknown; detail?: unknown; message?: unknown; result?: unknown }): JobNotice | null
  ```
  - `ok === false`：标题「任务失败：…」（和现在一样），`failed` 为 true。
  - 多集打回结果（`rejectSummary` 不为 null）：返回 null，交给现有逻辑。
  - 结果有 `runId` 和 `status`（单集打回 / 补提示词）：
    - status 是 passed：标题「{detail}通过」，`failed` 为 false。
    - needs_human：标题「{detail}转人工」，failed 时是「{detail}失败」；message 取结果里的 `message`。
  - 结果有 `orchestrationId`：
    - status 是 done：「{detail}跑完了」，`failed` 为 false。
    - 其他情况：标题「{detail}停下了」，message 把没过的阶段连起来，例如「剧本转人工；分镜因上游没过没跑」。runId、stage、episode 取第一项。
  - 生成和恢复的结果（有 `gateId` 或 `matched`）：返回 null，由生成任务页处理。
  - message 截到 120 字。
- **MIRROR:** `rejectSummary`。
- **VALIDATE:** 单元测试覆盖：单集转人工、单集失败、单集通过、编排 blocked（两个阶段）、编排 done、`ok: false`、多集返回 null、生成返回 null。

### Task 3: `useToast` 支持标题和按钮
- **IMPLEMENT**：
  - `notify(text, kind = 'ok', opts?: { title?: string; action?: { label: string; onClick: () => void } })`。
  - 有 `title` 时渲染两行：粗体标题，下面是 `text`。
  - 有 `action` 时渲染白底按钮，点按钮先执行 `onClick` 再关掉提示（`stopPropagation`，避免父层的点击关闭重复触发）。
  - 右上角加 ×（`aria-label="关掉提示"`）。
  - 现有调用不受影响。
- **GOTCHA**：按钮必须是 `<button type="button">`。整个提示条现在是 `div onClick` 关闭；保留这个行为，但按钮要阻止冒泡。
- **VALIDATE:** `npm run web:typecheck`。

### Task 4: 全貌页接上
- **IMPLEMENT**：
  - 在 `useProjectEvents` 里：先保留 `rejectSummary` 分支；否则调用 `jobEndNotice(e)`。不为 null 时 `notify(n.message ?? '', n.failed ? 'err' : 'ok', { title: n.title, action })`。
  - `action` 的处理：点击时从**最新**的 pending 里找项。
    - 最新数据放进 `useRef`，每次渲染更新，避免闭包里拿到旧数据。
    - 先按 `runId` 匹配；找不到按 `stage` + `episode`，episode 可以是 null。
    - 找到就 `setSelectedItem(item)`，并 `setPickedTab(null)` 回到分集全貌。
    - 只在 `n.failed` 并且有 runId 或 stage 时给按钮。
  - 原来 `ok === false` 那行用 `jobEndNotice` 替代，文字保持「任务失败：…」。
- **GOTCHA**：job-end 到达时 overview 还没 reload，pending 是旧的。所以按钮点击时再查，不在收到事件时查。
- **VALIDATE:** web typecheck；e2e `main-flow.spec.ts` 照样通过。

### Task 5: 文档与 backlog
- `docs/web-ui.md` 写上提示规则。
- backlog #37 标为完成并链到计划。

---

## Testing Strategy
| 测试 | 输入 | 期望 |
|---|---|---|
| 单集转人工 | `{ok:true, detail:'打回分镜（第 05 集）', result:{runId:9,status:'needs_human',message:'分镜门没过…'}}` | 标题「打回分镜（第 05 集）转人工」，failed 为 true，runId 为 9 |
| 单集失败 | status 是 failed | 标题以「失败」结尾 |
| 单集通过 | status 是 passed | failed 为 false，标题「…通过」 |
| 编排停下 | `{orchestrationId:1,status:'blocked',stages:[{stage:'script',status:'needs_human',runId:3},{stage:'storyboard',status:'blocked',message:'上游 script 未通过'}]}` | 标题「只重跑需复核停下了」；message 含「剧本转人工」「分镜因上游没过没跑」；stage 为 script，runId 为 3 |
| 编排完成 | status 是 done | failed 为 false |
| 任务出错 | `ok:false` | 「任务失败：…」 |
| 多集 / 生成 | — | null |
| 服务端 | 单集打回 | `job-end` 带 detail；结果有 `message` 键 |
| 服务端 | 只重跑需复核 | 结果有 `stages` 数组 |

## Validation Commands
```bash
npm run typecheck && npm run web:typecheck
node --test test/generation-view.test.ts test/job-detail.test.ts
npm test
npm run test:e2e
```
页面验证：在冒烟副本启动服务（假模型或不调付费模型的路径），只看提示条样式和跳转。不跑付费模型；需要真模型触发的情况由用户自己点。

## Acceptance Criteria
- [ ] 五种情况的提示符合 pen 稿
- [ ] 点按钮能切到对应的待处理项
- [ ] 多集打回、付费生成的提示不变
- [ ] 两个 typecheck 0 错误；单元测试和 e2e 全部通过

## Risks
| 风险 | 可能 | 影响 | 应对 |
|---|---|---|---|
| fake 模型难造出转人工 | 中 | 服务端测试只能测通过的路径 | 转人工的形状由纯函数单测覆盖 |
| 待处理项和运行号对不上（例如重跑后转人工产生新运行） | 低 | 按钮找不到项 | 先按 runId，再按阶段和集兜底；都找不到不显示按钮 |
| 通过时也弹提示，太吵 | — | — | 留给用户在 GATE 1 定 |

## Notes
- 待用户在 GATE 1 定：通过时要不要也弹深色提示（pen 稿第 4 种）。

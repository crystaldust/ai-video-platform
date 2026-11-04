# Plan: Phase 5b 付费生成的界面（接口、生成任务页、候选预览、确认后自动开跑）

## Summary

5a 做完了付费生成的后端和命令行，但页面上「确认付费生成」只记下勾选和上限，出图还得回命令行跑 `generate`，出来的图也只能用 sql 对文件。5b 把这条路接到页面上：
- 确认后由服务的后台任务自动开跑；
- 新增「生成任务」页，按确认单看每个任务的状态、费用、失败原因，并能预览图片和视频；
- 全貌的付费卡片显示进度；
- `serve` 启动时自动恢复中断的任务。

顺带修 backlog #31 里挡在页面出图路径上的 4 条：
- 新确认单不去重，会重复付费；
- 确认单币种字段混用；
- 确认弹窗不显示编号；
- `gates` 命令看不到勾选内容和上限。

## User Story

As a 用平台做 AI 短剧的创作者，I want 在页面上确认付费后直接出图、在页面上看每张图和每个任务的状态与花费，so that 不用切到命令行、不用查 sqlite，也不会为已经出过的图再付一次钱。

## Problem → Solution

- **现状**：
  - 确认付费，只是改了状态；
  - 出图要在命令行跑 `generate`；
  - 进度只出现在终端里；
  - 结果要用 sql 把任务、候选和文件对上，再到 `media/` 里按哈希找文件；
  - 再开一张确认单，会把出过的图全部重出一遍；
  - 服务崩了，要手动 `tasks resume`。
- **改后**：
  - 确认后自动开跑，全貌卡片实时显示「12/40 · ¥2.6 / ¥10」；
  - 生成任务页按确认单列出任务、缩略图、状态和花费，点开能看大图、提示词、参考图和失败原因；
  - 同样输入已经出过的图会跳过，弹窗里也会先说明；
  - `serve` 启动时自动对账续查，但不提交新任务。

## Metadata
- **Complexity**: XL（后端约 10 个文件，前端约 10 个文件，外加设计稿）
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`
- **PRD Phase**: Phase 5 图片/视频生成与可靠任务（后半 5b）
- **Estimated Files**: 新增约 12 个，修改约 18 个
- **Branch**: `feat/phase5b-generation-ui`

---

## UX Design

> 设计稿以 `designs/ai-short-video-platform.pen` 为准（只能用 pencil MCP 读写）。**Task 1 先画稿，用户确认后才写 `web/` 代码**（用户要求，见记忆 `ui-design-first-in-pencil`）。

### Before
```
全貌 ─[确认付费生成 约¥372–433]→ 弹窗勾选 → 确认 → toast「已确认，会在 Phase 5 执行」→ 什么都不发生
侧栏「生成任务」灰着（soon: Phase 5）
```

### After
```
全貌 ─[确认付费生成 约¥…]→ 弹窗（标题带 #4；「已生成过的 4 张会跳过，不再计费」）→ 确认并开始生成
   └→ 全貌付费卡片：07 角色参考图 ▓▓▓░░ 12/36 · ¥2.6　08 关键帧 —　09 视频 —
      头部按钮：[生成中 12/36 · 停止] [查看任务 →]
侧栏「生成任务」/p/:id/tasks
   ┌ 确认单切换 #4 生成中 ▾ │ 进度条 │ 已花 ¥2.6 / 上限 ¥10 │ [停止] / [继续生成] ┐
   │ 角色参考图（按角色一行 × 5 个视图缩略图，带状态角标）                        │ 右侧详情：大图 / 视频
   │ 关键帧（按集分组的表）　视频段（按集分组的表）                                 │ 状态时间线、预估/实际费用
   │ 失败 / 被拒的行标红并显示原因                                                  │ 实际提示词、参考图、[重新查询]
   └ 点缩略图 → 全屏预览（← → 切换，Esc 关闭）                                     ┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 确认弹窗 | 标题无编号；确认只记录 | 标题「确认付费生成 #N」；按钮「确认并开始生成」；列出将跳过的已生成项并从合计里扣掉 | 确认成功后后台开跑 |
| 全貌头部按钮 | 只有「确认付费生成」 | 有在跑的生成时显示「生成中 x/y · 停止」和「查看任务」 | 和文本阶段一样，同一项目同一时刻只跑一个后台任务 |
| 全貌付费卡片 | 只有估价 | 有确认单时显示进度条、完成数、已花 / 上限、失败数 | 点卡片跳到生成任务页 |
| 侧栏「生成任务」 | 灰的 | 可用，路由 `/p/:id/tasks` | 「素材与候选」仍属 Phase 6 |
| 生成任务页 | 无 | 新页面 | 见上 |
| 停止 | 只能 Ctrl+C | 页面上的「停止」：在提交之间停下，不打断在路上的请求 | 已提交的任务下次续查 |
| 继续生成 | 只能命令行 | 预算停了或停止后，「继续生成」按同一张确认单接着跑 | 上限不变 |
| 重新查询 | 只能命令行 | 详情里对 未知 / 查询放弃 的任务「重新查询」 | 不花钱 |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/server/jobs.ts` | all | 后台任务的写法；要加 `generate` 和 `stop` |
| P0 | `src/cli-generate.ts` | 27–127 | `realDeps`、`assertNoOtherSubmitter`、`cmdGenerate`、`cmdResume`，要抽到共享模块 |
| P0 | `src/generate/runner.ts` | 22–60, 115–135, 315–400 | `runGeneration` 的选项、事件、主循环、`sleep`、预算 |
| P0 | `src/generate/planner.ts` | 60–75, 186–240 | `collectedKeys`、`planGeneration`，要加去重和预览 |
| P0 | `src/server/views/gates.ts` | all | `gateView`、`decideGate`、`checkSelection` |
| P0 | `src/server/views/overview.ts` | 236–290 | `Overview` 类型和 `gate` 字段 |
| P0 | `web/src/components/PaidGateModal.tsx` | all | 确认弹窗 |
| P0 | `web/src/components/StagePipeline.tsx` | 60–110 | 付费卡片 |
| P1 | `src/generate/recovery.ts` | 30–60 | `recoverTasks` 和 `isActive` |
| P1 | `src/repo/media.ts` | 1–80 | `MIME_BY_EXT`、`insideMedia`（没导出） |
| P1 | `src/repo/candidates.ts`, `src/repo/tasks.ts` | all | `candidateOfTask`、`listTasks`、`taskEvents`、`TaskRow` |
| P1 | `src/server/server.ts` | 20–40, 100–145 | CSP、`serveStatic`、`handle` |
| P1 | `src/server/routes/views.ts`, `routes/actions.ts` | all | 路由写法；SSE 那种自己写响应、返回 undefined 的写法 |
| P1 | `src/server/app.ts` | all | `AppConfig`、`withProject`、`sweep` |
| P1 | `src/cli-serve.ts` | 20–50 | 启动流程 |
| P1 | `web/src/api.ts` | all | `useApi`、`useProjectEvents` 的事件列表、`useReloadOnProgress` |
| P1 | `web/src/pages/OverviewPage.tsx` | all | 头部按钮、弹窗回调 |
| P1 | `web/src/components/Shell.tsx` | 60–90 | 侧栏条目 |
| P2 | `web/src/components/ui.tsx`, `overview.module.css` | all | Button、Badge、Dot、表格网格、弹窗样式 |
| P2 | `test/support/server-harness.ts`, `test/support/fake-media.ts`, `test/support/gen-fixture.ts` | all | 测试工具 |
| P2 | `web/e2e/server.ts`, `web/e2e/main-flow.spec.ts` | all | e2e 怎么起服务、付费那一步怎么点 |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| HTTP Range | RFC 9110 §14 | `<video>` 拖进度条要 `Accept-Ranges: bytes` 和 206 `Content-Range`；只支持单段 `bytes=a-b` / `bytes=a-` 就够 |
| CSP media-src | MDN CSP | 没写 `media-src` 时回落到 `default-src 'self'`，同源视频能播；照 5a 计划显式写上 `media-src 'self'`，并把 `img-src` 保持 `'self' data:` |

No other external research needed — 其余都是仓库里已有的写法。

---

## Patterns to Mirror

### 后台任务（照抄 `go` 的写法）
```ts
// SOURCE: src/server/jobs.ts:46-79
private start(projectId: string, kind: JobKind, detail: string, work: () => Promise<unknown>): JobInfo {
  if (this.active.has(projectId)) throw new HttpError(409, `这个项目已有任务在跑（${this.active.get(projectId)!.detail}），等它结束`);
  ...
  bus.publish(projectId, { type: 'job-start', ...info });
go(projectId, mode, only?, fresh?): JobInfo {
  const publish = (e: OrchestrateEvent) => app.bus.publish(projectId, fromOrchestrate(e));
  return this.start(projectId, 'go', ..., () => app.withProject(projectId, async (p) => { ... }));
```

### 路由
```ts
// SOURCE: src/server/routes/views.ts:21-31
route('GET', '/api/p/:id/gates/:gid', ({ app, params }) => app.withProject(params['id']!, (p) => gateView(p, gateId(params['gid'])))),
// 自己写响应的路由返回 undefined（SSE 的写法，媒体文件照这个来）
route('GET', '/api/p/:id/events', async ({ app, params, res }) => { ...; app.bus.subscribe(id, res, {...}); return undefined; }),
```

### 错误
```ts
// SOURCE: src/server/http.ts:9 / src/server/views/gates.ts
throw new HttpError(404, `没有付费确认单 ${id}`);   // 4xx 给页面看的中文原因
throw new Error('...');                              // 普通 Error → 400，带原文
```

### 日志
```ts
// SOURCE: src/server/jobs.ts:56
config.log(`后台任务失败（${projectId} ${detail}）：${message}`);
```

### 数据读取（仓储函数，参数化 SQL）
```ts
// SOURCE: src/repo/tasks.ts:223 / src/repo/candidates.ts:46
listTasks(db, { paidGateId: gate.id });  candidateOfTask(db, taskId);  taskEvents(db, taskId);
```

### 视图类型给前端用
```ts
// SOURCE: web/src/types.ts:1-14
export type { GateView } from '../../src/server/views/gates.ts';
```

### 页面数据与刷新
```ts
// SOURCE: web/src/api.ts:49-121, web/src/pages/OverviewPage.tsx:41-57
const o = useApi<Overview>(projectPath(id, '/overview'));
useProjectEvents(id, (e) => { ... });   // 事件类型必须加进 api.ts 的列表
useReloadOnProgress(id, o.reload, RELOAD_MS);
```

### 前端纯逻辑放 `web/src/*.ts`，用根目录的 node:test 测
```ts
// SOURCE: test/overview-tabs.test.ts
import { overviewTab } from '../web/src/overview-tabs.ts';
test('没点过：运行中看运行记录，空闲看分集全貌', () => { assert.equal(overviewTab(null, true), 'log'); });
```

### 服务端测试
```ts
// SOURCE: test/server.test.ts:339
const h = await startHarness(); t.after(() => h.close());
const project = await dukoProject(h);
const r = await h.call('POST', encodeURI(`/api/p/渡口/gates/${gate.id}`), { body: {...} });
await h.app.jobs.settled('渡口');
```

### 生成测试工具
```ts
// SOURCE: test/generate-runner.test.ts:18
const img = new FakeMediaModel<ImageRequest>('dashscope', 'qwen-image-3.0', 'image', {});
opts = { modelFor: (p) => (p === 'dashscope' ? img : vid), download: fakeDownload(), prices: PRICES, sleep: async () => {}, pollMs: 0, pid: process.pid };
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `designs/ai-short-video-platform.pen` | UPDATE | 新增「生成任务」「生成任务 · 预览」画板；改「全貌视图」的付费卡片和头部；改「付费确认」 |
| `src/generate/session.ts` | CREATE | 从 cli-generate 抽出 `realGenerateDeps`、`assertNoOtherSubmitter`、`generateOnce`、`resumeAll`，命令行和服务共用 |
| `src/cli-generate.ts` | UPDATE | 改用 session.ts |
| `src/generate/planner.ts` | UPDATE | 跨确认单去重：同一指纹已有 collected 的就跳过；导出 `previewGeneration`（只算、不写库） |
| `src/generate/runner.ts` | UPDATE | `sleep` 可以被 signal 打断；汇总里加 `currency: 'CNY'` |
| `src/repo/paid-gates.ts` | UPDATE | `currency` 改成只表示上限的币种：确认时固定写 CNY，没有上限时为 null；估算币种只看 `estimate.currency` |
| `src/repo/media.ts` | UPDATE | 导出 `insideMedia`，新增 `getMedia(db, id)` |
| `src/cli-orchestrate.ts` | UPDATE | `gates` 打印 selection、budgetCap、capCurrency、estimateCurrency |
| `src/server/app.ts` | UPDATE | `AppConfig.generate?: GenerateDeps`（测试注入），默认用真的；`sweep` 在没有后台任务时不碰生成任务（恢复只在启动时做） |
| `src/server/jobs.ts` | UPDATE | `JobKind` 加 `'generate' \| 'resume'`；新增 `generate(projectId, gateId)`、`resume(projectId)`、`stop(projectId)`；把生成事件转成 `gen-task` |
| `src/server/views/generation.ts` | CREATE | `tasksView(project, gateId?)`：各确认单的摘要、选中那张的任务分组和候选；`taskDetail(project, taskId)` |
| `src/server/views/gates.ts` | UPDATE | `gateView` 加 `skip`（会跳过的已生成项和金额）；`decideGate` 确认后自动开跑 |
| `src/server/views/overview.ts` | UPDATE | 新增 `generation` 字段：最近一张已确认确认单的进度 |
| `src/server/routes/views.ts` | UPDATE | `GET /tasks`、`GET /tasks/:tid`、`GET /media/:mid` |
| `src/server/routes/actions.ts` | UPDATE | `POST /generate`（继续生成 / 停止）、`POST /tasks/:tid/requery` |
| `src/server/server.ts` | UPDATE | CSP 加 `media-src 'self'`；`img-src` 不变 |
| `src/server/media-route.ts` | CREATE | 安全地发素材文件：按 id 查、限制在 `media/` 下、带 MIME、支持 Range、`nosniff` |
| `src/cli-serve.ts` | UPDATE | 启动后对每个项目在后台 `resume` |
| `web/src/types.ts` | UPDATE | 导出新视图类型 |
| `web/src/api.ts` | UPDATE | 事件列表加 `gen-task` |
| `web/src/generation.ts` | CREATE | 纯逻辑：状态 → 标签和颜色、分组、进度数字、预览前后切换 |
| `web/src/pages/TasksPage.tsx` + `.module.css` | CREATE | 生成任务页 |
| `web/src/components/TaskDetail.tsx` | CREATE | 右侧详情 |
| `web/src/components/MediaViewer.tsx` | CREATE | 全屏预览 |
| `web/src/components/PaidGateModal.tsx` | UPDATE | 标题编号、跳过项、按钮文案、确认后的提示 |
| `web/src/components/StagePipeline.tsx` | UPDATE | 付费卡片显示进度 |
| `web/src/pages/OverviewPage.tsx` | UPDATE | 头部按钮状态、跳转 |
| `web/src/components/Shell.tsx`, `web/src/main.tsx` | UPDATE | 侧栏条目可用、加路由 |
| `web/e2e/server.ts`, `web/e2e/main-flow.spec.ts` | UPDATE | 注入假的图片和视频模型；e2e 走到确认、出图、在任务页看到缩略图 |
| `test/generation-dedupe.test.ts` | CREATE | 跨确认单去重和预览 |
| `test/server-generation.test.ts` | CREATE | 接口、自动开跑、停止、续跑、媒体文件、启动恢复 |
| `test/generation-view.test.ts` | CREATE | `web/src/generation.ts` 的纯逻辑 |
| `test/paid-gates*.test.ts`, `test/generate-cli.test.ts` | UPDATE | 币种和 `gates` 输出 |
| `docs/generation.md`, `docs/web-ui.md` | UPDATE | 页面上的生成流程、去重规则、恢复行为 |
| `.claude/PRPs/backlog.md` | UPDATE | #30 并入 5b 完成；#31 的 1、2、4、5 条标完成 |

## NOT Building

- **重新生成**（新建任务再出一张）：留给 Phase 6 的「局部重做」，会和审阅三态一起做。5b 只做不花钱的「重新查询」。
- **审阅三态**：合格、选用、不合格，属于 Phase 6。
- **「素材与候选」侧栏页**：也是 Phase 6。
- **角色与美术页的参考图槽位显示真图**：Phase 6。5b 只在生成任务页里看。
- **#31 的其余 4 条**：特写句混进正面全身、估算假设写着挂场景参考、国际区价格表、角色撞色。这些属于提示词和价格范畴，另起计划。
- **页面上改上限或改勾选**：要改就开新确认单。

---

## Step-by-Step Tasks

### Task 1: 设计稿（先做，用户确认后才进 Task 8 以后的前端代码）
- **ACTION**: 用 pencil MCP 在 `designs/ai-short-video-platform.pen` 里改画、新画画板。
- **IMPLEMENT**:
  1. 新画板「生成任务 · Web 1440」：
     - 侧栏「生成任务」高亮，可以复制已有画板的 Sidebar。
     - 头部：确认单切换、进度条、已花和上限、停止或继续按钮。
     - 正文三组：角色参考图（每个角色一行、5 个视图缩略图）、关键帧表、视频段表。
     - 右侧详情：大图、状态时间线、费用、提示词、参考图、失败原因、「重新查询」。
     - 状态都要画到：已完成、生成中、排队、失败、被拒、预算停下。
  2. 新画板「生成任务 · 预览 · Web 1440」：全屏遮罩加大图（或视频播放器），左右切换，底部标出角色、视图和费用。
  3. 新画板「生成任务 · 空 · Web 1440」：还没有已确认的确认单时，引导回全貌去确认。
  4. 改「全貌视图」：付费卡片加进度条和计数；头部加「生成中 x/y · 停止」和「查看任务」。可以复制一份画「生成中」状态，原画板不动。
  5. 改「付费确认」：标题带编号；新增「已生成过的 4 张会跳过（−¥0.85）」提示；按钮改成「确认并开始生成」。
- **MIRROR**: 现有画板的 Sidebar、Main 结构和变量（`bg`、`surface`、`border`、`text-1/2/3`、`accent`、`ok`、`warn`、`err`、`lock`、`font`、`mono`）。不新建颜色。
- **GOTCHA**: 只用 pencil MCP 读写，不能 Read 或 grep 这个文件。改画板前先复制，原画板保留。缩略图用灰底占位，不生成真人图。
- **VALIDATE**: 截图给用户看，用户确认后在计划里记下「设计已确认」。
- **状态**：2026-11-03 画好；**2026-11-04 用户确认「设计稿通过」**。重新生成、同输入重抽推到 Phase 6（已写进 `review-tristate-redo.plan.md` 3b）。画板如下：

  | 画板 | id |
  |---|---|
  | 生成任务 · Web 1440 | `YDDV2` |
  | 生成任务 · 预览 · Web 1440 | `DGMzN` |
  | 生成任务 · 空 · Web 1440 | `jmP8k` |
  | 全貌视图 · 生成中 · Web 1440 | `ddFLX`，复制自 `eox8D`，原画板未动 |
  | 付费确认 · 跳过已生成 · Web 1440 | `J8nFG`，复制自 `H7iol`，原画板未动 |

### Task 2: 抽出共享的生成会话（`src/generate/session.ts`）
- **ACTION**: 把 `cli-generate.ts` 的 `realDeps`、`assertNoOtherSubmitter`、`gateOf` 里「最近一张已确认」那段、`cmdGenerate` 的主体、`cmdResume` 的主体，挪到 `session.ts`。
- **IMPLEMENT**:
  - `export function realGenerateDeps(): GenerateDeps`
  - `export function assertNoOtherSubmitter(p)`
  - `export async function generateOnce(p, gate, deps, {onProgress, signal}): Promise<{recovered, planned: number, skipped: SkippedItem[], summary}>`：依次跑 recover、plan、run。
  - `export async function resumeAll(p, deps, {onProgress, signal, isActive?})`
  - `GenerateDeps` 也从这里导出。
  - `cli-generate.ts` 改成调用这些函数，输出 JSON 保持不变，只多一个 `skipped`。
- **MIRROR**: cli-generate.ts:33–127 原样搬。
- **GOTCHA**: `assertNoOtherSubmitter` 里的 `t.pid !== process.pid` 要保留。服务进程里自己的任务不算「另一个进程」，这一点要靠 Jobs 的锁来保证。
- **VALIDATE**: `node --test test/generate-cli.test.ts` 不改测试也能过。

### Task 3: 跨确认单去重 + 预览（planner）
- **ACTION**: `planGeneration` 跳过「同一指纹已经有 collected 任务」的草稿，同时新增只算不写的 `previewGeneration`。
- **IMPLEMENT**:
  - `function collectedFingerprints(db): Map<string, TaskRow>`：按指纹收已经是 collected 的任务，任何确认单都算。
  - 把 planGeneration 里构造 drafts 的部分抽成 `draftsFor(db, gate, prices)`。
  - `planGeneration`：遇到 `fp.has(contentHash(d.plannedInput))` 就跳过，不建任务。返回值改成 `{ tasks: TaskRow[]; skipped: { node, label, reuse: taskId, costCny }[] }`，调用方一起改。
  - `previewGeneration(db, gate-like {selection, estimate}, prices)`：返回 `{ create: n, skipped: [...] }`，给弹窗用。弹窗时确认单还没确认，所以跳过 `status === 'confirmed'` 检查，单独用一个内部函数。
  - 关键帧和视频的依赖判断仍用 `collectedKeys`，逻辑不变；派生视图在运行时由 `collected()` 去任意确认单里找锚点（runner.ts:141），所以锚点被跳过也不会挡住派生视图。
- **MIRROR**: planner.ts:192–240；`contentHash` 从 `../domain/hash.ts` 导入，和 tasks.ts:148 写指纹的方式一致。
- **GOTCHA**:
  - 指纹包含提示词、尺寸和依赖。改了提示词（比如修了 #31 第 3 条）会得到新指纹，按设计就该重出。
  - `regenerateTask`（manage.ts:26）会故意再出一张，不能受影响：跳过只做在 planner 里，`createTask` 不改。
  - 同一张确认单里已经建过的任务，原逻辑按 `node|label` 认，这条保留。
- **VALIDATE**: 新测试 `test/generation-dedupe.test.ts`：
  1. 确认单 A 出完 C01 锚点，再开确认单 B 勾角色参考图：B 不建 C01 锚点，派生视图照常建，跑完派生视图引用的是 A 的锚点；
  2. 改了 characterRefs 提示词后再开确认单，会重建；
  3. `previewGeneration` 的跳过数和金额对得上；
  4. 原有的 planner、runner 测试全部通过。

### Task 4: 币种字段与 `gates` 输出
- **ACTION**:
  - `paid_gate.currency` 只表示上限的币种：`decideGate` 确认时，有上限就写 `'CNY'`，没有上限就写 null。
  - `createPaidGate` 不再把估算币种写进这个字段，改写 null。
  - 读的地方一律改看 `estimate.currency`。
  - 旧数据：不做迁移，读取时按「`budgetCap === null` 就把 currency 当 null」处理。
  - `GenerateSummary` 加 `currency: 'CNY'`。
  - `cmdGates` 输出 `{ id, status, …, estimateCurrency: g.estimate.currency, total, selection, budgetCap, capCurrency }`，去掉原来那个含义不清的 `currency`。
- **MIRROR**: paid-gates.ts:46–90。
- **GOTCHA**:
  - `decidePaidGate` 里的 `COALESCE(?, currency)` 要改成直接赋值。
  - 前端 `PaidGateModal` 读的是 `est.fx`，没读 `gate.currency`，不受影响。
  - 用 grep 找出所有读 `.currency` 的地方，逐个核对。
- **VALIDATE**: 补测试：确认后 `gates` 输出的 total 带 `estimateCurrency: 'USD'`，`capCurrency: 'CNY'`；没设上限时 `capCurrency` 是 null。

### Task 5: 后台生成任务、停止与启动恢复（服务端）
- **ACTION**: 扩展 `Jobs`，并让 `decideGate` 确认后自动开跑。
- **IMPLEMENT**:
  - `JobKind = 'go' | 'reject' | 'generate' | 'resume'`；Jobs 里加 `private readonly aborts = new Map<string, AbortController>()`。
  - `generate(projectId, gateId)`：
    - 调 `app.withProject` 打开项目，取确认单，必须是 confirmed，否则 400；
    - 调 `generateOnce(p, gate, app.generateDeps(), {onProgress, signal})`；
    - `onProgress` 发布 `{type:'gen-task', gateId, taskId, node, label, status}`；
    - 结束时 `job-end.result` 带 `{gateId, counts, spent, cap, budgetStopped, skipped: n}`。
  - `resume(projectId)`：调 `resumeAll(p, deps, {submit:false})`；没有在途任务就直接结束，不发 job 事件，免得启动时刷屏。
  - `stop(projectId)`：当前任务是 generate 或 resume 时 `abort()`，并发布 `{type:'gen-stop'}`；没有任务回 409。
  - `runner.ts`：默认 `sleep` 改成能被 signal 打断（`setTimeout` + 监听 abort）。只在循环开头检查 signal，不打断正在发的提交请求，避免任务卡在「提交中」。
  - `decideGate`：confirm 成功后调 `app.jobs.generate(id, gateId)`。如果项目已经有后台任务，状态照样改成 confirmed，返回 `{gate, started: false, reason}`，页面提示「已确认，等当前任务结束后到生成任务页点继续生成」。
  - `POST /api/p/:id/generate {action:'continue', gateId}` 对应 `jobs.generate`，`{action:'stop'}` 对应 `jobs.stop`。
  - `POST /api/p/:id/tasks/:tid/requery`：调 `requeryTask`，只允许状态是 unknown、submitted、running 或查询放弃的任务；有后台任务时回 409。
  - `cli-serve.ts`：`startServer` 之后，对 `listProjects` 的每个项目调 `app.jobs.resume(id)`，失败只写日志，不让服务起不来。
  - `AppConfig.generate?: GenerateDeps`；`app.generateDeps()` 返回注入的，没有就懒加载 `realGenerateDeps()`。
- **MIRROR**: jobs.ts:46–79 的 `start` 和 `go`。
- **GOTCHA**:
  - 启动恢复必须走 Jobs，这样有锁、有事件。`recoverTasks` 默认把本进程 pid 的任务当成死的，在 Jobs 锁里跑，就不会和本进程自己的生成撞上。
  - 两个 `serve` 进程同时开着同一个项目：靠 `assertNoOtherSubmitter` 拦下，报错进 `job-end`。
  - 凭据缺失：`realGenerateDeps` 第一次用到时才报错，这个错误要进 `job-end` 的 message，页面上显示「缺少 dashscope 的 key：用 cred set 写入」，不能回显 key。
- **VALIDATE**: `test/server-generation.test.ts`，用 FakeMediaModel：
  1. 确认后自动开跑，`settled` 之后任务都是 collected，SSE 收到 `gen-task`；
  2. 已有后台任务时确认：返回 `started: false`；
  3. 停止：pollsToFinish 设大一点，发停止后任务停在 submitted/running，再「继续」能跑完，提交次数不变；
  4. 预算停下后「继续」不会超过上限；
  5. 启动时 resume 只查询不提交（`submits` 不增加）；
  6. 凭据缺失的报错文案不含 key。

### Task 6: 视图与媒体接口
- **ACTION**: 写 `src/server/views/generation.ts`、`src/server/media-route.ts`，并挂上路由。
- **IMPLEMENT**:
  - `tasksView(project, gateId?)`：
    - `gates`：所有已确认的确认单 `{id, createdAt, decidedAt, selection 摘要, cap, spent, counts, running}`，新的在前。
    - `gate`：选中的那张，默认最新一张。
    - `groups`：
      - `characters: [{ characterId, name, views: [{view, task?: TaskCard}] }]`：5 个视图按固定顺序排，没建任务的视图标成 `skipped`（被去重跳过）或 null。
      - `keyframes: [{ episode, rows: TaskCard[] }]`；
      - `videos: [{ episode, rows: TaskCard[] }]`。
    - `TaskCard = {id, node, label, status, costEstimate, costActual, error, mediaId?, mime?, reuseOf?}`。`reuseOf` 表示被跳过的项沿用的是哪个任务，这样被跳过的视图也能显示出过的那张图。
  - `taskDetail(project, taskId)`：`TaskCard` 加上
    - `events: taskEvents`；
    - `prompt`：取 `actualInput ?? plannedInput` 里的 prompt 和 negative；
    - `refs`：参考图对应的任务卡；
    - `planDiffers`：计划输入和实际输入不一致；
    - `providerTaskId`。
  - `media-route.ts`：`GET /api/p/:id/media/:mid`
    - id 必须是正整数；
    - 用 `getMedia` 查，路径用 `insideMedia` 校验，不在 `media/` 下就 404，不说原因；
    - `content-type` 取 MIME_BY_EXT；`cache-control: private, max-age=31536000, immutable`（文件按哈希命名，内容不会变）；
    - 支持单段 Range，返回 206 和 `Content-Range`，越界返回 416；
    - 加 `x-content-type-options: nosniff`；
    - 流式发送（`createReadStream`），处理器返回 undefined。
    - 只认库里登记过的 media id，不接受任何路径参数。
  - CSP 加 `media-src 'self'`。
  - `overview.ts` 加 `generation: { gateId, running, total, done, failed, spent, cap, byNode: {node, total, done}[] } | null`：取最近一张有任务的已确认确认单。
  - `gateView` 加 `skip: { count, cny, items: {node,label}[] }`，由 `previewGeneration` 用确认单当前的 selection 草稿算出来。弹窗会根据勾选变化重新算，所以要加 `GET /gates/:gid/preview?refs=1&kf=ep1,ep2&video=...`，或者在 gateView 里按节点各返回一份跳过清单，让前端自己合计。**选后者**，省一个接口：`skipByNode: Record<node, {count, cny}>`（关键帧和视频再按集拆开）。
- **MIRROR**: views/gates.ts 的写法；路由照 views.ts:21–31。
- **GOTCHA**:
  - 不允许路径穿越：只按 id 查库，不拼用户给的路径。
  - 视频文件可能有几十 MB，不能 `readFileSync`。
  - GET 不需要令牌（`<img>` 带不了请求头），但 `guard` 的 Host 检查仍然生效，这和现在所有 GET 一致。
- **VALIDATE**: 测试媒体接口：200 且 MIME 正确；Range 返回 206；越界返回 416；不存在的 id 返回 404；`media_file.rel_path` 被改成 `../x` 时返回 404。再测 tasksView 的分组和 reuseOf、overview.generation 的计数。

### Task 7: `docs` 与命令行收尾
- **ACTION**: 更新 `docs/generation.md`（页面上的流程、去重规则、停止的语义、启动恢复）、`docs/web-ui.md`（侧栏「生成任务」，删掉「确认只记录」的说法）。
- **VALIDATE**: 人工读一遍，确认没有与代码不一致的地方。

### Task 8: 前端纯逻辑（`web/src/generation.ts`）——设计确认后才开始
- **IMPLEMENT**:
  - `taskTone(status)`：映射到 ok、run、warn、err、idle。
  - `taskLabel(status)`：中文状态名。
  - `progressOf(counts)`：算 done、total、failed、ratio。
  - `nextPreview(list, currentId, dir)`：预览里左右切换。
  - `viewTitle(view)`：正面全身、正脸大头照之类的视图中文名。
- **VALIDATE**: `test/generation-view.test.ts`。

### Task 9: 生成任务页、详情、全屏预览
- **ACTION**: `TasksPage`、`TaskDetail`、`MediaViewer`，以及路由、侧栏。
- **IMPLEMENT**:
  - 布局照设计稿。
  - 数据用 `useApi(projectPath(id, `/tasks${gate ? `?gate=${gate}` : ''}`))`；收到 `gen-task`、`job-end` 时用 `useReloadOnProgress` 节流刷新。
  - 缩略图直接用 `<img src={projectPath(id, `/media/${mediaId}`)} loading="lazy">`，视频用 `<video controls preload="metadata">`。
  - 右侧详情 `useApi(`/tasks/${tid}`)`。
  - 全屏预览：Esc 关闭，← → 切换，焦点放进弹窗、关闭后还回去，`role="dialog"` 加 `aria-label`。
  - 「停止」「继续生成」「重新查询」都是 POST，失败时 toast 提示。
- **MIRROR**: OverviewPage 的数据、刷新和 toast；`overview.module.css` 的表格网格和弹窗样式；`ui.tsx` 的 Badge、Button。
- **GOTCHA**: 页面最小宽度 1024；缩略图固定宽高比 2:3（角色）或 16:9（关键帧）；不要一次加载全部大图，详情和预览才加载原图。
- **VALIDATE**: `pnpm web:typecheck`、`pnpm web:build`。

### Task 10: 全貌与确认弹窗
- **IMPLEMENT**:
  - **PaidGateModal**：
    - 标题 `确认付费生成 #{gateId}`；
    - 每一组下面显示「已生成过 N 张，跳过（−¥x）」，合计扣掉这部分；
    - 按钮「确认并开始生成」；
    - `onDone` 的文案按 `started` 区分：「已确认，开始生成」或「已确认；当前有任务在跑，结束后到生成任务页点继续生成」。
  - **StagePipeline 付费卡片**：有 `generation` 时，每个节点显示进度条、`done/total` 和失败数，头部写「确认单 #N · 已花 ¥x / 上限 ¥y」；整个卡片是到 `/p/:id/tasks` 的链接。
  - **OverviewPage 头部**：`generation.running` 时显示「生成中 x/y」和「停止」，旁边是「查看任务」；生成任务也算 `running`，这时「重跑文本阶段」不可用。
  - **api.ts**：事件列表加 `gen-task`、`gen-stop`。
- **VALIDATE**: typecheck、build。

### Task 11: e2e
- **IMPLEMENT**:
  - `web/e2e/server.ts`：注入 `generate: { modelFor: 假的图片和视频模型, prices, download: 写入一张 1×1 png 和一个很小的 mp4, sleep 短一点 }`。
  - `main-flow.spec.ts` 在原来的付费那一步之后接着走：
    1. 点「确认并开始生成」；
    2. 全貌卡片出现进度；
    3. 跳到生成任务页，看到缩略图；
    4. 点开详情，打开全屏预览，再按 Esc 关闭。
- **VALIDATE**: `pnpm web:build && pnpm test:e2e`。

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| 去重：已出过的锚点 | 确认单 A collected C01 锚点；确认单 B 勾角色参考图 | B 不建 C01:front-full；skipped 带 reuse=A 的任务 id | |
| 去重：提示词改了 | 改 characterRefs 后开确认单 C | C 重建 C01:front-full | 是 |
| 派生视图引用他单锚点 | 上面的 B 跑完 | 派生视图任务的依赖可用，参考图是 A 的锚点 | 是 |
| previewGeneration | 和上面同样的数据 | create 和 skipped 的数量、金额对得上 | |
| 币种 | 确认时带上限 / 不带上限 | capCurrency 分别是 CNY / null；估算币种仍是 USD | 是 |
| 自动开跑 | confirm | 后台 generate；任务都 collected；有 gen-task 事件 | |
| 有任务时确认 | 先 go 再 confirm | started:false，确认单是 confirmed | 是 |
| 停止和继续 | stop，然后 continue | 提交总数等于任务数，没有重复提交 | 是 |
| 预算 | 上限只够 2 张 | budgetStopped；继续之后还是停在那里 | 是 |
| 启动恢复 | 有 submitted 的任务 | 只查询、下载，submits 不变 | |
| 媒体接口 | 正常、Range、越界、不存在、rel_path 被改成 ../ | 200、206、416、404、404 | 是 |
| tasksView | 跨两张确认单的数据 | 按角色和视图分组，被跳过的视图带 reuseOf 和缩略图 | |
| 前端纯逻辑 | 各种状态和计数 | 颜色、标签、进度、预览切换正确 | |

### Edge Cases Checklist
- [x] 没有已确认的确认单：任务页显示空状态
- [x] 确认单里的任务全部被跳过：直接结束，提示「都生成过了」
- [x] 视频文件大：流式发送加 Range
- [x] 并发：同一项目只跑一个后台任务（409）；两个 serve 进程靠 `assertNoOtherSubmitter`
- [x] 供应商网络失败：沿用 5a 的状态机，页面显示原因
- [x] 凭据缺失：job-end 的报错文案不带 key
- [x] 路径穿越：只按 id 查，`insideMedia` 二次校验

---

## Validation Commands

### Static Analysis
```bash
npm run typecheck && pnpm --dir web typecheck
```
EXPECT: Zero type errors

### Unit Tests
```bash
node --test test/generation-dedupe.test.ts test/server-generation.test.ts test/generation-view.test.ts
```
EXPECT: All tests pass

### Full Test Suite
```bash
npm test && npm run coverage
```
EXPECT: No regressions；行 80% / 分支 70% / 函数 80% 门槛通过

### Build + E2E
```bash
pnpm --dir web build && pnpm --dir web test:e2e
```
EXPECT: 原有 2 条加新流程全部通过

### Browser Validation
```bash
node src/cli.ts serve --root ~/ShortDrama-smoke --port 5170
```
EXPECT:
- 用 `web/scripts/screenshot.mjs` 截图，和设计稿画板对照；
- 冒烟副本上已有的 4 张锚点能在任务页看到。只看图，不花钱。

### Manual Validation（真实出图，花钱，要先问用户）
- [ ] 冒烟副本：在全貌重跑出确认单，勾角色参考图，上限填 10，确认。应该看到：页面直接开跑、C01–C04 的锚点被跳过、32+4 张出完、任务页能看所有图、派生视图和锚点长得像。
- [ ] 中途点「停止」，再点「继续」，应该没有重复提交。
- [ ] 关掉 serve 再开，应该自动续查。

---

## Acceptance Criteria
- [ ] 设计稿用户已确认，页面和设计稿一致
- [ ] 确认后自动开跑；生成任务页能看到每个任务的状态、花费、原因、缩略图，能全屏预览
- [ ] 新确认单不会重复出同样输入的图，弹窗里提前说明会跳过哪些
- [ ] `gates` 输出和确认单的币种含义清楚
- [ ] 所有验证命令通过

## Completion Checklist
- [ ] 后台任务、路由、视图、仓储都照现有写法
- [ ] 错误用 HttpError 和中文原因，不回显凭据
- [ ] 媒体接口只按 id 查库，有路径校验
- [ ] 文档已更新；backlog #30、#31（第 1、2、4、5 条）已改状态
- [ ] 没有做「重新生成」和审阅（Phase 6）

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 生成任务占着项目锁很久（视频要几分钟），这期间文本阶段不能操作 | 高 | 中 | 头部明确显示「生成中」和「停止」；停止只在提交之间生效，等待不超过一次轮询 |
| 指纹去重误跳过：输入相同但用户就想再出一张 | 中 | 低 | 这正是 Phase 6「重新生成」的用途；弹窗里先列出会跳过哪些 |
| 停止时正好卡在提交上，任务停在「提交中」 | 低 | 中 | signal 只在循环开头检查，不打断正在发的提交；万一还是卡住，下次启动恢复时对账 |
| 启动恢复调用真供应商的列表接口，但没有配凭据 | 中 | 低 | 只在有 submitting、submitted、running 任务时才调；失败只写日志 |
| 设计稿里的状态多，前端工作量超出预期 | 中 | 中 | 先做角色参考图分组（当前真实用到的）；关键帧和视频用同一个表格组件 |

## Notes
- 5a 计划里已经说过 5b 要做「设计稿补画」和「CSP media-src」，这里照办。
- `review-tristate-redo.plan.md:32` 说 Phase 5 画的是列表 / 任务视角、Phase 6 画审阅视角，所以这次的页面以任务为中心，不做审阅操作。
- 冒烟副本 `~/ShortDrama-smoke/自由北美-冒烟` 里已经有确认单 #3 和 4 张锚点，正好用来验证去重和任务页。

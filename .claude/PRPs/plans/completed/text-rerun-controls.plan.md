# Plan: 页面上重跑文本——单阶段重跑、只补出图提示词、一次打回多集（backlog #32、#33、#36）

## Summary

在全貌页加三种文本重跑的操作：

- 每个文本阶段卡上都有「重跑」，确认框写明会从头重写和大概费用（#32）；
- 角色卡上有「补提示词」：拿现有角色卡只跑 character-refs、只写 `characterRefs`，不重写角色卡（#33）；
- 打回框能多选集，同一条意见，一个后台任务里一集一集地跑，一集失败不影响别的（#36）。

#33 还会替换掉生成失败提示里的「重跑角色阶段」直达。

## User Story

As a 用平台做 AI 短剧的创作者，I want 在页面上单独重跑任意文本阶段、只补出图提示词、一次打回多集，so that 不用回命令行，也不会因为补提示词把角色卡整份重写、连带 20 集分镜重跑。

## Problem → Solution

**现状**：

- 已经通过的阶段只能用命令行 `go --only`，或者附意见打回（必须写意见）来重跑；
- 补出图提示词只能「重跑角色阶段」：模型会整份重写角色卡，外形跟着变，20 集分镜都要重跑（2026-11-04 自由北美实测）；
- 打回只能一集一集来，还要等上一集跑完。

**改后**：

- 阶段卡上直接重跑；
- 「补提示词」只动 `characterRefs`；
- 打回框多选集，一次提交。

## Metadata
- **Complexity**: Large（后端约 8 个文件，前端约 6 个文件，外加测试和设计稿）
- **Source PRD**: N/A（backlog #32、#33、#36）
- **Estimated Files**: 新增 3 个（`src/orchestrate/refs-only.ts`、两个测试文件），修改约 16 个
- **Branch**: `feat/text-rerun-controls`

---

## UX Design

设计稿：`designs/ai-short-video-platform.pen` 画板「全貌视图 · 阶段重跑与多集打回 · Web 1440」（`R26NLw`）。**等用户确认后才写 `web/` 代码。**

### Before
```
阶段卡：01 大纲 [通过] / novel-outline / 质量门 15/15          ← 没有操作
详情面板：附意见打回 [剧本][站位][分镜] / 意见框 / [打回重跑]  ← 只能打回当前选中的这一集
生成失败提示：「重跑角色阶段」→ 整份重写角色卡
```

### After
```
阶段卡底部：⟳ 重跑  约 ¥0.4–0.8            （角色卡：⟳ 重跑  🖼 补提示词）
  点「重跑」→ 确认「从头重写角色阶段（不按现有内容改），下游会标需复核；约 ¥0.6–1.2。确定？」→ 后台跑
  点「补提示词」→ 确认「只给出图角色补出图提示词，不改角色卡正文；外形不变，分镜不会因此需复核。确定？」
详情面板：附意见打回 [剧本][站位][分镜]
          打回哪几集（可多选，同一条意见）  01 [02] 03 [04] [05] 06
          意见框
          依次重跑第 02、04、05 集                       [打回重跑]
  跑完 toast：「打回分镜：第 02、04 集通过，第 05 集失败（DeepSeek 余额不足）」
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 阶段卡 | 只显示状态 | 底部「重跑 · 约 ¥x」，角色卡另有「补提示词」 | 有后台任务时置灰，悬停说明原因（沿用 #35 的 busyReason） |
| 确认框 | 只有「整份重写」才确认 | 阶段卡重跑一律确认，写明从头重写、下游需复核、费用 | 用 `window.confirm`，同现有 `rerunRequest` |
| 打回框 | 只针对选中的那一集 | 按集算的阶段（剧本、站位、分镜）可多选集，默认勾上选中的那一集 | 大纲、角色、美术是整份负责的，不显示集选择 |
| 生成失败直达 | 「重跑角色阶段」（整份重写） | 「补提示词」（只补 characterRefs） | `remedyFor` 改 |
| 命令行 | `go --only cast` | 新增 `refs <dir>` | |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/executor/character-refs.ts` | 10-110 | `refsKit`、`characterRefsFor`；intake 会调文本模型（`ctx.ask('refs:<id>')`） |
| P0 | `src/executor/stage-recipes.ts` | 48-114 | `cardFrom` 剥掉模型交回的 characterRefs；`withCharacterRefs` 补回；`novelCharacters.run` 的步骤 |
| P0 | `src/executor/run-node.ts` | 26-63, 150-170, 211-243, 343-357, 402-420, 502-600 | RunNodeOptions、prepare（base 只在 revise 或 episodes 时取）、ask 注入 revise note、companion、resumeKey、execute 与 runNode |
| P0 | `src/orchestrate/revisions.ts` | 14-53 | `resolveEpisode`、`checkReject`、`reject` |
| P0 | `src/orchestrate/review-matrix.ts` | 25-70 | `pendingCells`、`acknowledge`、`lastRuns`（episode_key 按逗号拆） |
| P1 | `src/import/projections/cast.ts:38`、`storyboard.ts:36` | — | 角色投影是整张卡（含 characterRefs），分镜每切钉角色的 cast 版本 → 只补 characterRefs 也会让分镜需复核 |
| P1 | `src/estimate/usage.ts` | 15-90, 183 | `measuredText`（取最近一次通过的运行用量）、`text:<stage>` 节点 |
| P1 | `src/server/jobs.ts`、`src/server/routes/actions.ts` | 全部 | `go`、`reject` 任务和路由；`busyReason` 的任务说明 |
| P1 | `web/src/components/StagePipeline.tsx` | 44-80, 221-260 | `StageCardView`、`cny` 帮手 |
| P1 | `web/src/components/DetailPanel.tsx` | 30-81 | `RejectForm` |
| P1 | `web/src/reject.ts`、`web/src/rerun.ts`、`web/src/generation.ts` | 全部 | `rejectChoices` / `rejectScope`、`rerunRequest`、`remedyFor` |
| P2 | `src/cli-nodes.ts` | 12-23, 66-112 | `cmdRun`、COMMANDS、NODE_USAGE |
| P2 | `test/character-refs-recipe.test.ts`、`test/revisions.test.ts`、`test/reject-form.test.ts`、`test/server.test.ts:400-430` | — | 测试写法 |

## External Documentation

No external research needed — 都是仓库里已有的写法。

---

## 关键决定

1. **#33 只补 characterRefs 时，角色卡会换版本，分镜照样被标需复核。** 原因是角色投影（`projections/cast.ts:38`）把整张卡当作角色的版本内容。

   **做法**：补完以后，把**这次运行新冒出来**的需复核格子自动标成已复核，备注「只补出图提示词，外形没变」。具体是运行前后各取一次 `pendingCells`，只确认新增的那些，原来就需复核的不动。

   **不选的办法**：改投影、排除 characterRefs。那会让所有已有项目的角色版本一次性全部升级，而且属于 #34 的范围（按内容判断要不要复核）。

2. **#33 的实现方式是给 runNode 加一个选项 `refsOnly`。** `NodeRun`、`prepare` 是模块私有的。这样补提示词也算一次角色阶段运行：有 `node_run`、`node_attempt`、费用记录，产物照常导入。
   - 角色配方在 `refsOnly` 时跳过 seed、逐卡问模型、summary、质量门，直接 `withCharacterRefs(ctx, base 的角色卡, base 的角色卡)`，再把 characterRefs 补回到 base 上；
   - 不带 revise note（`ask` 会把 note 注入每个提示词）；
   - `prepare` 在 `refsOnly` 时也取 base；
   - `resumeKey` 带上 `refsOnly`。
   - 估算：`measuredText` 要排除「只有 refs: 步骤」的运行，否则补提示词的小用量会被当成整个角色阶段的用量，估低。

3. **#32 的阶段卡重跑沿用现有的 `POST /go {only}`。** 单阶段重跑本来就是从头写（`planStage` 在 only 时返回 all，不带 base）。阶段卡上不放「整份重写」勾选，详情面板里那个保留。确认框写明「从头重写，不按现有内容改，下游会标需复核」，并写出 `text:<stage>` 的估算区间（人民币）。

4. **#36 是一个任务里依次跑**：`rejectMany` 对每一集调一次现有的 `reject()`。
   - 每集一条打回记录，`revision_request.episode_key` 仍是单集，不动表结构；
   - 一集失败就记下原因、接着跑下一集；
   - 返回逐集结果 `{episode, ep, status, runId, error}`。
   - 任务说明是「打回分镜（第 02、04、05 集）」。
   - 不用 `runNode(episodes:[…])` 一次跑多集：那样一集失败会拖累整次运行，打回记录也要改成多集。

5. **逐集进度**：每集是独立的一次运行，运行记录里自然逐集出现，不新增事件类型。任务结束时 `job-end.result.episodes` 带逐集结果，全貌据此弹一句汇总。

---

## Patterns to Mirror

### 后台任务（jobs.ts）
```ts
// SOURCE: src/server/jobs.ts reject()
reject(projectId: string, stage: Stage, note: string, episode?: string, epNo?: number): JobInfo {
  const which = !episode ? '全部集' : epNo !== undefined ? `第 ${String(epNo).padStart(2, '0')} 集` : `集 ${episode}`;
  return this.start(projectId, 'reject', `打回${STAGE_TITLES[stage]}（${which}）`, () => app.withProject(projectId, async (p) => { ... }));
```

### 路由校验
```ts
// SOURCE: src/server/routes/actions.ts /go
if (fresh !== undefined && typeof fresh !== 'boolean') throw new HttpError(400, 'fresh 应该是 true 或 false');
```

### 补回 characterRefs
```ts
// SOURCE: src/executor/stage-recipes.ts:54-70 withCharacterRefs(ctx, cards, baseCards) → (doc) => ({...doc, characters: listOf(doc,'characters').map(put)})
```

### 复核确认
```ts
// SOURCE: src/orchestrate/review-matrix.ts:62 acknowledge(db, stage, episodeKey, note)
```

### 前端纯逻辑 + 根目录 node:test
```ts
// SOURCE: test/reject-form.test.ts、test/generation-view.test.ts
import { rejectScope } from '../web/src/reject.ts';
```

### 测试写法
```ts
// SOURCE: test/revisions.test.ts
const { project, cleanup } = tempProject(); await setupNovel(project); importAll(project);
const r = await reject(project, 'script', { model: dukoModel(), episode: '3', note: '汽笛提前', prices: null });
// SOURCE: test/character-refs-recipe.test.ts — isIntakeAsk(user, name) 认出 intake 提问；listAttempts 看步骤名
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/executor/run-node.ts` | UPDATE | `RunNodeOptions.refsOnly`；prepare 取 base；RecipeContext 带 refsOnly；resumeKey |
| `src/executor/recipe-kit.ts` | UPDATE | `RecipeContext.refsOnly` |
| `src/executor/stage-recipes.ts` | UPDATE | 角色配方 refsOnly 分支 |
| `src/orchestrate/refs-only.ts` | CREATE | `fillCharacterRefs(project, opts)`：跑 refsOnly 角色运行 + 只确认新冒出来的需复核格子 |
| `src/estimate/usage.ts` | UPDATE | `measuredText` 排除只有 refs: 步骤的运行 |
| `src/orchestrate/revisions.ts` | UPDATE | `checkRejectMany`、`rejectMany` |
| `src/server/jobs.ts` | UPDATE | `refs(projectId)`；`rejectMany` 的任务说明与逐集结果 |
| `src/server/routes/actions.ts` | UPDATE | `POST /api/p/:id/refs`；`/reject` 接受 `episodes: string[]`（与 `episode` 二选一） |
| `src/cli-nodes.ts` | UPDATE | `refs <dir>` 子命令 |
| `web/src/rerun.ts` | UPDATE | `stageRerunConfirm(stage, cny)`、`refsConfirm()` |
| `web/src/generation.ts` | UPDATE | `remedyFor` 改为补提示词：`{ path: '/refs', ... }` |
| `web/src/remedy-action.ts` | UPDATE | 按 remedy 的 path 发请求 |
| `web/src/reject.ts` | UPDATE | 多集的范围文字 `rejectScope({ episodes })` |
| `web/src/components/StagePipeline.tsx` | UPDATE | 阶段卡底部操作行（重跑、补提示词、费用、busy 置灰） |
| `web/src/components/DetailPanel.tsx` | UPDATE | RejectForm 多选集 |
| `web/src/pages/OverviewPage.tsx` | UPDATE | 传 onRerun / onRefs、job-end 汇总 toast |
| `web/src/components/overview.module.css` | UPDATE | 阶段卡操作行、集选择 |
| `test/refs-only.test.ts` | CREATE | #33 |
| `test/reject-many.test.ts` | CREATE | #36 |
| `test/server.test.ts`、`test/reject-form.test.ts`、`test/generation-view.test.ts`、`test/estimate*.test.ts` | UPDATE | 路由、前端纯逻辑、估算 |
| `docs/web-ui.md`、`docs/node-protocol.md`（若提到角色配方步骤） | UPDATE | |
| `.claude/PRPs/backlog.md` | UPDATE | #32、#33、#36 改状态 |

## NOT Building
- #34（需复核按内容判断）：不改投影；#33 用「只确认新冒出来的格子」绕开。
- 阶段卡上的「整份重写」勾选：单阶段重跑本来就是从头写；详情面板的保留。
- 多集打回的排队、并行：依次跑，同一时刻仍只有一个后台任务。
- 打回框里给多集分别写不同意见。
- 生成任务页「继续生成」的事先置灰（#35 留下的缺口）。

---

## Step-by-Step Tasks

### Task 1: 设计稿（已画，等确认）
- 画板 `R26NLw`。用户确认后才写 Task 6 之后的 `web/` 代码。

### Task 2: #33 后端——refsOnly 运行
- **ACTION**: 在 run-node 和角色配方里加 refsOnly 分支。
- **IMPLEMENT**:
  - `RunNodeOptions.refsOnly?: boolean`；`prepare` 在 `opts.refsOnly` 时也取 base（只对 cast 有效，其他阶段报错「只补出图提示词只对角色阶段有效」）；
  - `RecipeContext.refsOnly`；
  - `novelCharacters.run`：`if (ctx.refsOnly) { const cards = listOf(ctx.base,'characters'); const attach = await withCharacterRefs(ctx, cards, mapByName(cards)); return attach(ctx.base); }`；
  - `resumeKey` 带上 refsOnly；
  - 不传 revise。
- **GOTCHA**:
  - `ask()` 会把 `opts.revise?.note` 注入每个提示词，refsOnly 不能带 revise；
  - base 没有角色卡（项目还没跑过角色阶段）时报错「还没有角色卡，先跑角色阶段」；
  - 补回后的文档除 characterRefs 外必须和 base 一模一样。
- **VALIDATE**: `test/refs-only.test.ts`：
  1. 角色卡正文不变，只多了或换了 characterRefs；
  2. 模型只收到 `refs:` 步骤的提问；
  3. 有运行记录和费用；
  4. 不是角色阶段时报错。

### Task 3: #33 编排——补完只确认新冒出来的需复核
- **ACTION**: `src/orchestrate/refs-only.ts` 的 `fillCharacterRefs(project, opts)`。
- **IMPLEMENT**: `before = new Set(pendingCells(db).map(cellKey))` → `runNode(project, 'cast', { ...opts, refsOnly: true })` → 通过后，`pendingCells(db)` 里不在 before 中的格子逐个 `acknowledge(db, stage, episode, '只补出图提示词，外形没变')`。返回 `{ outcome, acknowledged: n }`。
- **GOTCHA**: 原来就需复核的格子不能被顺手确认掉。
- **VALIDATE**:
  1. 分镜原本不需复核：补完后仍是 0 项；
  2. 分镜原本就有需复核：补完后那些还在。

### Task 4: #33 估算、服务、命令行
- `measuredText`：取「最近一次通过、且有非 refs: 步骤」的运行。
- `Jobs.refs(projectId)`：kind `go`，说明「补出图提示词」，调 `fillCharacterRefs`，`modelFor(p, 'cast')`。
- `POST /api/p/:id/refs`：有任务时 409。
- 命令行 `refs <dir>`：照 `cmdRun` 的写法，模型取 `text:cast`。
- **VALIDATE**:
  1. 服务端测试：返回任务说明「补出图提示词」，跑完角色卡带 characterRefs，待处理不增加；
  2. 估算测试：补提示词的运行不影响 `text:cast` 的估算；
  3. 命令行测试：退出码和输出。

### Task 5: #36 后端——rejectMany
- `checkRejectMany(db, stage, { episodes, note })`：每集过 `resolveEpisode`、去重，阶段必须是按集算的；没有集时报错。
- `rejectMany(project, stage, { episodes, note, ...run })`：依次 `reject(...)`。某集抛错就记 `{status:'failed', error}`，接着跑下一集。返回 `{ episodes: [{episode, ep, status, runId, error}], pending }`。
- `/reject` 路由：body 可以是 `episode`（单集，照旧），也可以是 `episodes: string[]`（多集）；两者都给时报 400。
- `Jobs.reject` 改为接受集列表：说明「打回分镜（第 02、04、05 集）」，`job-end.result.episodes` 带逐集结果。
- **VALIDATE**: `test/reject-many.test.ts`：
  1. 三集依次跑，各自一条打回记录、一次运行；
  2. 第二集模型报错（假模型抛 402），第一、三集仍然通过；
  3. 大纲（整份负责）报错；
  4. 重复的集去重；
  5. 路由 `episodes` 与 `episode` 同时给时 400。

### Task 6: 前端纯逻辑（设计确认后）
- `web/src/rerun.ts`：
  - `stageRerunConfirm(stage, cny: {low, high} | null)` 返回确认语；
  - `refsConfirm()` 返回补提示词的确认语。
- `web/src/reject.ts`：`rejectScope` 支持多集，返回「依次重跑第 02、04、05 集」。
- `web/src/generation.ts`：`remedyFor` 返回 `{ label: '补提示词', path: '/refs', body: {}, confirm }`；`web/src/remedy-action.ts` 按 path 发请求。
- **VALIDATE**: 根目录 node:test，先改测试、跑红。

### Task 7: 阶段卡操作行
- `StageCardView` 加 `cost`（`cny(estimate.nodes.find(n => n.node === 'text:'+stage)?.cost, fx)`）、`busy`、`onRerun`、`onRefs`（只给角色卡）。
- 置灰和悬停用 `busy`（busyReason）。
- 阶段正在跑（state === 'running'）时不显示操作行。

### Task 8: 打回框多选集
- `RejectForm`：当前阶段按集算、且选中了某一集时，显示 01…N 的集选择，默认只勾选中的那一集；
- 提交时多于一集就发 `episodes`，只有一集照旧发 `episode`。

### Task 9: 全貌页
- 传 `onRerun` / `onRefs` / `busy`。
- 收到 `job-end`，且 `kind === 'reject'`、`result.episodes` 有多集时，toast 汇总；有失败时用错误样式。

### Task 10: e2e、文档、backlog
- e2e：在主流程里加一步「阶段卡重跑大纲」，确认后能看到任务说明。
- 写文档；backlog 的 #32、#33、#36 标为已完成。

---

## Testing Strategy

| Test | Input | Expected |
|---|---|---|
| refsOnly 只动 characterRefs | 渡口项目，角色卡去掉 characterRefs，补提示词 | 角色卡其余字段与之前逐字相同，8 个出图角色都有 characterRefs |
| refsOnly 不问整卡 | 同上 | 模型请求的步骤名都以 `refs:` 开头 |
| 只确认新冒出来的需复核 | 分镜原本 0 项需复核 | 补完后仍 0 项 |
| 原有的需复核保留 | 先改剧本让第 1 集分镜需复核，再补提示词 | 第 1 集仍需复核 |
| 估算不被拉低 | 先整跑角色阶段，再补提示词 | `text:cast` 估算取整跑那次的用量 |
| 多集依次跑 | 剧本第 1、2、3 集 | 3 条打回记录、3 次运行，逐集结果都通过 |
| 一集失败不连累 | 第 2 集假模型抛 402 | 第 1、3 集通过，结果里第 2 集是 failed 并带原因 |
| 路由参数 | `episode` 和 `episodes` 同时给；`episodes` 为空 | 400 |
| 阶段卡确认语 | stage=cast，cny={0.6,1.2} | 含「从头重写」「需复核」「¥0.6–1.2」 |

### Edge Cases Checklist
- [ ] 还没有角色卡时补提示词：报错说先跑角色阶段
- [ ] 没有出图角色（全是功能角色）：补提示词直接通过，什么都不改
- [ ] 补提示词时 character-refs 没注册：报现有的错误
- [ ] 多选集里有一集被删了（大纲改过）：checkRejectMany 报哪一集不存在
- [ ] 有后台任务在跑：所有新按钮置灰并说明原因，接口 409

---

## Validation Commands

```bash
npx tsc -p . && pnpm --dir web typecheck
node --test test/refs-only.test.ts test/reject-many.test.ts test/reject-form.test.ts test/generation-view.test.ts
npm test && npm run coverage
pnpm --dir web build && pnpm --dir web test:e2e
```

### Manual Validation（用户在自由北美上）
- [ ] 角色卡「补提示词」：角色卡正文不变，分镜不会因此需复核（会调 DeepSeek，花一点钱）
- [ ] 阶段卡「重跑」：确认框文字和费用对
- [ ] 打回框多选两集分镜：依次跑完，toast 汇总

## Acceptance Criteria
- [ ] 设计稿用户已确认，页面与设计稿一致
- [ ] 三个功能可用，测试先红后绿
- [ ] 所有验证命令通过
- [ ] code-reviewer 没有 CRITICAL 或 HIGH 遗留

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 自动确认需复核误伤了原本就要复核的格子 | 中 | 中 | 只确认运行前后差集；有测试 |
| 补提示词时 intake 底稿用了旧 intake，提示词变化不大 | 低 | 低 | 这正是想要的（外形不变） |
| 多集打回跑很久，期间别的操作都被锁住 | 中 | 低 | 任务说明写明是哪几集；置灰有原因（#35） |
| 阶段卡上点重跑太容易误触，导致花钱 | 中 | 中 | 一律确认，并写明费用 |

## Notes
- 「补提示词」也算一次角色阶段运行，所以运行记录、费用、「角色阶段最近一次运行」都会有它。估算要排除它（Task 4）。
- #34 做完以后，Task 3 的「自动确认新冒出来的格子」可以去掉。

# Plan: 一键编排、打回重跑与「需复核」（PRD Phase 4a）

## Summary
在 Phase 2 执行器之上做编排：按阶段依赖一键跑完全部文本阶段（大纲 → 角色 ∥ 美术 ∥ 剧本 → 站位 → 分镜），在付费阶段之前停下并生成「付费确认单」（引用 Phase 3 的估算）。补齐 novel-characters / art / staging / storyboard 的专用配方，并补上 staging → storyboard 的衔接（开场走位句由平台注入并作为平台门检查）。支持对单个阶段、单集附意见打回重跑；上游变了的下游，按集精确标出「需复核」。本计划只做后端与 CLI；界面在 Phase 4b。

## User Story
作为作者，我希望输入梗概后一条命令跑完从大纲到分镜的全部文本阶段，并能对不满意的一项附上意见只重跑它，平台告诉我它影响了下游哪些集，从而在全貌上审阅而不是在对话里推进。

## Problem → Solution
每个阶段要手动 `run`，阶段之间靠人判断顺序；改了上游不知道下游哪些要重做 → 编排器按依赖自动推进、并行跑可并行的阶段；打回带意见进提示词；「需复核」按集计算并可一键重跑受影响的部分。

## Metadata
- **Complexity**: XL（拆成 4a 后端 / 4b 界面两份计划，本份约 18 个文件）
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`
- **PRD Phase**: Phase 4 一键编排与全貌视图（4a：编排与重跑）
- **Depends**: Phase 2（执行器、配方、run 表）、Phase 3（预设、估算）
- **Estimated Files**: 新建 ~12，修改 ~6

---

## UX Design

### Before
```
$ cli run duko outline … ; cli run duko cast … ; cli run duko art … ; …（每步手动、自己排顺序）
改了剧本第 3 集 → 不知道站位、分镜哪些要重跑
```

### After
```
$ cli go duko                              # 一键跑完文本阶段
  ▸ outline ✓ 15/15
  ▸ cast ✓ · art ✓（重试 1 次）· script ✓     （三者并行）
  ▸ staging ✓ · storyboard ✗ 第 4 集 1 门未过 → needs_human
  ■ 停在付费阶段之前：确认单 #1，预估 $10.7–12.4（小成本验证）
$ cli reject duko script --ep 3 --note "汽笛提前到陆行远掏砚之前"
  ▸ script 第 3 集重跑 ✓
  需复核：staging 第 3 集（3 场）、storyboard 第 3 集（5 段）
$ cli go duko --only-stale                 # 只重跑受影响的部分
$ cli review duko staging --ep 3 --keep    # 或者：看过了，保持现状
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 推进阶段 | 手动逐个 run | `go` 按依赖自动推进 | 并行跑无依赖的阶段 |
| 付费前 | 无 | 自动停下并生成确认单 | 确认动作本身在 Phase 5 执行生成 |
| 打回 | 无 | `reject <stage> [--ep] --note` | 意见进提示词，记在 run 上 |
| 下游影响 | 只有 `stale` 引用清单 | 按阶段 × 集的「需复核」矩阵 | 全貌表格的数据来源 |
| 复核 | 只能重新导入 | `review --keep` 记「看过了，保持」 | 不重跑也能消除标记 |

---

## Mandatory Reading

| Priority | File | Why |
|---|---|---|
| P0 | `.claude/PRPs/plans/node-protocol-skill-mount.plan.md` | 配方、执行器、run 表、提示词装配 |
| P0 | `.claude/PRPs/plans/model-adapters-presets-cost.plan.md` | `resolveNodeModel`、`estimateProject` |
| P0 | `src/repo/lineage.ts` | `findStaleRefs`：「需复核」的底层数据 |
| P0 | `src/import/import-artifact.ts` | 按集导入（覆盖范围按集 id）——单集重跑就是只含该集的批次导入 |
| P1 | 上游 `novel-characters/SKILL.md`、`novel-art/SKILL.md`、`novel-staging/SKILL.md`、`novel-storyboard/SKILL.md` 及各 `references/*-pass.md` | 四个专用配方的步骤 |
| P1 | 上游 `novel-staging` 的 `blocking` 命令 | 开场走位句的来源 |

## External Documentation
No external research needed — feature uses established internal patterns and the upstream skills' own CLIs.

---

## Patterns to Mirror
沿用 Phase 2 计划的全部模式。本阶段补充：

### STALE_QUERY
```ts
// SOURCE: src/repo/lineage.ts（Phase 1）
export function findStaleRefs(db: DatabaseSync): StaleRef[]
// 每条：from {kind,key,facet,v}、role、to {kind,key,facet}、pinnedV、currentV
```
「需复核」矩阵在它之上按 (下游阶段 = from.facet, 集 = from 版本的 episode_key) 聚合，不新造一套过期判断。

---

## 关键设计

### 1. 阶段依赖图（数据，不写死在流程里）
```ts
export const STAGE_DEPS: Readonly<Record<Stage, { needs: readonly Stage[]; optional: readonly Stage[] }>> = {
  outline:    { needs: [],                    optional: [] },
  cast:       { needs: ['outline'],           optional: [] },
  art:        { needs: ['outline'],           optional: ['cast'] },
  script:     { needs: ['outline'],           optional: ['art'] },
  staging:    { needs: ['script', 'art'],     optional: ['outline'] },
  storyboard: { needs: ['script', 'staging'], optional: ['outline', 'cast', 'art'] },
};
```
- 编排器做拓扑分层，同层并发（`Promise.allSettled`，并发上限默认 3，可配）。
- 某阶段 `needs_human` / `failed`：只阻断依赖它的下游，其余继续；最后汇总。
- 「付费前停下」：文本层全部结束后，调用 `estimateProject` 生成 `paid_gate` 记录（见数据），状态 `awaiting_confirmation`；Phase 5 的生成器只处理已确认的 gate。

### 2. 四个专用配方（替换 Phase 2 的 single-pass）
| 阶段 | 配方 |
|---|---|
| cast | `seed <outline>`（角色骨架）→ 每个角色一遍 `llm`（profile-pass.md + schema.md + sheet.md + 原文/梗概）→ 合并 → `validate <cast> <book.txt>`（book 由 project_input 写进 run 目录）→ platform-gate |
| art | `seed <outline>` → `llm` 场景（scene-pass.md）→ `llm` 道具（prop-pass.md）→ 合并 → `validate [--cast]` → platform-gate |
| staging | `seed <script> --art --outline` → 每批 ≤3 集 `llm`（read-pass.md 认图 + staging-pass.md 排位）→ 合并 → `ids`（若有）→ `validate --script --art` → platform-gate |
| storyboard | `seed <script> --eps a-b` → 运行 `novel-staging blocking <staging>` 取每场开场走位句 → 每批 ≤2 集 `llm`（storyboard-pass.md + shot-writing.md + frame.md + h3-prompt.md + schema.md + 骨架 + 走位句）→ 合并 → `ids --script` → `validate --script --outline --cast --art` → **staging-carry 平台门** → platform-gate |

**staging-carry 平台门**（补上 PRD 指出的断点）：对每个有站位的场次，该场第一段的 `blocking` 必须包含站位给出的开场走位句（规范化空白后做包含判断）；不满足时违规原文写「段 sg_… 的 blocking 没有照抄站位的开场走位：『…』」，进入修复循环。

### 3. 单集与单阶段重跑
- `reject <stage> [--ep <ep_id|集号>] --note "<意见>"`：
  - 建一条 `revision_request`（阶段、集、意见、目标产物版本）。
  - 重跑该阶段；带 `--ep` 时配方只处理该集（剧本 / 站位 / 分镜都按集批次），导入时覆盖范围只有这一集（Phase 1 改键后按集 id 负责，其他集不受影响）。
  - 意见以「【作者意见】」段进入提示词，同时给出该集的当前版本作为「改这一版」的底稿（而不是从空白重写）。
  - 大纲、角色、美术不支持 `--ep`（整份负责），带了就报错说明。
- `go --only-stale`：只重跑「需复核」矩阵里有标记的 (阶段, 集)，按依赖顺序。

### 4. 「需复核」矩阵
`reviewMatrix(db)` → `{ stage, episode: ep_id | null, reasons: StaleRef[], acknowledged: boolean }[]`：
- 来源：`findStaleRefs` 按 from 的阶段与 episode_key 聚合；跨集共用对象（站位认图的地点）归到 `episode: null`。
- `review <stage> [--ep] --keep`：写 `review_ack`（阶段、集、确认时各引用目标的版本快照）。当前过期引用的目标版本都 ≤ 快照里记的版本时视为已确认；上游再变就重新出现。**不改动** ref 表（保持「过期现算」原则）。
- 矩阵同时带出每格的最新 run 状态（passed / needs_human / failed / running），供全貌表格直接使用。

### 5. 数据（迁移 v5）
```sql
CREATE TABLE orchestration (
  id INTEGER PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('all','only-stale','single')),
  status TEXT NOT NULL CHECK (status IN ('running','done','blocked','failed')),
  started_at TEXT NOT NULL, ended_at TEXT, summary TEXT CHECK (summary IS NULL OR json_valid(summary))
) STRICT;
ALTER TABLE node_run ADD COLUMN orchestration_id INTEGER REFERENCES orchestration(id);
ALTER TABLE node_run ADD COLUMN episode_key TEXT;            -- 单集重跑时
ALTER TABLE node_run ADD COLUMN revision_request_id INTEGER REFERENCES revision_request(id);

CREATE TABLE revision_request (
  id INTEGER PRIMARY KEY, stage TEXT NOT NULL, episode_key TEXT, note TEXT NOT NULL,
  base_artifact_version_id INTEGER REFERENCES artifact_version(id), created_at TEXT NOT NULL
) STRICT;

CREATE TABLE review_ack (
  id INTEGER PRIMARY KEY, stage TEXT NOT NULL, episode_key TEXT,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),       -- {targetVersionId: v, …}
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
) STRICT;

CREATE TABLE paid_gate (
  id INTEGER PRIMARY KEY, orchestration_id INTEGER REFERENCES orchestration(id),
  status TEXT NOT NULL CHECK (status IN ('awaiting_confirmation','confirmed','cancelled')),
  estimate TEXT NOT NULL CHECK (json_valid(estimate)),       -- estimateProject 的完整结果（含价格来源）
  selection TEXT CHECK (selection IS NULL OR json_valid(selection)),  -- 确认时勾选的节点 × 集
  budget_cap REAL, currency TEXT, created_at TEXT NOT NULL, decided_at TEXT
) STRICT;
```
（`revision_request` 需在 `ALTER TABLE node_run` 之前创建；迁移里按依赖顺序写。）

### 6. 并发与中断
- 同一项目同一时刻只允许一个 orchestration 为 running（库里检查 + 进程内锁）。
- 进程中断：重启时把 running 的 orchestration 标 failed、其下 running 的 run 按 Phase 2 规则标 failed；`go` 会从已通过的阶段之后继续（已 passed 且不在需复核矩阵里的阶段跳过）。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/orchestrate/deps.ts` | CREATE | 依赖图与拓扑分层 |
| `src/orchestrate/orchestrator.ts` | CREATE | `go`：分层并发、阻断传播、付费前停下 |
| `src/orchestrate/review-matrix.ts` | CREATE | 需复核矩阵、复核确认 |
| `src/orchestrate/revisions.ts` | CREATE | 打回与单集重跑 |
| `src/executor/recipes.ts` | UPDATE | cast / art / staging / storyboard 专用配方；配方支持「只处理某集」与「底稿 + 意见」 |
| `src/executor/gates/staging-carry.ts` | CREATE | 开场走位照抄的平台门 |
| `src/executor/prompt.ts` | UPDATE | 【作者意见】【底稿】段 |
| `src/db/schema-v5.ts`、`src/db/migrations.ts` | CREATE / UPDATE | 迁移 v5 |
| `src/repo/orchestrations.ts`、`src/repo/paid-gates.ts` | CREATE | 读写 |
| `src/cli.ts` | UPDATE | `go` / `reject` / `review` / `matrix` / `gates` |
| `test/fixtures/skills/…` | UPDATE | 补齐四个 skill 的副本（同 Phase 2 的 UPSTREAM.md 流程） |
| `test/orchestrate.test.ts`、`test/review-matrix.test.ts`、`test/revisions.test.ts`、`test/staging-carry.test.ts` | CREATE | 见测试策略 |

## NOT Building
- 界面（Phase 4b）
- 付费确认后的实际生成（Phase 5）
- 「用户拍板」暂停点之外的人工干预流（例如在骨架阶段停下等确认）——作为 `go --pause-after outline` 留到 4b 有界面后再加
- 分镜级（单段、单切）的文本重跑：最小粒度是「阶段 × 集」

---

## Step-by-Step Tasks

### Task 1: 迁移 v5 与仓储
- **ACTION**: 按关键设计 5 建表；`repo/orchestrations.ts`、`repo/paid-gates.ts`。
- **VALIDATE**: 迁移测试；外键顺序正确。

### Task 2: 依赖图
- **ACTION**: `STAGE_DEPS`、`layers(stages)`、`downstreamOf(stage)`。
- **VALIDATE**: 分层结果 `[[outline],[cast,art,script],[staging],[storyboard]]`；无环检查。

### Task 3: 四个专用配方 + staging-carry 门
- **ACTION**: 按关键设计 2；配方工厂接受 `{ episodes?: string[], note?: string, base?: unknown }`。
- **GOTCHA**: 角色卡 validate 需要原文文件：把 project_input.text 写到 `runs/<id>/in/book.txt`；站位与分镜的批次都按剧本里的集顺序；`blocking` 命令输出格式以上游 USAGE 为准，实施时先跑一次样例确认解析方式。
- **VALIDATE**: 脚本化模型下四个阶段各自一次通过、各自一次修复后通过；staging-carry 用改坏的 duko 分镜（第一段 blocking 改掉）触发违规。

### Task 4: 编排器
- **ACTION**: `orchestrate(project, { mode, only?, concurrency = 3, onProgress })`；分层执行，失败阻断下游；文本层结束后建 `paid_gate`。
- **GOTCHA**: 每个 runNode 自己管 run 记录；编排器只记 orchestration 汇总，不吞掉单个 run 的错误。
- **VALIDATE**: 全过 → 6 个 run passed + 1 个 paid_gate；script needs_human → staging、storyboard 不跑，cast、art 照常；中断后重跑跳过已通过阶段。

### Task 5: 需复核矩阵与复核确认
- **ACTION**: `reviewMatrix(db)`、`acknowledge(db, stage, episode, note)`。
- **VALIDATE**: 导入 duko 全量后改剧本第 3 集的一场 → 矩阵只有 staging/ep3、storyboard/ep3（duko 分镜只有第 1 集时只出 staging）；`acknowledge` 后该格消失；再改上游又出现。

### Task 6: 打回与单集重跑
- **ACTION**: `reject(project, stage, { episode?, note })` → revision_request → runNode（单集模式，底稿 + 意见）。
- **GOTCHA**: 单集导入要构造「只含这一集」的文档（剧本、站位、分镜都是按集负责，其他集不会退役）；大纲 / 角色 / 美术带 `--ep` 直接拒绝。
- **VALIDATE**: 打回剧本第 3 集后：只有第 3 集的场次长出新版本；第 1、2 集版本不变；提示词含意见原文与底稿；矩阵出现第 3 集的下游。

### Task 7: CLI
- **ACTION**: `go <dir> [--only-stale] [--only <stage>] [--concurrency N]`、`reject <dir> <stage> [--ep] --note`、`review <dir> <stage> [--ep] --keep [--note]`、`matrix <dir>`、`gates <dir>`。
- **VALIDATE**: CLI 冒烟（回放模型脚本）。

### Task 8: 文档
- **ACTION**: `docs/orchestration.md`：依赖图、付费前停下、打回与复核语义、staging-carry 门。

---

## Testing Strategy

| Test | 场景 | 期望 |
|---|---|---|
| 一键全过 | 脚本化模型按阶段吐 duko 产物（去 id） | 6 阶段 passed，cast/art/script 同层并发，paid_gate 生成且估算含视频秒数 |
| 中途转人工 | storyboard 三次都违规 | storyboard needs_human，orchestration blocked，paid_gate 仍生成（文本部分已到头）并在 summary 标出未完成阶段 |
| 阻断传播 | script failed | staging、storyboard 未执行，原因写「上游 script 未通过」 |
| 断点续跑 | 第一次在 staging 中断 | 第二次 `go` 跳过 outline/cast/art/script |
| 单集打回 | reject script --ep 第3集 | 只有第 3 集新版本；矩阵出现第 3 集下游 |
| only-stale | 上例后 `go --only-stale` | 只跑 staging/ep3（及 storyboard/ep3 若有） |
| 复核确认 | acknowledge 后上游再改 | 标记先消失后重现 |
| staging-carry | blocking 未照抄 | 违规进入修复循环 |
| 并发锁 | 同时两个 orchestrate | 第二个报「已有编排在运行」 |

### Edge Cases Checklist
- [x] 没有 project_input 就 `go` → 报错提示 `input`
- [x] 只有部分阶段挂载 → 未挂载阶段报「未挂载」并阻断其下游
- [x] 分镜只覆盖部分集（duko 样例只有第 1 集）→ 矩阵与估算按实际覆盖计算
- [x] `--ep` 用集号或集 id 都能识别；集号歧义（插集后）以当前大纲为准

---

## Validation Commands
```bash
pnpm typecheck
node --test test/orchestrate.test.ts test/review-matrix.test.ts test/revisions.test.ts test/staging-carry.test.ts
pnpm test && pnpm coverage
```

### Manual Validation（Phase 4 success signal 的后端部分）
- [ ] 真实模型：`input` 一个梗概 → `go` → 停在付费前，6 个阶段都有产物，`checkup` 全过
- [ ] `reject script --ep 3 --note …` → `matrix` 只显示第 3 集下游 → `go --only-stale` 后矩阵清空
- [ ] 全程没有对话推进（只有 CLI 命令）

---

## Acceptance Criteria
- [ ] `go` 一条命令从梗概跑到分镜并停在付费前
- [ ] 四个专用配方 + staging-carry 门工作，PRD 指出的 staging → storyboard 断点补上
- [ ] 单阶段、单集打回带意见重跑，其他集不受影响
- [ ] 需复核矩阵按阶段 × 集给出，确认与重跑都能消除标记
- [ ] 类型检查、测试、覆盖率通过

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 分镜提示词很长（多个参考文件 + 剧本 + 走位） | H | M | 每批 ≤2 集；参考文件只给本遍需要的 |
| 并发调用触发供应商限流 | M | M | 并发上限可配；适配器已有 429 重试 |
| 「需复核」被频繁触发（上游小改动） | M | M | 复核确认（--keep）不重跑；矩阵给出具体原因 |
| 单集重跑后集级内容与整份文档不一致（例如剧本总时长） | M | L | 重跑后对整份文档跑一次 validate（只报告，不阻断），结果显示在全貌 |

## Notes
- 全貌界面（4b）完全基于本计划的 `reviewMatrix`、run / orchestration / paid_gate 数据，不另做查询。

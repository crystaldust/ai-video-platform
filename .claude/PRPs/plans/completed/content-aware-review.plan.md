# Plan: 需复核按内容判断（backlog #34）

## Summary

现在的需复核判断是机械的：下游钉的上游版本不是当前版本，就算过期。改成按内容判断：
- 给每种引用（下游侧面 + 身份 + 上游侧面）声明「下游实际读上游的哪些字段」；
- 比较「钉住的版本」和「当前版本」在这些字段上的取值，相同就不算过期。

不需要迁移：两版的 payload 都在 `entity_version` 里，现算即可，旧的引用记录照常工作。做完后，#33 `fillCharacterRefs` 补完自动确认的那一步就可以删掉。

## User Story

作为短剧制作者，我希望上游只改了下游用不到的字段时（比如补出图提示词、改音色），分镜不被标需复核，这样「只跑需要重跑的」不会白花钱重跑 20 集。

## Problem → Solution

**现在**：角色卡任何字段变（`characterRefs`、`voice`、`image`），所有钉了这张卡的分镜切都过期。只补提示词也会冒出 10–20 格需复核，靠补完后自动确认兜底。

**做完后**：
- 分镜对角色卡只看 `name`、`aliases`、`oneLiner`、`persona` 里的 `gender/ageRange/identity/appearance`，这些变了才过期；
- 分镜对道具（美术侧面）只看去掉 `image/usage/relatedScenes/carriedBy` 之后的部分；
- 其余引用照旧看整份 payload，行为不变。

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A（backlog #34）
- **Estimated Files**: 新增 2，修改约 7

---

## UX Design

没有界面改动，所以不用画 pen 稿。页面上的需复核格子、原因（`C07 · 角色 v3 → v4`）、「只跑需要重跑的」按钮都照旧，只是不该出现的格子不再出现。

| Touchpoint | Before | After |
|---|---|---|
| 补提示词后的待处理 | 冒出 10 格，后台自动确认 | 不冒出 |
| 角色卡只改了 `voice` 或 `image` 后 | 所有出场集的分镜需复核 | 分镜不需复核 |
| 角色卡改了 `persona.appearance` | 需复核 | 需复核（不变） |
| 命令行 `stale` / `matrix` | 列出全部换版本的引用 | 只列内容相关的 |
| 命令行 `refs` 输出 | 「…处因此需复核的已确认」 | 去掉这行 |

---

## 现状事实（实现时不用再查）

### 引用全表

来源：`src/import/projections/*.ts` 里的 `ref(`、`refsTo(`。

| 下游侧面 | 身份 role | 上游 kind | 上游侧面 | 下游实际读的字段 |
|---|---|---|---|---|
| storyboard | cast | character | cast / outline | 写分镜时只读 `id,name,aliases,oneLiner` + `persona.{gender,ageRange,identity,appearance}`（`stage-recipes.ts:252-268`）；skill 门只读 `name`、`aliases`（`novel-storyboard.mjs:741`，查提示词人名） |
| storyboard | prop | prop | art / outline | 去掉 `image,usage,relatedScenes,carriedBy`（`stage-recipes.ts:272`） |
| storyboard | segment / scene / staging | segment / script_scene | storyboard / script / staging | 整份 |
| script | cast / location / prop / episode | … | outline / art | 整份（本计划不动） |
| staging | staged / location / read-from | … | script / art | 整份（本计划不动） |
| art | variant-of / location | location | art / outline | 整份 |
| outline | episode / cast / location / prop | … | outline | 整份 |

**例外：分镜的修复环节读的是整份角色卡。** `stage-recipes.ts:437` 的 `repair.upstream = pick(ctx, ['cast','art'])` 把整份 cast/art 都给了模型，和写分镜那一遍裁过的切片不一致。本计划让修复环节也用同一份切片（Task 2），这样「声明读哪些字段」才是真的。

### 过期判断链路

- `findStaleRefs`（`src/repo/lineage.ts:110-125`）跑 `STALE_SQL`：在 `live_ref` 里找 `cur.id <> tv.id` 的引用。
- `groupStale` 把这些引用按 (阶段, 集) 聚合成格子：`src/orchestrate/review-matrix.ts:35`。
- `reviewMatrix` 和 `pendingCells` 被这些地方使用：
  - 服务端视图：overview、episode、gates、projects、common；
  - `orchestrator.ts:96`（`go --only-stale`）；
  - `revisions.ts`；
  - `refs-only.ts`；
  - 命令行 `matrix`、`stale`。
- 复核确认存的是 `{ "kind/key/facet": currentV }`，判断用 `snapshot ≥ currentV`。语义不变，也不用改。
- 退役版本的 payload 是 `null`，退役一律算过期（保持现状）。

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/repo/lineage.ts` | 80-125 | 要改的 STALE_SQL 与 findStaleRefs |
| P0 | `src/executor/stage-recipes.ts` | 250-275, 430-440 | 分镜读角色卡和道具的切片；修复环节 |
| P0 | `src/orchestrate/refs-only.ts` | all | 要删的自动确认 |
| P1 | `src/orchestrate/review-matrix.ts` | all | 消费方，不用改 |
| P1 | `src/domain/hash.ts` | 23 | 用 `canonicalJson` 比较 |
| P1 | `test/review-matrix.test.ts`, `test/refs-only.test.ts`, `test/lineage.test.ts` | all | 测试写法 |

## External Documentation

不需要外部资料，全部用项目里已有的写法。

---

## Patterns to Mirror

### NAMING / 注释
// SOURCE: src/repo/lineage.ts:1, src/orchestrate/review-matrix.ts:1-4
文件头写一两行中文注释，说明它判断什么、为什么这样判断。函数用小驼峰（`findStaleRefs`），常量用大写下划线（`STALE_SQL`、`PERSONA_KEYS`）。

### 数据访问
// SOURCE: src/repo/lineage.ts:110-125
```ts
const rows = db.prepare(STALE_SQL).all() as unknown as RawStale[];
return rows.map((r) => ({ ... }));
```

### 字段裁剪 helper
// SOURCE: src/executor/stage-recipes.ts:252-253
```ts
const PERSONA_KEYS = ['gender', 'ageRange', 'identity', 'appearance'];
const only = (doc: Doc, keys: readonly string[]): Doc => Object.fromEntries(keys.flatMap((k) => (doc[k] === undefined ? [] : [[k, doc[k]]])));
```

### 测试
// SOURCE: test/review-matrix.test.ts:1-30
- 用 `tempProject()` + `importAll(project)` 起项目；
- 改 fixture（`loadFixture`），再用 `importArtifact` 导入新版本；
- 用 `cells(project)` 把格子转成 `stage/episode` 字符串来断言；
- 测试名用中文描述行为。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/domain/reads.ts` | CREATE | 唯一来源：各引用读上游哪些字段（`readView`），以及分镜的切片常量 |
| `src/executor/stage-recipes.ts` | UPDATE | `storyboardUpstream` 改用 `reads.ts` 的切片；修复环节也用同一份切片 |
| `src/repo/lineage.ts` | UPDATE | STALE_SQL 多取两版 payload 和退役标记；`findStaleRefs` 按 `readView` 过滤 |
| `src/orchestrate/refs-only.ts` | UPDATE | 删掉自动确认；`fillCharacterRefs` 只跑 refsOnly |
| `src/server/jobs.ts` | UPDATE | `refs` 任务结果去掉 `acknowledged` |
| `src/cli-nodes.ts` | UPDATE | `refs` 去掉「已确认」那行和 `acknowledged` 输出 |
| `test/content-aware-stale.test.ts` | CREATE | 新行为的测试 |
| `test/refs-only.test.ts` | UPDATE | 改断言：补完不冒出需复核；删掉测并发误确认的那条 |
| `test/job-detail.test.ts` | UPDATE（如有断言 `acknowledged`） | 跟着结果字段改 |
| `.claude/PRPs/backlog.md` | UPDATE | #34 已完成，并更正「image、voice 变了才标」的说法 |

## NOT Building

- 不在需复核原因里显示「哪些字段变了」：要改界面、画 pen 稿，另记 backlog。
- 不改剧本、站位、美术、大纲的引用规则：这次只给分镜对角色卡和道具这两种引用加字段声明，其余照旧看整份。
- 不处理「出图提示词变了，参考图要重出」：那是付费生成那一层的事（Phase 6），不算文本需复核。
- 不加迁移、不改表结构。

---

## Step-by-Step Tasks

### Task 1：`src/domain/reads.ts`，声明读哪些字段

- **IMPLEMENT**：
  ```ts
  // 下游实际读上游的哪些字段：需复核按这些字段的内容判断，不按版本号。
  // 分镜写作喂给模型的切片也从这里取，保证「声明读的」就是「真的读的」。
  export const PERSONA_KEYS = ['gender', 'ageRange', 'identity', 'appearance'] as const;
  export const STORYBOARD_CAST_KEYS = ['id', 'name', 'aliases', 'oneLiner'] as const;
  export const STORYBOARD_PROP_OMIT = ['image', 'usage', 'relatedScenes', 'carriedBy'] as const;
  export function storyboardCastCard(card: Doc): Doc { /* only(card, STORYBOARD_CAST_KEYS) + persona: only(persona, PERSONA_KEYS) */ }
  export function storyboardProp(prop: Doc): Doc { /* omit(prop, STORYBOARD_PROP_OMIT) */ }
  type View = (payload: Doc) => unknown;
  const VIEWS: Readonly<Record<string, View>> = {
    'storyboard/cast/cast': storyboardCastCard,
    'storyboard/prop/art': storyboardProp,
  };
  /** 下游侧面、身份、上游侧面 → 下游读到的那部分；没声明的看整份。 */
  export function readView(fromFacet: Facet, role: string, toFacet: Facet, payload: unknown): unknown
  ```
- **GOTCHA**：
  - 只有 payload 是对象时才套 view，否则原样返回。
  - `id` 不用比：`id` 和 entity key 是同一个东西。
  - `Doc` 类型从 stage-recipes 用的地方 import，或者在本文件里定义成 `Record<string, unknown>`。`only`/`omit` 在本文件里自己写，不从 executor 反向 import。
- **VALIDATE**：tsc，以及 Task 4 的单元测试。

### Task 2：分镜配方改用同一份切片

- **IMPLEMENT**：
  - `storyboardUpstream` 里的角色卡改用 `storyboardCastCard`，道具改用 `storyboardProp`；
  - 删掉本地的 `PERSONA_KEYS`；
  - 修复环节（约 437 行）的 `upstream` 改成整份 cast/art 过同一份切片。cast 用全部角色卡的 `storyboardCastCard`；art 的 scenes 照现有写法 `omit(['image','usage'])`，props 用 `storyboardProp`。
- **GOTCHA**：
  - 修复的提示文本变短了，这会改变模型输入。`test/` 里假模型 duko 是按步骤回放的，不看提示文本，应该不受影响。如果有快照测试比对提示文本，跟着更新，并在报告里记为偏差。
  - 写分镜那一遍的切片原本就是这样，行为不变。
- **VALIDATE**：storyboard、run-node 相关测试全部通过。

### Task 3：`findStaleRefs` 按内容过滤

- **IMPLEMENT**：
  - STALE_SQL 的 SELECT 加 `tv.payload AS pinned_payload, cur.payload AS current_payload, cur.retired AS current_retired`。
  - JS 里：
    - 当前版本已退役，保留这条（算过期）；
    - 否则比较 `canonicalJson(readView(from_facet, role, to_facet, JSON.parse(pinned)))` 和当前版本的同一结果，相同就丢掉。
  - **按 `cur.facet` 选 view，不用钉住的侧面**。
- **GOTCHA**：
  - 钉住的版本和当前版本是同一实体、同一侧面（SQL 用 `cur.facet = tv.facet` 连接），所以按哪个侧面选 view 都一样。按 `cur.facet` 选，读起来更清楚。
  - 性能：一次查询可能有上千条，每条解析两份 JSON。按 version id 缓存解析结果（函数内的 `Map`）。
  - 返回类型 `StaleRef` 不变，消费方一律不用改。
- **VALIDATE**：`test/lineage.test.ts`、`test/review-matrix.test.ts` 照旧通过，加上 Task 4 的测试。

### Task 4：`test/content-aware-stale.test.ts`

都先跑一遍确认是红的，再写实现。起项目的写法照 `test/review-matrix.test.ts`：`tempProject` + `importAll`。

| 测试 | 操作 | 期望 |
|---|---|---|
| 只改 `characterRefs` | 角色卡重新导入，只改某个角色的 `characterRefs` | `reviewMatrix` 为空，`findStaleRefs` 为空 |
| 只改 `voice` 和 `image` | 同上 | 为空 |
| 改 `persona.appearance` | 同上 | 这个角色出场的分镜集需复核，原因指向 `character/…/cast` |
| 改 `name` 的别名 | `aliases` 加一个 | 需复核（skill 门要查人名） |
| 改道具的 `image` 或 `usage` | 美术重新导入 | 分镜不需复核 |
| 改道具的其他字段 | 美术重新导入 | 分镜需复核 |
| 改回原样 | v2 改外形、v3 改回来 | 不需复核（只比钉住的版本和当前版本） |
| 退役 | 大纲删掉一个角色，导入能过的话 | 照旧报过期 |
| 剧本改一拍 | 同 `review-matrix.test.ts` | 站位、分镜照旧需复核（没声明的引用看整份） |

- **GOTCHA**：「退役」这条如果大纲导入会拒掉（上一轮试过），就改成直接验证 SQL 分支：用现有 lineage 测试里的退役写法；没有的话删掉这条，并在报告里说明。

### Task 5：删掉补提示词的自动确认

- **IMPLEMENT**：
  - `fillCharacterRefs` 改为只跑 `runNode(project, 'cast', { ...opts, refsOnly: true })`，返回 `{ outcome }`；
  - 删掉 `REFS_ONLY_NOTE`、`acknowledge`、`pendingCells` 的 import；
  - `jobs.ts` 和 `cli-nodes.ts` 跟着改。
- **测试**（`test/refs-only.test.ts`）：
  - 「干净项目补完仍 0 项」改成断言 `pendingCells` 为 0，并且 `review_ack` 表**没有新行**；
  - 「原有需复核保留」保留；
  - 「并发改剧本不被误确认」删掉，因为已经没有确认这一步了；
  - 用例名和文件头注释跟着改。
- **VALIDATE**：refs-only、job-detail 测试通过。

### Task 6：文档与 backlog

- backlog #34 标为已完成，把「image、voice 变了才标」更正为按代码查清的字段；如果有新的待办（需复核原因里显示哪些字段变了），另起一条。
- 如果 `docs/web-ui.md` 提到补提示词会自动确认，删掉那句。

---

## Validation Commands

```bash
npm run typecheck && npm run web:typecheck   # 0 错
npm test                                     # 全部通过
npm run test:e2e                             # 2/2
```

### 冒烟副本验证（只读，不花钱）

`~/ShortDrama-smoke/自由北美-冒烟` 当前的 cast 是 v4（v3 + 补提示词）。用新分支跑：

```bash
node src/cli.ts stale ~/ShortDrama-smoke/自由北美-冒烟
```

期望：没有 `to.facet = cast` 的过期引用。

再拿旧数据核对新规则：
- run 22 那次整份重写，外形改了，按新规则仍然是 20 集需复核。用测试项目复现：v2 → v3 导入。
- 按新规则，只补提示词是 0 格。

`withProject` 打开项目不会写库：本计划没有新迁移。

## Acceptance Criteria

- [ ] 只改角色卡下游不读的字段，或道具的出图字段，不产生需复核。
- [ ] 下游读的字段变了照旧需复核；没声明的引用行为完全不变。
- [ ] 分镜写作和修复喂给模型的切片，与 `readView` 用的是同一份代码。
- [ ] 补提示词不再写 `review_ack`。
- [ ] 类型检查、单元测试、e2e 全部通过，覆盖率不低于现在（行 98%）。

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 漏了下游实际在读的字段（比如以后 skill 门开始读 `image`），该复核的没标 | 中 | 中 | 切片和 view 用同一份代码；文件头写明「改切片就是改需复核规则」；skill 门读 cast 的地方已经查过，只有 name、aliases |
| 修复环节的输入变短，影响修复质量 | 低 | 低 | 去掉的都是出图字段，写分镜那一遍本来就不带 |
| 需复核计算变慢 | 低 | 低 | 按版本 id 缓存 JSON 解析结果 |
| 已有的复核确认记录语义变化 | 无 | — | 快照仍然存版本号，`covered` 不变 |

## Notes

- 待用户在 GATE 1 确认的三个决定：
  1. 分镜读角色卡的字段按代码实际情况定。`image`、`voice` 变了**不**标，和 backlog 原来的写法相反，因为分镜既没给模型看这两项，skill 门也不读。
  2. 修复环节也改用切片。
  3. 删掉补提示词的自动确认。
- 出图提示词（`image`、`characterRefs`）变了以后，参考图要不要重出，属于 Phase 6「重新生成」的范围。

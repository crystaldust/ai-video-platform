# Plan: 需复核原因写明变了哪些字段（backlog #38）

## Summary
现在需复核的原因只写「C01 · 角色 v3 → v4」或「character C01 的角色：v3 → v4」，看不出上游变了什么。

改法分两步：
1. `findStaleRefs` 本来就要比对钉住版本和当前版本的读取视图（#34）。比对时顺手算出哪些字段不同，连同上游的名字、是否已删除，一起放进 `StaleRef`。
2. 服务端用一个函数把每条原因写成「沈知微 · 角色：外貌、别名（v3 → v4）」，全貌右侧详情和单集详情的横条都用它。

## User Story
作为看到「需复核」的用户，我希望直接看到上游是哪个角色或道具、变了哪几项，这样不用翻两版产物对比，就能决定是保持现状还是重跑。

## Problem → Solution
- **现在：** `StaleRef` 只有 kind、key、facet 和两个版本号。页面原因有两处，各写各的，都只有编号和版本号：
  - `DetailPanel.tsx:127`
  - `episode.ts:143`
- **改后：**
  - `StaleRef` 加 `toName`、`changed`（变了的字段，已转成中文名）、`retired`。
  - `staleReasonText()` 统一写原因。
  - `PendingItem` 加 `targets`（写好、去重后的原因行），DetailPanel 直接显示。

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A（backlog #38）
- **Estimated Files**: 9

---

## UX Design（pen 稿：`designs/ai-short-video-platform.pen` →「#38 需复核原因写明变了哪些字段」tHlly）

**① 全貌右侧详情「为什么要复核」**
- 之前：`C01 · 角色 v3 → v4`
- 之后：
  - `沈知微 · 角色：外貌、别名（v3 → v4）`
  - `周敬安 · 角色：已删除`
  - `砚台 · 美术：外观锚点（v1 → v2）`
- 还是最多显示 3 行，多出的写「…另 N 处」（现有逻辑）。

**② 单集详情顶部横条**
- 之前：`分镜需复核：character C01 的角色：v3 → v4 等 3 处`
- 之后：`分镜需复核：沈知微 · 角色：外貌、别名（v3 → v4） 等 3 处`

**写法规则**
- **名字：**
  - 有 `name` 的（角色、场景、道具）用名字。
  - 集用「第 N 集」（payload 的 `ep`）。
  - 其他（剧本场次、分镜段）用编号 key。
- **字段：**
  - 只列下游实际读的部分（`readView` 之后）的差异。
  - 顶层键都是对象（非数组）时再往下比一层，例如 persona 下的 appearance 写成「外貌」。
  - 中文名查表，查不到的原样写键名。
- **数量：** 超过 3 个字段写「外貌、别名、身份等 5 项」。
- **已删除：** 写「已删除」，不写版本号。
- **CLI `stale`：** 输出的 JSON 自动多出 `toName`、`changed`、`retired`。

### Interaction Changes
| 触点 | 之前 | 之后 |
|---|---|---|
| 全貌 · 为什么要复核 | `C01 · 角色 v3 → v4` | `沈知微 · 角色：外貌、别名（v3 → v4）` |
| 单集详情横条 | `character C01 的角色：v3 → v4` | 同上的写法 |
| CLI `stale` | 无字段信息 | 多出 `toName`、`changed`、`retired` |

---

## Mandatory Reading
| P | 文件 | 行 | 为什么 |
|---|---|---|---|
| P0 | `src/repo/lineage.ts` | 80–150 | `StaleRef`、`STALE_SQL`、`sameRead`、`findStaleRefs`：在这里算差异 |
| P0 | `src/domain/reads.ts` | 全部 | `readView`；新的字段中文名表和 diff 函数也放这里 |
| P0 | `src/server/views/overview.ts` | 42–56, 82–83, 151–192 | `PendingItem`、`reasonOf`、`pendingItems` |
| P0 | `src/server/views/episode.ts` | 143 | 单集详情的 stale reasons |
| P0 | `web/src/components/DetailPanel.tsx` | 127–138 | targets 显示 |
| P1 | `src/server/views/common.ts` | 16 | `STAGE_TITLES` |
| P1 | `src/orchestrate/review-matrix.ts` | 20–70 | `MatrixCell.reasons` 就是 `StaleRef[]`；ack 只用 `currentV`，不受影响 |
| P2 | `test/content-aware-stale.test.ts` | 全部 | `editCard`、`editProp`、`fresh()` 的测试写法 |

## Patterns to Mirror
- **reads.ts 的写法：** `const only = (doc: Doc, keys: readonly string[]): Doc => ...`。小的纯函数，加中文 JSDoc；导出常量用 `readonly string[]`。
- **sameRead 的解析缓存：** `parsed: Map<number, unknown>`，按版本 id 缓存。新代码复用同一个 Map，不要再解析一次。
- **测试：**
  ```ts
  const { project, cleanup } = fresh();
  editCard(project, ...);
  assert.deepEqual(cells(project), [...]);
  cleanup();
  ```

## Files to Change
| 文件 | 动作 | 说明 |
|---|---|---|
| `src/domain/reads.ts` | UPDATE | 加 `FIELD_LABELS`、`changedFields(a, b)`、`entityName(payload)` |
| `src/repo/lineage.ts` | UPDATE | `StaleRef` 加 `toName`、`changed`、`retired`；`findStaleRefs` 一次算出视图，再比对、取差异 |
| `src/server/views/common.ts` | UPDATE | `staleReasonText(r)` |
| `src/server/views/overview.ts` | UPDATE | `PendingItem.targets`（stale 项用 `staleReasonText` 去重；其他项为 `[]`） |
| `src/server/views/episode.ts` | UPDATE | reasons 用 `staleReasonText` |
| `web/src/components/DetailPanel.tsx` | UPDATE | `targets` 改用 `item.targets` |
| `test/content-aware-stale.test.ts` | UPDATE | 断言 changed、toName、retired |
| `test/stale-reason.test.ts` | CREATE | `changedFields`、`entityName`、`staleReasonText` 的单元测试 |
| `docs/orchestration.md` | UPDATE | 一句：需复核原因带变了的字段 |

## NOT Building
- 显示字段前后的具体值（只列字段名）。
- 改 ack、`reviewMatrix` 的判断逻辑。
- 全貌分集表格子里的 `reasonOf`（「角色已变」）：格子太小，不改。
- 待处理项的 detail 那句「角色已变：N 处引用还钉着旧版本」：不变。

---

## Step-by-Step Tasks

### Task 1: reads.ts 加字段差异和名字
- **IMPLEMENT**
  - `FIELD_LABELS: Readonly<Record<string, string>>`：
    - name 名字、aliases 别名、oneLiner 一句话、importance 重要度、persona 人设
    - gender 性别、ageRange 年龄段、identity 身份、appearance 外貌、personality 性格、temperament 气质、motivation 动机、arc 弧光、relationships 关系、evidence 原文依据
    - image 出图提示词、voice 音色、characterRefs 出图参考
    - scale 尺度、summary 概述、anchors 外观锚点、states 状态变体、relatedScenes 出现场景、carriedBy 携带者、usage 用法
    - primary 主场景、lighting 光照
    - characters 出场角色、props 道具、flow 节拍
    - synopsis 梗概、hook 钩子、suspense 悬念、sceneIds 场景、characterIds 角色、propIds 道具、crowdPlan 群演安排
    - role 定位、tier 分档、from 出处
    - cast 在场人物、places 站位点、extras 群演、extrasWhere 群演位置、why 理由
    - sceneRef 场次、cuts 分镜、h3Prompt 视频提示词、blocking 调度、soundscape 声音、music 音乐
  - `changedFields(a: unknown, b: unknown): string[]`：
    - 两边都是对象：取键的并集，顺序按 b 的键在前、a 独有的在后。
    - 对每个键比 `canonicalJson`，不同的才记下。
    - 两边该键的值都是对象（非数组、非 null）时，递归一层：子键差异各自记为子键的中文名，只下一层。
    - 否则记键本身的中文名（查不到用键名）。
    - 去重。
    - 两边不都是对象时返回 `[]`，由调用方写「内容有变」。
  - `entityName(payload: unknown): string | null`：`name` 是非空字符串时返回它；`ep` 是数字时返回 `第 ${ep} 集`；否则 null。
- **IMPORTS**: `canonicalJson` from `./hash.ts`。
- **GOTCHA**
  - 不能 mutate 入参。
  - `id` 也会进差异，但 key 不会变，所以实际不会出现。
- **VALIDATE**：`test/stale-reason.test.ts` 的单元测试先红后绿。

### Task 2: StaleRef 带字段差异
- **IMPLEMENT**
  - 把 `sameRead` 改为 `compareRead(r, parsed): { same: boolean; changed: string[]; toName: string | null }`。
    - 一次算出 `pinnedView` 和 `currentView`（`readView` 之后）。
    - `same` 为两边 canonical 相等，且当前版本没有退役。
    - `changed`：退役时为 `[]`，否则 `changedFields(pinnedView, currentView)`。
    - `toName`：`entityName(当前 payload)`，退役时 payload 是 null，退回用钉住版本的 payload；名字用整份 payload，不用视图（视图可能不含 name）。
  - `StaleRef` 加三个只读字段：`toName: string | null`、`changed: readonly string[]`、`retired: boolean`。
- **GOTCHA**：退役版本的 payload 是 JSON 字符串 `'null'`，`JSON.parse` 后得到 null，处理时注意。
- **VALIDATE**：`test/content-aware-stale.test.ts` 补断言：
  - 外貌变了：`changed` 为 `['外貌']`，`toName` 为「沈知微」。
  - 加别名：`changed` 为 `['别名']`。
  - 删角色：`retired` 为 true，`toName` 为「沈知微」。
  - 剧本改一拍：`changed` 含「节拍」。
  - 并跑 `lineage.test.ts`。

### Task 3: 服务端统一写原因
- **IMPLEMENT**：在 `common.ts` 加：
  ```ts
  const FIELDS_SHOWN = 3;
  export function staleReasonText(r: Pick<StaleRef, 'to' | 'toName' | 'changed' | 'retired' | 'pinnedV' | 'currentV'>): string {
    const who = `${r.toName ?? r.to.key} · ${STAGE_TITLES[r.to.facet]}`;
    if (r.retired) return `${who}：已删除`;
    const shown = r.changed.slice(0, FIELDS_SHOWN).join('、');
    const what = !r.changed.length ? '内容有变' : r.changed.length > FIELDS_SHOWN ? `${shown}等 ${r.changed.length} 项` : shown;
    return `${who}：${what}（v${r.pinnedV} → v${r.currentV}）`;
  }
  ```
  - `overview.ts`：`PendingItem` 加 `readonly targets: readonly string[]`。stale 项为 `[...new Set(c.reasons.map(staleReasonText))]`，其他项为 `[]`。
  - `episode.ts:143`：`reasons: c.reasons.map(staleReasonText)`。
- **GOTCHA**
  - `STAGE_TITLES` 以 Stage 为键，`r.to.facet` 是 Facet。facet 的取值和 stage 一致，现有代码已经这么用（episode.ts:143）。
  - common.ts 引 lineage 的类型用 `import type`。
- **VALIDATE**：单元测试覆盖 `staleReasonText` 的四种写法：一般、超过 3 项、已删除、内容有变。服务端测试检查 overview 的 stale 项有 `targets`（`test/server.test.ts` 或 `test/content-aware-stale.test.ts` 里直接调 `overviewView`，按现有可用的方式选）。

### Task 4: 页面用 targets
- **IMPLEMENT**：`DetailPanel.tsx:127` 改成 `const targets = item.targets;`，渲染代码不变。
- **VALIDATE**：web typecheck；e2e 主流程（打回剧本后「为什么要复核」显示新写法）。在 e2e 里加一行断言：打回剧本第 1 集后，详情里出现「· 剧本：」。

### Task 5: 文档与 backlog
- `docs/orchestration.md` 需复核那一段加一句：原因带变了的字段（`StaleRef.changed`），写法见 `staleReasonText`。
- backlog #38 标为完成并链到计划。

---

## Testing Strategy
| 测试 | 输入 | 期望 |
|---|---|---|
| changedFields 顶层 | `{a:1,b:2}` 对 `{a:1,b:3,c:4}` | `['b','c']`（无中文名时用键名） |
| changedFields 下一层 | persona.appearance 变了 | `['外貌']` |
| changedFields 数组 | aliases 加一项 | `['别名']` |
| entityName | `{name:'沈知微'}` / `{ep:3}` / `{}` | 沈知微 / 第 3 集 / null |
| staleReasonText | 两个字段 | `沈知微 · 角色：外貌、别名（v3 → v4）` |
| staleReasonText | 5 个字段 | `…：外貌、别名、身份等 5 项（v3 → v4）` |
| staleReasonText | retired | `沈知微 · 角色：已删除` |
| staleReasonText | changed 为 `[]` | `C01 · 角色：内容有变（v1 → v2）` |
| 集成 | 改沈知微外貌 | StaleRef 的 changed 为 `['外貌']`，toName 为「沈知微」 |
| 集成 | 删沈知微 | retired 为 true，toName 为「沈知微」 |
| 集成 | 剧本改一拍 | 分镜原因含「节拍」 |

## Validation Commands
```bash
npm run typecheck && npm run web:typecheck
node --test test/stale-reason.test.ts test/content-aware-stale.test.ts test/lineage.test.ts
npm test
pnpm web:build && npm run test:e2e
```
冒烟副本：`node src/cli.ts stale ~/ShortDrama-smoke/自由北美-冒烟`，只读，确认输出里有新字段（当前可能是 0 条）。

## Acceptance Criteria
- [ ] 原因写法符合 pen 稿
- [ ] 两个 typecheck 0 错误；单元测试和 e2e 全部通过
- [ ] ack 和复核判断不受影响（现有 review-matrix 测试照过）

## Risks
| 风险 | 可能 | 影响 | 应对 |
|---|---|---|---|
| 下一层的子键同名，不同对象里的「name」都写成「名字」 | 低 | 字段名有歧义 | 去重后可接受；只下一层 |
| 性能：多算一次 diff | 低 | 只对过期的行算，而且已有视图可复用 | 复用解析缓存 |
| 字段中文名不全 | 中 | 显示英文键名 | 查不到时原样写键名，以后补表 |

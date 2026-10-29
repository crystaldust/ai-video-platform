# Plan: 稳定 id ③ — novel-storyboard 3.0.0 + 收尾

## Summary
让 novel-storyboard 的集、段、切都按 id 对账：段 `sg_`、切 `ct_`，`sceneRef` 指向剧本场次 id，`beatIds` 逐拍列出认领的节拍 id；覆盖门改为按 id 序列比对；导出与 `--frames` 按 `<段 id>/<切 id>.png` 命名。然后收尾：夹具一致性检查脚本、CHANGELOG 3.0.0、AGENTS.md、根 README、断言数与 version。

## User Story
作为使用这条流水线做短剧的开发者，我希望在剧本里插一拍、插一场，或者重排分镜段之后，分镜的认领、导出文件夹和已生成的素材都仍然对得上原来那一段、那一切，这样就不会出现"悄悄挂错拍、视频对不回段"的问题。

## Problem → Solution
段号 `E01-01` 必须连号，同时又是素材文件夹名；`sceneIndex` 是第几场；`beats: [起, 止]` 是第几拍 → 段、切用随机 id，场次和节拍引用剧本 id，`E01-02` / `#k` 只在显示时按位置推算。

## Metadata
- **Complexity**: Large
- **Source PRD**: N/A（shuohao-skills 的设计文档 `docs/superpowers/specs/2026-10-26-stable-ids-design.md`、计划 `docs/superpowers/plans/2026-10-26-stable-ids.md` 的 Task 5–6）
- **PRD Phase**: N/A
- **Estimated Files**: 约 25 个

---

## UX Design

### Before
```
storyboard.json  segments[].id = "E01-03"（必须连号）, sceneIndex = 1, cuts[].beats = [10, 10]
export → E01-03/f1.png … f4.png        剧本插一拍 → 认领整体错开一格，门只能部分拦下
```

### After
```
storyboard.json  segments[].id = "sg_…", sceneRef = "sc_…", cuts[].id = "ct_…", beatIds = ["bt_…"]
export → sg_…/ct_….png；manifest 带 label "E01-03" 与 order
剧本插一拍 → coverage 点名"第 1 场第 5 拍（bt_…）没人认领"，其余认领原样有效
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 写分镜 | 写段号、sceneIndex、beats 区间 | 照抄 seedScenes 的 `sceneRef` 与节拍 `id`，段和切不写 id，写完运行 `ids --write` | storyboard-pass.md 写明 |
| 门 | `segment-id` 连号门 | `ids` 门（第一道），门数仍为 18 | |
| 导出 | `E01-01/f1.png` | `sg_…/ct_….png`，prompt.md 的 Picture 对照表列文件名 | |
| 报告 | 段头显示段号 | 显示 `E01-01` 标签，另附段 id | 锚点 `#seg-<段 id>` |
| 新命令 | — | `ids [--script] [--write] [--seed]`、`migrate --script` | 与 script / staging 同形 |

---

## Mandatory Reading

工作目录：`/Users/lance/Development/ai-video/shuohao-skills-stable-ids`（下面路径都相对它）。

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `skills/novel-storyboard/scripts/novel-storyboard.mjs` | 212–321 | seedancePrompt 与 expandScript：按位置取拍、`f${ci+1}.png` |
| P0 | 同上 | 449–521 | computeStats：`sceneIndex - 1`、`cut.beats`、dialogue / batches 用 `seg.id` 当显示 |
| P0 | 同上 | 527–799 | gateReport：段号门 559–563、场次 610–615、台词 691–701、覆盖 727–755、门列表 773–796 |
| P0 | 同上 | 805–965 | validateStoryboard 结构检查、seedFromScript、exportPack |
| P0 | 同上 | 992–1011、1206–1265、1323–1490 | GATE_LABELS_EN、cutBeats、renderMarkdown、renderHtml |
| P0 | 同上 | 1877–2110 | CLI：loadCtx、export 的 `--frames` 拷贝（2032–2043）、USAGE |
| P0 | `skills/novel-script/scripts/novel-script.mjs` | 125–207、1081–1089、1160–1173 | 照搬的范式：scriptIdProblems、assignScriptIds、migrateScript、writeOrPrint、ids/migrate CLI |
| P1 | `skills/novel-staging/scripts/novel-staging.mjs` | 搜 `sceneRefProblems`、`migrateStaging`、`scriptSceneIndex` | 显示缓存检查与"3.0 唯一允许按位置查找的地方"的写法 |
| P1 | `skills/novel-storyboard/scripts/selftest.mjs` | 全文（932 行） | 需要改写的用例：129–156 覆盖、212–219 段号、365–411 refs、560–700 seedance/export、703–720 结构、724–746 seed |
| P1 | `skills/novel-staging/scripts/selftest.mjs` | 360–395 | migrate 与样例逐字节一致、CLI 用 spawnSync 的写法 |
| P2 | `skills/novel-storyboard/references/schema.md` | 1–70 | 字段表；第 29 行文件名、第 32 行默认语言写错 |
| P2 | `CHANGELOG.md` | 1–80 | 2.0.0 那一条的"破坏性变更与迁移"表格式 |

## External Documentation
No external research needed — feature uses established internal patterns.

---

## Patterns to Mirror

### NAMING_CONVENTION / ids 导入
```js
// SOURCE: skills/novel-script/scripts/novel-script.mjs:9
import { assignIds, collectIds, cryptoRng, duplicateIds, isId, seededRng } from './ids.mjs';
```
storyboard 的 `scripts/ids.mjs` 已经存在（与其他四份逐字节相同），**不要改它**。

### ID_PROBLEMS（门里的 id 检查，消息格式）
```js
// SOURCE: skills/novel-script/scripts/novel-script.mjs:147-174
if (sc?.id === undefined) bad.push(`${sLabel}缺 id（运行 ids --write）`);
else if (!isId(sc.id, 'sc')) bad.push(`${sLabel}的 id「${sc.id}」格式不对`);
else sceneIds.push(sc.id);
...
for (const id of duplicateIds(sceneIds)) bad.push(`场次 id ${id} 重复`);
```

### ASSIGN（只补缺的，不改入参，集 id 从上游照抄）
```js
// SOURCE: skills/novel-script/scripts/novel-script.mjs:177-192
export function assignScriptIds(doc, { outline = null, rng = cryptoRng } = {}) {
  const idOf = new Map((outline?.episodes ?? []).filter((e) => isId(e?.id, 'ep')).map((e) => [e.ep, e.id]));
  let taken = collectIds(doc);
  const episodes = (doc?.episodes ?? []).map((ep) => {
    const withId = ep?.id === undefined && idOf.has(ep?.ep) ? { id: idOf.get(ep.ep), ...ep } : ep;
    const sc = assignIds(withId?.scenes ?? [], 'sc', taken, rng);
    taken = sc.taken;
    ...
```

### MIGRATE（必须给上游，指错时点名报错）
```js
// SOURCE: skills/novel-script/scripts/novel-script.mjs:195-206
if (!outline) throw new Error('迁移剧本必须给 3.0 的大纲（--outline）：集 id 只能从大纲照抄');
...
if (!id) throw new Error(`第 ${ep.ep} 集的 hookBeat [${s}, ${b}] 指向不存在的节拍`);
```

### CLI ids / migrate + writeOrPrint
```js
// SOURCE: skills/novel-script/scripts/novel-script.mjs:1081-1089, 1160-1173
function writeOrPrint(path, doc, write, note) {
  const text = JSON.stringify(doc, null, 2) + '\n';
  if (!write) { process.stdout.write(text); return; }
  writeFileSync(resolve(path), text, 'utf8');
  console.error(note);
}
...
const added = collectIds(after).size - collectIds(before).size;
writeOrPrint(path, after, rest.includes('--write'), `✓ 补了 ${added} 个 id`);
```

### GATE 注册
```js
// SOURCE: skills/novel-storyboard/scripts/novel-storyboard.mjs:773-796
add('coverage', '剧本节拍被恰好一次、按顺序、连续认领（分镜级）', bad.coverage.length === 0, script ? bad.coverage.join('；') : SKIP_SCRIPT);
```

### TEST_STRUCTURE
```js
// SOURCE: skills/novel-storyboard/scripts/selftest.mjs:50-60, 131-137
function ok(cond, label) { assert.ok(cond, label); passed += 1; }
const clone = (x) => structuredClone(x);
const gate = (doc, id, ctx = CTX) => gateReport(doc, ctx).find((g) => g.id === id);
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[3].beats = [5, 5];
  const g = gate(doc, 'coverage');
  ok(!g.ok, '有节拍没人认领被拦');
  ok(g.detail.includes('没人认领'), '点名到拍');
}
```
CLI 用例照 `skills/novel-staging/scripts/selftest.mjs:383-394`：`mkdtempSync` + `spawnSync(process.execPath, [...])`，结束 `rmSync`。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `skills/novel-storyboard/scripts/novel-storyboard.mjs` | UPDATE | 全部 id 化（见 Task 3–6） |
| `skills/novel-storyboard/scripts/selftest.mjs` | UPDATE | 改写依赖位置的用例 + 新用例 |
| `skills/novel-storyboard/examples/渡口-storyboard.json` | UPDATE | `migrate --script … --seed 渡口-storyboard` 一次 |
| `skills/novel-storyboard/references/test-fixtures/upstream/渡口-{outline,art,script}.json` | UPDATE | 重新拷贝 3.0 上游样例 |
| `skills/novel-characters/references/test-fixtures/upstream/渡口-outline.json` | UPDATE | 同上（characters 版本不变） |
| `scripts/fixtures-sync-selftest.mjs` | CREATE | 按各 upstream/README.md 的 `←` 映射逐字节比对 |
| `skills/novel-storyboard/{SKILL.md,README.md,README.en.md}` | UPDATE | version 3.0.0、门描述、命令、断言数、导出目录图 |
| `skills/novel-storyboard/references/{schema,storyboard-pass,frame,h3-prompt,report-style}.md` | UPDATE | 字段表、认领写法、文件名；顺手修 schema 两处旧错 |
| `scripts/report.mjs` | UPDATE | 只改注释里的 `E01-01/f1.png` 示例路径 |
| `README.md`、`README.zh.md` | UPDATE | 示例路径、目录图、分镜段文件夹说明、自测命令列表 |
| `CHANGELOG.md` | UPDATE | 3.0.0 条目 |
| `AGENTS.md` | UPDATE | "身份用 id，不用位置" |

## NOT Building
- 平台仓库（ai-video-platform）的改键：另起计划。
- 按 id 读取 staging.json 的走位句：本次不改站位到分镜的衔接（设计文档"发布"一节）。
- `seedance` 包里的 `ref-<n>.png`：它是每次导出现编的附件序号，不是身份，保持不变。
- 不打 `v2-final` 标签、不推送、不发 PR。
- 不改 `ids.mjs`、不改 report-selftest 里那条通用路径重算用例（`E01-01/f1.png` 在那里只是任意字符串）。

---

## Step-by-Step Tasks

### Task 1: 夹具换成 3.0 上游
- **ACTION**: 拷贝 `novel-{outline,art,script}/examples/渡口-*.json` → `novel-storyboard/references/test-fixtures/upstream/`；`novel-outline/examples/渡口-outline.json` → `novel-characters/references/test-fixtures/upstream/`。
- **GOTCHA**: 换完 storyboard 自测会失败（样例还是 2.x 写法）——这一步只确认 characters 自测仍是 337 项通过，storyboard 的失败留给 Task 2 起一起处理。
- **VALIDATE**: `node skills/novel-characters/scripts/selftest.mjs | tail -1`。

### Task 2: 自测先行（RED）
- **ACTION**: 改写 `selftest.mjs`，先写新断言，确认因缺导出 / 行为不符而失败。
- **IMPLEMENT**（新增 import：`assignStoryboardIds`、`migrateStoryboard`、`segLabel`；从 `./ids.mjs` 导入 `isId`、`seededRng`）：
  - expandScript：按集 id 取，`e1 = expanded.get(SCRIPT.episodes[0].id)`；每场带 `id`、`n`，每拍带 `id`、`n`；`e1.ep === 1`。
  - stats：`d.label` 匹配 `/^E01-\d{2}$/`，`isId(d.segment, 'sg')`，`isId(d.cutId, 'ct')`。
  - `ids` 门击穿：段缺 id；段 id 格式错（`E01-01`）；切缺 id；跨集重复段 id；重复切 id；集缺 id；集 id 不在剧本；集号与剧本不一致（显示缓存过期）；`sceneRef` 缺失 / 格式错 / 不在这一集；`beatIds` 不是非空数组或含非 `bt_` 值；2.x 的 `sceneIndex` / `beats` 字段被点名并提示 `migrate --script`。
  - coverage 击穿：删掉一个 beatId → "没人认领"并点名拍位与 id；同一 id 出现两次 → "重复认领"；认领了别的场的 id → "不在该场"；交换两切的 beatIds → "乱序"；去掉一整场的段 → "整场没有分镜"；把后一场的段挪到前面 → "场次顺序倒退"。
  - **剧本插一拍**：在剧本第 1 集第 1 场 flow 中间插入一拍（带新 `bt_` id），coverage 只点名这一拍，其余门（dialogue-fit、h3-dialogue）不受影响。
  - **重排**：把第 1 集同一场内两段对调，`exportPack` 的 manifest 里 label 跟着变、`segment` id 和 `pictures` 路径不变。
  - 删除 `segment-id` 用例，`gateReport(...).length` 仍为 18、`gates[0].id === 'ids'`。
  - seedancePrompt / exportPack：路径改为 `${seg.id}/${cut.id}.png`；prompt.md 标题 `# E01-01 · H3 提示词`，含 `Picture 1 = ${cut0.id}.png（**首帧**，钉 0.00 秒）`；manifest 条目有 `label`、`order`、`ep`；`--out` 用例照旧。
  - render：`html.includes('#seg-' + seg0.id)`；`withImg` 从 `${seg.id}/${cut.id}.png` 读；md 段头 `### E01-01 · 渡口栈桥（浓雾清晨）` 仍成立。
  - validate 结构：缺 `sceneRef`、缺 `beatIds`、`beatIds: []` 报出来。
  - seed：`seedScenes[0].sceneRef === 剧本第一场 id`，每拍带 `id`；集带 `id`；剧本缺场次 id 时 seed 抛错并提示 `ids --write`。
  - assignStoryboardIds：只补缺的、不改入参、`seededRng` 可复现、集 id 只能来自剧本（不给剧本不补集 id）。
  - migrateStoryboard：把 FIXTURE 退回 2.x（删 id、`sceneRef` → `sceneIndex`、`beatIds` → `beats`，段 id 改回 `E01-0k`），`migrateStoryboard(old, SCRIPT, seededRng('渡口-storyboard'))` 与 FIXTURE `JSON.stringify` 相同；不改入参；`sceneIndex` 越界、`beats` 越界时点名报错；不给剧本、剧本缺场次 id 时报错。
  - CLI：`ids` 打印 / `--write` / 幂等；`migrate` 缺 `--script` 退出码 1；`migrate --write` 写回与样例逐字节相同。
- **GOTCHA**: 退回 2.x 的辅助函数要保持键顺序与原 2.x 样例一致（`id, sceneIndex, cuts, …`；切 `beats, seconds, …`），否则逐字节用例会因键顺序失败——迁移函数的键顺序见 Task 4。
- **VALIDATE**: `node skills/novel-storyboard/scripts/selftest.mjs` 失败，失败原因是缺导出或新断言不满足。

### Task 3: expandScript / 标签 / 场次与节拍查找
- **IMPLEMENT**:
  - `expandScript(script)` 返回 `Map<集 id, { id, ep, targetSeconds, scenes }>`；场 `{ id, n: i + 1, sceneId, lighting, characters, props, beats, byId }`，拍 `{ id, n: j + 1, kind, seconds, speaker, delivery, text }`，`byId = new Map(beats.map(b => [b.id, b]))`。注释写明：键是集 id，`ep` 只是显示。
  - `export const segLabel = (ep, i) => \`E${String(ep).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}\``。切标签 `${segLabel}#${ci + 1}`。
  - `sceneOf(sEp, ref)`：`sEp?.scenes.find((s) => s.id === ref) ?? null`。
  - `cutBeats(cut, scene)`：`(cut?.beatIds ?? []).map((id) => scene?.byId.get(id)).filter(Boolean)`——渲染、台词、Seedance 共用这一个，不再各写一份 slice。
- **MIRROR**: novel-script `hookPosition` 的"位置现算"注释风格。
- **GOTCHA**: 剧本不带 `id`（2.x）时 Map 键会是 `undefined`，多集互相覆盖。`computeStats` / render 照常容忍（拿不到场就显示 `?`）；`seedFromScript` 和 `migrateStoryboard` 必须先检查剧本已补 id 并报错（文案照 staging：`剧本还没有场次 id：先运行 novel-script 的 ids --write`）。
- **VALIDATE**: expandScript 相关断言转绿。

### Task 4: ids 门、assign、migrate、validate 结构
- **IMPLEMENT**:
  - `storyboardIdProblems(eps, expanded)`（不导出）：
    - 集：缺 id / 格式错；给了剧本时 id 不在剧本 → `E01 的集 id 不在剧本里`；`ep` 与剧本该 id 的集号不同 → `E01 的集 id 在剧本里是第 2 集`。
    - 段：`seg.id` 缺 → `E01-02 缺段 id（运行 ids --write）`；不是 `sg_` → `E01-02 的段 id「E01-02」格式不对`；`sceneIndex` 存在 → `E01-02 还是 2.x 写法（sceneIndex）：运行 migrate --script`；`sceneRef` 缺 / 格式错；给了剧本时不在这一集 → `E01-02 的 sceneRef 不在剧本第 1 集里`。
    - 切：同理 `ct_`；`beats` 存在 → 2.x 提示；`beatIds` 不是非空数组，或有元素不是 `bt_` → 点名。
    - 全文件段 id、切 id 分别 `duplicateIds`。
  - 门：`add('ids', 'id 齐全且一致（集 id、段 id、切 id、场次与节拍引用）', eps.length > 0 && idBad.length === 0, idBad.join('；'))`，**放在 gates 第一位**；删除 `bad.id` 与 `segment-id`；`refs` 门里"集在剧本里不存在 / sceneIndex 不存在"两条删掉（已归 ids 门）。`GATE_LABELS_EN` 删 `segment-id`，加 `'ids': 'IDs complete and consistent (episode, segment and cut IDs; scene and beat references)'`。
  - `assignStoryboardIds(doc, { script = null, rng = cryptoRng } = {})`：集 id 按 `ep` 从剧本照抄（只在缺失且剧本有时）；段补 `sg_`、切补 `ct_`；`taken = collectIds(doc)` 串起来。
  - `migrateStoryboard(doc, script, rng = cryptoRng)`：
    - 无剧本 → `迁移分镜必须给 3.0 的剧本（--script）：场次与节拍 id 只能从剧本照抄`；剧本缺场次 id → 同 Task 3 文案。
    - 每集按 `ep` 找剧本那一集（找不到 → `第 N 集在剧本里找不到`）；每段：丢掉 2.x 段号（`E01-01` 不是 id），`scene = sEp.scenes[sceneIndex - 1]`（缺 → `E01-03 的 sceneIndex 9 在剧本第 1 集里找不到`）；输出 `{ sceneRef, ...其余(去掉 id、sceneIndex) }`。每切：`beatIds = scene.flow.slice(from - 1, to).map(b => b.id)`，区间不合法 → `E01-03#2 的 beats [1, 99] 超出该场 13 拍`；输出 `{ beatIds, ...其余(去掉 beats) }`。最后 `assignStoryboardIds(result, { script, rng })`（补的 id 排在最前，得到 `{ id, sceneRef, cuts, … }` / `{ id, beatIds, seconds, … }`）。
    - 注释："3.0 里只有迁移允许按位置查找"（与 staging 的 `migrateStaging` 同一说法）。
  - `validateStoryboard` 结构检查：`sceneIndex` 那行换成 `typeof seg?.sceneRef !== 'string'` → `${label} 缺 sceneRef（剧本场次 id，seed 的 seedScenes 里照抄）`；`beats` 那行换成 `!Array.isArray(cut?.beatIds) || cut.beatIds.length === 0` → `${cid} 缺 beatIds（逐拍列出认领的节拍 id）`。这里的 `sid` / `cid` 改用标签。
- **GOTCHA**: `assignIds` 只在 `id === undefined` 时补，2.x 的 `"E01-01"` 必须在迁移里先删掉，否则留着一个格式错的 id。
- **VALIDATE**: ids 门、assign、migrate、validate 结构的断言转绿。

### Task 5: 覆盖门、台词门、stats、seedance 按 id
- **IMPLEMENT**:
  - gateReport 段循环：`sEp = expanded?.get(ep?.id)`；`segments.forEach((seg, i) => { const sid = segLabel(ep.ep, i); … })`，所有 detail 里的 `seg.id` 改 `sid`；`scene = sceneOf(sEp, seg.sceneRef)`；场次倒退用 `scene.n` 与 `prevSceneN` 比。
  - 台词（dialogue-fit、h3-dialogue）：`cutBeats(cut, scene)` 取拍，删掉区间合法性判断。
  - coverage（每场）：
    - `claims` = 该场（`seg.sceneRef === scene.id`）各切 `beatIds` 按段、切顺序展开，记 `{ id, who: 'E01-02#3' }`。
    - 不在 `scene.byId` 里的 → `${who} 认领的 ${id} 不在${label} 第 ${scene.n} 场`。
    - 出现两次以上 → `${label} 第 ${n} 场第 ${b.n} 拍被 ${首个 who} 和 ${后续 who} 重复认领`。
    - 该场节拍没出现 → 连续的合并成 `第 ${a}–${b} 拍没人认领`，单拍写 `第 ${n} 拍（${id}）没人认领`。
    - 以上都没有，但已知 id 的首次出现顺序 ≠ 剧本顺序 → `${label} 第 ${n} 场从第 ${k} 拍起认领乱序`。
    - 该场没有任何段 → `整场没有分镜`（保留原文案）。
    - 切的 `beatIds` 为空 / 非数组：只由 ids 门报，coverage 跳过这一切（不重复报）。
  - 门标签保持 `'剧本节拍被恰好一次、按顺序、连续认领（分镜级）'`。
  - computeStats：`sEp = expanded.get(ep.id)`、`scene = sceneOf(...)`、`cutBeats`；dialogue 条目 `{ segment: seg.id, label, cut: ci + 1, cutId: cut.id, ep, speaker, line, seconds }`；batch 加 `labels`（与 `segments` 同序）。
  - seedancePrompt：`frames` 路径 `${seg.id}/${cut.id}.png`；台词 `cutBeats(cut, scene).filter((b) => b.kind === 'line')`；签名不变。
- **GOTCHA**: `computeStats` 的 dialogue 现在 `segment` 是 id，渲染里展示一律用 `label`；`href` 仍用 id。
- **VALIDATE**: coverage、插一拍、stats、seedance 断言转绿。

### Task 6: 导出、渲染、seed、CLI
- **IMPLEMENT**:
  - exportPack：段循环带 `i` 与全局 `order`（从 1 起）；文件夹 `${prefix}${seg.id}/`；H3 `pictures = cuts.map(c => \`${prefix}${seg.id}/${c.id}.png\`)`；prompt.md：`# ${label} · H3 提示词\n\n段 id：\`${seg.id}\`。首帧 = **${cuts[0].id}.png**。…`，对照表 `- Picture ${i + 1} = ${c.id}.png（…）`；manifest 条目 `{ segment: seg.id, label, order, ep: ep.ep, seconds, cuts, cutStarts, prompt, pictures, missing }`；Seedance 同样加 `label`、`order`、`ep`，`seedance.md` 标题用 label；`scene = sceneOf(expanded.get(ep.id), seg.sceneRef)`。更新函数头注释（`sg_…/ct_….png`）。
  - renderMarkdown：`expanded.get(ep.id)`、`sceneOf`；段头 `### ${label} · 场景 · 秒数 · \`${seg.id}\``；配音表第一列 `${d.label}#${d.cut}`；批次表段列用 `labels`。
  - renderHtml：节奏带 `href="#seg-${seg.id}"`，title 用 `${label}#k`；`frame(ci)` 走 `${seg.id}/${seg.cuts[ci].id}.png`；alt 用标签；段卡 `<b>${label}</b><span class="sid">${seg.id}</span>`（`.sid` 小号等宽灰字，加一行 CSS）；`beatsLabel(scene?.n, 首拍 n, 末拍 n)`，首末拍取 `cutBeats` 结果；批次 chip 文本用 label、href 用 id；配音表同。更新 1270–1275 行注释的路径说明。
  - seedFromScript：剧本缺场次或节拍 id → 抛错（Task 3 文案）；集 `{ id: sEp.id, ep, segments: [], seedScenes }`；`seedScenes` 每场 `{ sceneRef: sc.id, n: sc.n, sceneId, … , beats: [{ id, n, kind, seconds, speaker?, text }] }`；`epRange` 按 `sEp.ep` 过滤。
  - CLI：
    - `export --frames`：`join(from, seg.id, \`${cut.id}.png\`)`。
    - 新增 `ids <storyboard.json> [--script s.json] [--write] [--seed <文本>]`、`migrate <2.x storyboard.json> --script <3.0 script.json> [--write] [--seed <文本>]`，照抄 novel-script 1160–1173 与 `writeOrPrint`。
    - USAGE 加两条命令，`seed` 说明里写"剧本必须已补 id"。
    - `checkup` 的配方偏离提示 `${seg.id}#${ci + 1}` 改为标签。
- **GOTCHA**: render 的 `--frames` 目录现在要求 `<段 id>/<切 id>.png`，与 export 产出一致（`export --out storyboard` 后直接 `render --frames storyboard`）。
- **VALIDATE**: 自测全绿。

### Task 7: 迁移样例
- **ACTION**: `node skills/novel-storyboard/scripts/novel-storyboard.mjs migrate skills/novel-storyboard/examples/渡口-storyboard.json --script skills/novel-script/examples/渡口-script.json --seed 渡口-storyboard --write`。
- **VALIDATE**:
  - `checkup … --script <script> --outline <outline> --cast <cast> --art <art> --no-log` 18/18。
  - 样例 diff 只有 id、sceneRef、beatIds 的变化（`git diff --stat` + 抽看）。
  - 段 id、切 id 与剧本 / 大纲的 id 后缀没有相同的（一行 node 检查）。
  - 自测里逐字节一致的迁移用例通过。

### Task 8: 夹具一致性检查脚本
- **ACTION**: 新建 `scripts/fixtures-sync-selftest.mjs`。
- **IMPLEMENT**: 遍历 `skills/*/references/test-fixtures/upstream/README.md`，用 ``/^- `([^`]+)` ← `([^`]+)`$/`` 解析每行；README 里列出的每个文件都要存在，并与 `skills/<源>` 逐字节相同；目录里有、README 没列的 `.json` 也报出来。风格照 `scripts/ids-sync-selftest.mjs`（同样的 `ok` / `passed` 计数与结尾 `✓ N 项自测全部通过`）。
- **VALIDATE**: `node scripts/fixtures-sync-selftest.mjs` 通过；临时改一个夹具字节确认会失败，再还原。

### Task 9: 文档
- 用 scratchpad 里的一次性替换脚本（每处原文恰好出现一次，已改过的跳过）。改动点：
  - `skills/novel-storyboard/SKILL.md`：`version: 3.0.0`；第 12 行门描述；第 44 行核心机制改成 `sceneRef` + `beatIds`；第 109 行"段号 E01-01 格式连号"→"id 齐全且一致"；第 141–143 行目录图改 `sg_…/`、`ct_….png`；新增"写完运行 `ids --write`"一步；第 186 行断言数。
  - `README.md` / `README.en.md`（skill 内）：第 12、37、82、117、133、152 行等；命令区加 `ids` / `migrate`。
  - `references/schema.md`：第 7 行路径；segment 表 `id` → `sg_`（由 `ids` 分配，不要手写）、`sceneIndex` → `sceneRef`；cut 表加 `id`（`ct_`）、`beats` → `beatIds`；episode 加 `id`（照抄剧本，`ep` 是显示缓存）；新增"稳定 id"小节（显示标签按位置推算、插一拍的流程、migrate、`--seed` 只用于样例）；**修第 29 行 `E01-01-f1.png` 与代码不一致**（随新路径一起改掉）；**修第 32 行 `h3Prompt` "默认中文" → 跟 `promptLang`，默认英文**。
  - `references/storyboard-pass.md` 第 13 行：认领写成 `beatIds`，逐拍照抄 seedScenes 的节拍 id，段和切不写 id。
  - `references/frame.md` 第 11 行、`references/h3-prompt.md` 第 49 行（`f1` → 第 1 切的分镜图）、`references/report-style.md` 第 18、23、29、33 行（段号 → 段标签，锚点是段 id）。
  - 根 `README.md` 第 112 行、`README.zh.md` 第 113、229–230、239 行：路径示例与目录图；两份 README 的自测命令列表加 `node scripts/fixtures-sync-selftest.mjs`（`ids-sync-selftest.mjs` 没列也一起加）。
  - `scripts/report.mjs` 第 20、234 行注释。
- **VALIDATE**: `grep -rn "sceneIndex\|E01-01/f\|f<切序>\|<段号>/" skills/novel-storyboard README*.md scripts/report.mjs` 只剩迁移相关说明和代码里的迁移函数。

### Task 10: CHANGELOG / AGENTS.md / 收尾
- `CHANGELOG.md` 顶部新增 `## 3.0.0 — 稳定 id — 2026-10-26`：
  - 一段动机（位置当身份，插一拍、插一场会悄悄挂错）。
  - "破坏性变更与迁移"表，每个 skill 一行：outline（`episodes[].id`、`beats[].episodeRef`）、art（`usage.episodes` 改集 id）、script（场次 / 节拍 id、`hookBeat` 改节拍 id）、staging（`sceneRef`）、storyboard（`sg_` / `ct_`、`sceneRef`、`beatIds`、导出路径）；"怎么迁移"列写各自 `migrate` 命令，并写明**迁移顺序 outline → art / script → staging / storyboard**，下游必须给已迁移的上游。
  - 新命令：`ids`、`migrate`、`renumber`（outline）、`--seed`。
  - 门数：outline 14 → 15、script 10 → 11、staging 8 → 9、storyboard 18 → 18（`segment-id` 换成 `ids`）。
  - 2.x 最后状态打标签 `v2-final`（等确认后再打）。
  - 内部：`ids.mjs` 五份副本 + `ids-sync-selftest.mjs`；`fixtures-sync-selftest.mjs`；characters 的夹具刷新（版本不变）。
  - 自测数一行（实测后填）。
- `AGENTS.md` 行为规则加一条：**身份用 id，不用位置。**集、场次、节拍、段、切都带程序分配的 id（`scripts/ids.mjs`），跨文件引用、门和导出文件名一律按 id；「第 3 集」「E01-02」这类编号只是显示。保留的编号必须有一道门对照 id 指向的真相检查；新写的条目不带 id，运行 `ids --write` 补；只有 `migrate` 允许按位置查找。
- 五个 skill 的 SKILL.md `version` 都是 3.0.0（storyboard 本次改）。
- **提交**（作者 eternityspring，只暂存明确路径）：
  1. `feat(novel-storyboard)!: 段、切用稳定 id，按 id 认领节拍与导出（3.0.0）`
  2. `chore: 夹具一致性检查，CHANGELOG 3.0.0 与 AGENTS.md`

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| ids 门 | 段 id 为 `E01-01` | detail 含"格式不对" | |
| ids 门 | 2.x 段（有 `sceneIndex`） | 提示 `migrate --script` | yes |
| ids 门 | 集号与剧本不同 | "在剧本里是第 N 集" | 显示缓存过期 |
| coverage | 剧本插一拍 | 只点名新的那一拍 | 核心场景 |
| coverage | 交换两切 beatIds | "乱序" | |
| coverage | 认领别的场的 id | "不在…第 N 场" | |
| exportPack | 段重排 | label 变，id 与路径不变 | 核心场景 |
| migrate | 2.x 样例 + 剧本 + 种子 | 与 3.0 样例逐字节相同 | |
| migrate | `beats` 越界 | 点名报错 | yes |
| seed | 剧本缺 id | 抛错提示 `ids --write` | yes |
| fixtures-sync | 改一个字节 | 失败 | 手工验证 |

### Edge Cases Checklist
- [x] 空输入：`gateReport({ episodes: [] }, {})` 仍能列出全部门 id（`stats` 命令依赖）
- [x] 无效类型：`beatIds` 不是数组、含非字符串
- [x] 不带剧本：对账门跳过并明说；ids 门只查本文件内的格式与唯一
- [ ] 并发、网络、权限：不适用

---

## Validation Commands

```bash
cd /Users/lance/Development/ai-video/shuohao-skills-stable-ids
for f in skills/*/scripts/selftest.mjs; do node "$f" | tail -1 || exit 1; done
node scripts/report-selftest.mjs | tail -1
node scripts/ids-sync-selftest.mjs | tail -1
node scripts/fixtures-sync-selftest.mjs | tail -1
S=skills
node $S/novel-storyboard/scripts/novel-storyboard.mjs checkup $S/novel-storyboard/examples/渡口-storyboard.json \
  --script $S/novel-script/examples/渡口-script.json --outline $S/novel-outline/examples/渡口-outline.json \
  --cast $S/novel-characters/examples/渡口-cast.json --art $S/novel-art/examples/渡口-art.json --no-log
node $S/novel-storyboard/scripts/novel-storyboard.mjs export $S/novel-storyboard/examples/渡口-storyboard.json \
  --script $S/novel-script/examples/渡口-script.json --out <scratchpad>/sb-pack   # 看目录是 sg_…/ 与 manifest 的 label
git -C /Users/lance/Development/ai-video/shuohao-skills status --short   # 主目录必须没有改动
```
EXPECT: 全部通过；checkup 18/18；主目录干净。

Static / Build：纯 .mjs，没有类型检查和构建步骤；`node -e "import('./skills/novel-storyboard/scripts/novel-storyboard.mjs')"` 能加载。

### Manual Validation
- [ ] 合并报告 `scripts/report.mjs` 带分镜面板跑一次，段卡显示 `E01-01` 标签与段 id，锚点能跳。

---

## Acceptance Criteria
- [ ] storyboard 里没有任何按位置定身份的查找（`sceneIndex - 1`、`beats.slice`、`f${ci + 1}`），只剩 `migrateStoryboard` 内部
- [ ] 门数 18，`ids` 第一道，每道门有击穿用例
- [ ] 样例与所有夹具和上游逐字节一致，`fixtures-sync-selftest` 通过
- [ ] CHANGELOG、AGENTS.md、README、SKILL.md version、断言数同步
- [ ] 不推送、不打标签；主目录没有改动

## Completion Checklist
- [ ] 代码风格照 novel-script / novel-staging 的 id 部分
- [ ] 报错文案中文、点名到段标签与切号，英文门标签同步
- [ ] 不改入参（assign / migrate）
- [ ] AGENTS.md 中文文案规则（不用单字词）

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 迁移输出键顺序与预期不同，逐字节用例失败 | M | L | Task 4 写明键顺序；失败时以迁移函数输出为准修正"退回 2.x"辅助函数 |
| 覆盖门的报错重复（ids 门与 coverage 同报一件事） | M | L | 空 / 非法 beatIds 只归 ids 门；越场 id 只归 coverage |
| 报告 HTML 有遗漏的 `seg.id` 显示 | M | L | Task 6 完成后 grep `esc(seg.id)`，确认只剩 href / id 显示处 |
| 文件超 800 行软上限 | 已存在 | L | 脚本本来 2,135 行，按 skill 自包含惯例保持单文件，本次不拆 |

## Notes
- 样例种子 `渡口-storyboard`，避免与剧本（`渡口-script`）、大纲（`渡口`）的 id 后缀撞上。
- `seedScenes` 里的节拍 id 让模型照抄——id 较长，但这是设计选择（明确列出每一拍，不用区间）。

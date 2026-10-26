# Plan: 稳定 id ② — novel-script + novel-staging

## Summary
novel-script 3.0.0：
- 集 id 从大纲照抄。
- 每一场带 `sc_` id，每一拍带 `bt_` id。
- `hookBeat` 从 `[场, 拍]` 改成一个 `bt_` id。
- 新增 `ids` 门（第一道，门数 10 → 11）。
- 新增 `ids` / `migrate` 命令。
- 爽点认领改为按集 id 对上大纲。

novel-staging 3.0.0：
- 每场新增 `sceneRef`（`sc_`），作为身份；`ep` / `scene` 保留，作为显示缓存。
- `validate --script` 按 id 查找场次。
- 新增 `ids` 门（第一道，门数 8 → 9），给了剧本时检查显示编号是否一致。
- 新增 `migrate --script` 命令。

## User Story
作为作者，我在剧本里插入一场或一拍之后，站位和钩子认领仍然指向原来那一场、那一拍；指错的地方会被门点名，不会悄悄生效。

## Problem → Solution
站位按 `(ep, scene)` 在剧本里按位置查找，钩子按 `[场, 拍]` 定位，剧本按集号对上大纲爽点 → 场次和节拍有 id，站位按 `sceneRef` 查找，钩子指向节拍 id，爽点按 `episodeRef` 对上集 id；所有显示编号都由门对照真相检查。

## Metadata
- **Complexity**: Large
- **Source PRD**: N/A（设计：`$W/docs/superpowers/specs/2026-10-26-stable-ids-design.md`）
- **PRD Phase**: 稳定 id ②（设计计划的 Task 3–4）
- **Estimated Files**: 约 22 个

---

## UX Design

### Before
```
script.json   scenes: [{ sceneId: S02, flow: [{action}, …] }]   hookBeat: [1, 1]
staging.json  scenes: [{ ep: 1, scene: 2, sceneId: S01, … }]   ← 剧本插一场 → 悄悄挂到别的场
```

### After
```
script.json   episodes: [{ id: ep_…, ep: 1, scenes: [{ id: sc_…, flow: [{ id: bt_…, action }] }], hookBeat: bt_… }]
staging.json  scenes: [{ ep: 1, scene: 2, sceneRef: sc_…, sceneId: S01, … }]
剧本插一场 → 站位按 sceneRef 仍对原来那一场；scene 编号过期 → ids 门：「剧本里是第 3 场，这里写第 2 场」
```

### Interaction Changes
| Touchpoint | Before | After |
|---|---|---|
| 写完剧本 | validate | `ids --write --outline o.json` 再 validate |
| hookBeat | 写 `[场, 拍]` | 写那一拍的 `bt_` id（先运行 `ids`，再从 JSON 里抄） |
| 站位 seed | 按位置 | 照抄 `sceneRef`；剧本缺 id 时报错 |
| 2.x 文件 | — | script：`migrate --outline`；staging：`migrate --script` |

---

## Mandatory Reading

`W=/Users/lance/Development/ai-video/shuohao-skills-stable-ids`，不要改动 `/Users/lance/Development/ai-video/shuohao-skills`。

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `$W/skills/novel-outline/scripts/novel-outline.mjs` | `idProblems` / `assignOutlineIds` / `writeOrPrint` / ids CLI 分支 | **计划 ① 刚写的同类实现，照着写** |
| P0 | `$W/skills/novel-script/scripts/novel-script.mjs` | 124–242（gateReport），248–297（validate），300–323（seed），348–359（GATE_LABELS_EN），529–545、614–650（hookAt / hooked），966–1067（CLI） | |
| P0 | `$W/skills/novel-script/scripts/selftest.mjs` | 1–45，92，148–173（hookBeat 用例），283–298（seed），330，352，373 | |
| P0 | `$W/skills/novel-staging/scripts/novel-staging.mjs` | 347–382（seed），391–393（sceneLabel），421–440（GATES / EN），445–486（stagingProblems / gateReport），1183–1295（CLI） | |
| P0 | `$W/skills/novel-staging/scripts/selftest.mjs` | 35–38（夹具），133–155，202–204，256–260，279 | |
| P1 | 两个 skill 的 `references/schema.md`、`SKILL.md`、`README*.md`；script 的 `script-pass.md`；staging 的 `staging-pass.md` | 上面 grep 出来的行 | 文档 |

## External Documentation
No external research needed.

---

## Patterns to Mirror

### ID_GATE（照计划 ① 的 outline 实现）
```js
// SOURCE: skills/novel-outline/scripts/novel-outline.mjs（idProblems + gateReport 第一位）
function idProblems(eps, beats) {
  const bad = [];
  eps.forEach((e, i) => {
    if (e?.id === undefined) bad.push(`第 ${i + 1} 集缺 id（运行 ids --write）`);
    else if (!isId(e.id, 'ep')) bad.push(`第 ${i + 1} 集的 id「${e.id}」格式不对`);
  });
  for (const id of duplicateIds(eps.map((e) => e?.id).filter(Boolean))) bad.push(`集 id ${id} 重复`);
  ...
}
const idBad = idProblems(eps, beats);
add('ids', 'id 齐全且一致（集 id、爽点归属）', eps.length > 0 && idBad.length === 0, idBad.join('；'));
```

### ASSIGN（照 assignOutlineIds）
```js
// SOURCE: skills/novel-outline/scripts/novel-outline.mjs（assignOutlineIds）
const { items: episodes } = assignIds(outline?.episodes ?? [], 'ep', collectIds(outline), rng);
```
→ script 里要把 `taken` 串起来：先给所有场次补 id，再给所有节拍补 id，用的是同一个 `taken` 集合（`assignIds` 返回更新后的 `taken`）。

### CLI_WRITE（照 writeOrPrint）
```js
// SOURCE: skills/novel-outline/scripts/novel-outline.mjs（writeOrPrint）
function writeOrPrint(path, doc, write, note) {
  const text = JSON.stringify(doc, null, 2) + '\n';
  if (!write) { process.stdout.write(text); return; }
  writeFileSync(resolve(path), text, 'utf8');
  console.error(note);
}
```
→ script 和 staging 各复制一份（skill 自包含，不跨 skill import）。

### GATE_LIST_STAGING
```js
// SOURCE: skills/novel-staging/scripts/novel-staging.mjs:421-430, 474-486
const GATES = [
  { id: 'items-read', label: … },
  …
];
export function gateReport(doc, opts = {}) {
  const problems = stagingProblems(doc, opts);
  return GATES.map((g) => {
    const mine = problems.filter((p) => p.gate === g.id);
    const skipped = g.id === 'cast-complete' && !opts.script;
```
→ staging 的门是"问题列表加门表"的模式：在 `GATES` 第一位加 `{ id: 'ids', label: '每一场都引用剧本场次 id，显示编号与剧本一致' }`；`stagingProblems` 推出 `{ gate: 'ids', text }`；没给剧本时，`skipped` 也算上 `ids`（detail：`未提供 script.json：只查 sceneRef 的格式，没跟剧本核对`）。

### TEST_STRUCTURE
```js
// SOURCE: skills/novel-script/scripts/selftest.mjs:148-161
{
  const doc = clone(FIXTURE);
  doc.episodes[0].hookBeat = [2, 1]; // 第 2 场第 1 拍 = 全集第 14 拍
  const g = gate(doc, 'hook-open');
  ok(!g.ok, '钩子落在第 14 拍被拦——冷开场是门不是建议');
  ok(g.detail.includes('第 14 拍'), '报出实际位置');
}
```

---

## Files to Change

| File | Action |
|---|---|
| `skills/novel-script/scripts/novel-script.mjs` | UPDATE |
| `skills/novel-script/scripts/selftest.mjs` | UPDATE |
| `skills/novel-script/examples/渡口-script.json` | UPDATE（`migrate --outline --seed 渡口`） |
| `skills/novel-script/references/test-fixtures/upstream/渡口-{outline,art}.json` | UPDATE（拷贝 3.0 样例） |
| `skills/novel-script/{SKILL.md,README.md,README.en.md,references/schema.md,references/script-pass.md}` | UPDATE |
| `skills/novel-staging/scripts/novel-staging.mjs` | UPDATE |
| `skills/novel-staging/scripts/selftest.mjs` | UPDATE |
| `skills/novel-staging/examples/渡口-staging.json` | UPDATE（`migrate --script`） |
| `skills/novel-staging/references/test-fixtures/upstream/渡口-{script,art,outline}.json` | UPDATE（拷贝 3.0 样例） |
| `skills/novel-staging/{SKILL.md,README.md,README.en.md,references/schema.md,references/staging-pass.md}` | UPDATE |
| `README.md`、`README.zh.md`（根） | UPDATE（script 门数 10 → 11、staging 8 → 9，如果这里有写） |

## NOT Building
- novel-storyboard（计划 ③）。它的 upstream 剧本夹具仍是 2.x，**这次不动**，自测照常通过。
- CHANGELOG / AGENTS.md / 夹具一致性检查（③ 收尾）。
- 站位的页面算法（`stagingCore`）不动——它不读 `ep` / `scene`。

---

## Step-by-Step Tasks

### Task 1: 夹具换成 3.0 上游
- **ACTION**:
  ```bash
  cd $W/skills
  cp novel-outline/examples/渡口-outline.json novel-script/references/test-fixtures/upstream/
  cp novel-art/examples/渡口-art.json         novel-script/references/test-fixtures/upstream/
  cp novel-outline/examples/渡口-outline.json novel-staging/references/test-fixtures/upstream/
  cp novel-art/examples/渡口-art.json         novel-staging/references/test-fixtures/upstream/
  ```
  staging 的 `渡口-script.json` 等 Task 5 迁移完剧本后再拷贝。
- **VALIDATE**: 两个自测此时仍然通过——2.x 的剧本和站位逻辑不读集 id（如果有失败，记录下来，在 Task 2–3 一并修复）。

### Task 2: novel-script — 自测先行（RED）
- **ACTION**: 改写 / 新增以下用例：
  - :92、:330、:373 的门数 10 → 11（「十一道门」、`✓ 质量门 11 / 11`、`Quality gates 11 / 11`）。
  - hookBeat 用例（:148–173）：
    - `[2, 1]` 改成 `doc.episodes[0].scenes[1].flow[0].id`（仍然是全集第 14 拍）。
    - `[9, 9]` 改成 `'bt_zzzzzzzz'`，断言 detail 含"不在这一集"。
    - 缺 hookBeat 的用例照旧，断言 detail 含 `hookBeat`。
    - 新增：`hookBeat` 是 `[1, 1]` 这种 2.x 写法时，detail 提示改成节拍 id。
  - seed（:283–298）：`seeded.episodes[0].id === OUTLINE.episodes[0].id`；大纲缺集 id 时 seed 抛错，并提示先运行 novel-outline 的 `ids --write`。
  - 新增 `/* ---------------- 稳定 id ---------------- */` 段：
    - 样例的 `ids` 门通过，且是第一道门。
    - 每场 `isId(sc.id, 'sc')`，每拍 `isId(b.id, 'bt')`，`hookBeat` 是 `bt_`。
    - 击穿：
      - 缺场次 id：「第 1 集第 2 场缺 id」
      - 缺节拍 id：「第 1 集第 1 场第 3 拍缺 id」
      - 场次 id 格式错
      - 节拍 id 在全文件里重复（跨场也算）
      - 缺集 id
      - 给了 outline 时集 id 不在大纲里
      - 给了 outline 时 `ep` 与大纲里那一集的集号不一致（「大纲里是第 2 集」）
    - `beats-claimed` 按 `episodeRef` 对上：把大纲某个爽点的 `episodeRef` 改到另一集（同时改 `episode` 保持一致），剧本对应那一集缺认领，被拦。
    - `assignScriptIds(doc, { outline, rng: seededRng('t') })`：
      - 只补缺的、不改入参、同一种子可复现。
      - 缺集 id 时按 `ep` 从大纲补；不给大纲时不补集 id。
      - 在一场的中间插入一拍（不带 id）后运行，只多出一个新 id，其余 id 不变；`hookBeat` 仍指向原来那一拍，全集位置跟着后移（如果移出窗口，hook-open 门会报出来）。
    - `migrateScript(2.x, outline, rng)`：2.x 写法的 `hookBeat [1, 1]` 被换成第一场第一拍的 id；`[9, 9]` 抛错并点名。
    - 渲染：MD 里仍然显示「第 1 场第 1 拍兑现」；HTML 仍有 `act-line hooked`（按 id 判断）。
    - CLI：`ids <f> --outline <o> --seed x` 打印 JSON；`--write` 幂等；`migrate` 缺 `--outline` 时报错。
- **VALIDATE**: RED（缺导出）。

### Task 3: novel-script — 实现（GREEN）
- **IMPLEMENT**:
  1. `import { writeFileSync } from 'node:fs'`（补进现有 import）；`import { assignIds, collectIds, cryptoRng, duplicateIds, isId, seededRng } from './ids.mjs';`
  2. `hookPosition(ep)` → `{ scene, beat, pos } | null`：遍历 `ep.scenes[i].flow[j]`，找到 `id === ep.hookBeat` 的那一拍，返回 1 起算的场号、拍号和全集位置。
  3. `scriptIdProblems(eps, outline)`：
     - 集：`第 ${ep.ep} 集缺集 id（seed 时从大纲照抄；或 ids --outline 补上）` / 格式不对 / 重复。
     - 场：`第 ${ep.ep} 集第 ${j + 1} 场缺 id（运行 ids --write）` / 格式不对。
     - 拍：`第 ${ep.ep} 集第 ${j + 1} 场第 ${k + 1} 拍缺 id` / 格式不对。
     - 场次 id、节拍 id 在全文件内去重（`duplicateIds`）。
     - 给了 outline：`epOf = Map(outline.episodes id → ep)`；集 id 不在大纲里：`第 ${ep.ep} 集的集 id 不在大纲里`；集号不一致：`第 ${ep.ep} 集的集 id 在大纲里是第 ${x} 集`。
  4. `gateReport`：
     - 第一位 `add('ids', 'id 齐全且一致（集 id、场次 id、节拍 id）', eps.length > 0 && bad.length === 0, bad.join('；'))`。
     - hook-open 改为：
       - `!isId(hb, 'bt')`：`${label}缺 hookBeat（填这一集里兑现钩子那一拍的节拍 id）`；如果 `Array.isArray(hb)`，追加「——3.0 起写节拍 id，不写 [场, 拍]；运行 migrate 转换」。
       - `hookPosition` 为 null：`${label}的 hookBeat 指向的节拍不在这一集里`。
       - 否则按 `pos` 走原来的窗口判断。
     - beats-claimed：`filter((b) => b.episodeRef === ep.id)`。
  5. `GATE_LABELS_EN.ids = 'IDs complete and consistent (episode, scene and beat IDs)'`；`hook-open` 的英文标签不变。
  6. `seedFromOutline`：
     - 大纲有集但缺 id 时抛 `Error('大纲还没有集 id：先运行 novel-outline 的 ids --write')`。
     - 每集写 `{ id: e.id, ep: e.ep, … }`（id 放第一个键）。
     - 爽点认领按 `episodeRef`：`b.episodeRef === e.id`。
  7. `export function assignScriptIds(doc, { outline = null, rng = cryptoRng } = {})`：
     - 集：缺 id 且给了大纲 → 按 `ep` 映射补上，放在第一个键。
     - 场次：`assignIds`。
     - 节拍：`assignIds`，`taken` 串起来。
     - 返回新文档。
  8. `export function migrateScript(doc, outline, rng = cryptoRng)`：
     - 先 `assignScriptIds`。
     - 再把数组形式的 `hookBeat` 换成 `scenes[s-1].flow[b-1].id`；找不到时抛 `Error('第 N 集的 hookBeat [s, b] 指向不存在的节拍')`。
     - 没给大纲时抛错（集 id 只能来自大纲）。
  9. 渲染：
     - `t.hookAt(...)` 两处改成 `const hp = hookPosition(ep); hp ? t.hookAt(hp.scene, hp.beat) : ''`。
     - HTML `hooked` 改成 `b.id !== undefined && b.id === ep.hookBeat`。
  10. CLI：
      - `ids <script.json> [--outline o.json] [--write] [--seed s]`：stderr 报告补了多少场次和节拍、多少集 id。
      - `migrate <2.x script.json> --outline <3.0 outline.json> [--write] [--seed s]`。
      - USAGE 同步更新；复制一份 `writeOrPrint`。
- **GOTCHA**:
  - `computeStats` 和其余门不读 id，不要改。
  - `assignIds` 返回 `{ items, taken }`，节拍要逐场处理，每次都把 `taken` 传下去。
  - 新键 `id` 放在对象第一位（`assignIds` 已经这样做）。
- **VALIDATE**: script 自测 GREEN 以前，先完成 Task 4 迁移样例。

### Task 4: 迁移 script 样例
- **ACTION**: `node scripts/novel-script.mjs migrate examples/渡口-script.json --outline references/test-fixtures/upstream/渡口-outline.json --seed 渡口 --write`；然后运行 `validate --outline … --art …` 和 `checkup`（11/11）。
- **VALIDATE**:
  - script 自测通过。
  - diff 里只有新增的 `"id"` 行，以及 6 处 `hookBeat` 由数组变成 id。
  - 其余 6 个 skill 的自测通过。

### Task 5: novel-staging — 夹具与自测先行（RED）
- **ACTION**:
  - `cp ../novel-script/examples/渡口-script.json references/test-fixtures/upstream/`
  - 改写以下用例：
    - :152 门数 8 → 9（「九道门」）。
    - :279 `✓ 质量门 9/9`。
    - seed 用例：每场 `isId(s.sceneRef, 'sc')`，且等于剧本对应场次的 id；剧本缺场次 id 时 seed 抛错，并提示先运行 novel-script 的 `ids --write`。
  - 新增稳定 id 段：
    - 样例的 `ids` 门通过。
    - 击穿：
      - 缺 `sceneRef`
      - 格式错
      - 两场 `sceneRef` 相同
      - 给了剧本时 `sceneRef` 不在剧本里
      - 给了剧本时 `scene` 编号与剧本位置不一致（「剧本里是第 1 集第 2 场」）
      - 没给剧本时，ids 门的 detail 明说没核对
    - **剧本插一场**：在剧本第 1 集的开头插入一场带新 id 的场次，用这份剧本校验原站位：
      - `cast-complete` 仍然通过——按 id 找到了原来那一场，没有按位置错配。
      - `ids` 门点名场号过期。
    - `migrateStaging(2.x, script)`：
      - `sceneRef` 跟原来按位置查找的结果一致，放在 `scene` 之后。
      - 不改入参。
      - 找不到对应场次时抛错并点名。
    - CLI：`migrate --script` 打印结果 / `--write`；缺 `--script` 时报错。
- **VALIDATE**: RED。

### Task 6: novel-staging — 实现（GREEN）
- **IMPLEMENT**:
  1. `import { isId, duplicateIds } from './ids.mjs';`；`writeFileSync` 补进现有 import。
  2. `scriptSceneIndex(script)` → `Map(sc.id → { ep: ep.ep, scene: j + 1, sc })`。
  3. `seedFromScript`：
     - 剧本里有场次缺 `sc_` id 时抛 `Error('剧本还没有场次 id：先运行 novel-script 的 ids --write')`。
     - 每场写 `{ ep, scene, sceneRef: sc.id, sceneId, … }`。
  4. `stagingProblems`：
     - 先查 `sceneRef`：缺失 / 格式不对 / `duplicateIds` 重复，记为 `{ gate: 'ids' }`。
     - 给了剧本时，用 `scriptSceneIndex` 查找：
       - 找不到：`{ gate: 'ids', text: '${label} 的 sceneRef 不在 script.json 里' }`
       - 编号不一致：`{ gate: 'ids', text: '${label} 的编号过期：剧本里是第 ${x.ep} 集第 ${x.scene} 场（改 ep / scene 或重新 seed）' }`
     - `cast-complete` 的查找从按位置（:460）改成用 `sceneRef` 查到的 `sc`。找不到时只报 ids 门，不在 `cast-complete` 重复报。
  5. `GATES` 第一位加 `ids`；`GATE_LABELS_EN.ids = 'Every scene references a script scene ID; display numbers match the script'`。`gateReport` 的跳过判断：`(g.id === 'cast-complete' || g.id === 'ids') && !opts.script`；ids 门跳过时的 detail 单独写。
  6. `export function migrateStaging(doc, script)`：
     - 按 `(ep, scene)` 找剧本里的 `episodes.find((e) => e.ep === s.ep).scenes[s.scene - 1]`。
     - 用 `Object.entries` 重建对象，把 `sceneRef` 插在 `scene` 之后。
     - 找不到时抛 `Error('第 N 集第 M 场在剧本里找不到')`。
     - 已经有 `sceneRef` 的场原样保留。
  7. CLI：`migrate <2.x staging.json> --script <3.0 script.json> [--write]`；USAGE 同步更新；复制一份 `writeOrPrint`。
- **GOTCHA**:
  - `stagingCore()` 是用 `toString()` 嵌进页面的，**不能引用外部的任何东西**——本次不改它。
  - `sceneLabel` 不变。
  - `migrateStaging` 迁移的是 2.x 站位，查找时**按位置**是对的（2.x 本来就按位置），这是唯一允许的按位置查找，加注释说明。
- **VALIDATE**: 迁移样例（Task 7）之后 GREEN。

### Task 7: 迁移 staging 样例
- **ACTION**:
  - `node scripts/novel-staging.mjs migrate examples/渡口-staging.json --script references/test-fixtures/upstream/渡口-script.json --write`
  - `validate … --script … --art …` 和 `checkup`（9/9）。
- **VALIDATE**:
  - staging 自测通过（含页面算法重建）。
  - diff 只多 9 行 `sceneRef`。

### Task 8: 文档
- **script**：
  - `schema.md`：episode 表加 `id`（照抄大纲）；scene、beat 表加 `id`（`ids` 分配，不要手写）；`hookBeat` 一行改成 `bt_` 节拍 id；新增"稳定 id"小节（`ids --outline`、插一拍、`migrate`、`--seed` 只用于样例）。
  - `script-pass.md` 第 6 条：`hookBeat` 写节拍 id。
  - `SKILL.md`：写完运行 `ids --write --outline`；门数 11；`version: 3.0.0`；hookBeat 的写法；断言数。
  - `README` 中英文：门表加 `ids`、命令、断言数。
- **staging**：
  - `schema.md`：scene 表加 `sceneRef`，`ep` / `scene` 标为显示缓存。
  - `staging-pass.md` 示例 JSON 加 `sceneRef`。
  - `SKILL.md`：seed 前提（剧本先补 id）、门数 9、`version: 3.0.0`、`migrate`、断言数。
  - `README` 中英文同步。
- **根 README**：如果写了 script / staging 门数，同步更新。
- 使用和计划 ① 一样的一次性 Node 替换脚本（每处原文恰好出现一次，已改过的跳过）。
- **VALIDATE**: 断言数与自测输出一致；`grep` 检查不残留 `[场, 拍]` 这种 2.x 写法（CHANGELOG 除外）。

### Task 9: 提交
- 作者 `eternityspring`，只暂存明确的路径。
- 两个提交：
  - `feat(novel-script)!: 场次与节拍 id、hookBeat 指向节拍（3.0.0）`
  - `feat(novel-staging)!: 场次按 sceneRef 对账剧本（3.0.0）`

---

## Testing Strategy

| Test | Expected | Edge? |
|---|---|---|
| ids 门 7 种击穿（script） | 各自点名 | ✓ |
| hookBeat：缺 / 2.x 数组 / 悬空 / 超窗 | 各自的提示 | ✓ |
| 插一拍 | 只多一个 id；hookBeat 跟着原来那一拍 | ✓ |
| 爽点认领按 episodeRef | 改归属后被拦 | ✓ |
| staging ids 门 6 种 | 各自点名，没给剧本时明说 | ✓ |
| 剧本插一场 | cast-complete 仍然对，ids 门点名场号过期 | ✓ |
| 两个 migrate | 结果等于 3.0 样例，不改入参，找不到时点名 | ✓ |
| CLI ids / migrate | 打印、写回、幂等、缺参数报错 | ✓ |

## Validation Commands
```bash
W=/Users/lance/Development/ai-video/shuohao-skills-stable-ids; cd $W
node scripts/ids-sync-selftest.mjs | tail -1
for f in skills/*/scripts/selftest.mjs; do printf "%s: " "$f"; node "$f" 2>&1 | tail -1; done
node scripts/report-selftest.mjs | tail -1
S=skills
node $S/novel-script/scripts/novel-script.mjs checkup $S/novel-script/examples/渡口-script.json --outline $S/novel-outline/examples/渡口-outline.json --art $S/novel-art/examples/渡口-art.json | tail -1
node $S/novel-staging/scripts/novel-staging.mjs checkup $S/novel-staging/examples/渡口-staging.json --script $S/novel-script/examples/渡口-script.json --art $S/novel-art/examples/渡口-art.json | tail -1
for f in 渡口-outline 渡口-art; do cmp $S/novel-outline/examples/$f.json $S/novel-script/references/test-fixtures/upstream/$f.json 2>/dev/null || cmp $S/novel-art/examples/$f.json $S/novel-script/references/test-fixtures/upstream/$f.json; done
cmp $S/novel-script/examples/渡口-script.json $S/novel-staging/references/test-fixtures/upstream/渡口-script.json
node scripts/report.mjs --outline $S/novel-outline/examples/渡口-outline.json --script $S/novel-script/examples/渡口-script.json --art $S/novel-art/examples/渡口-art.json --out /tmp/x.html
git -C /Users/lance/Development/ai-video/shuohao-skills status --short | wc -l   # 0
```
EXPECT：全部通过；script 11/11、staging 9/9；夹具逐字节一致；storyboard 自测照旧通过。

## Acceptance Criteria
- [ ] Task 1–9 完成，验证命令全部通过
- [ ] 每条新规则都有击穿用例
- [ ] 显示缓存（script 的 `ep`、staging 的 `ep` / `scene`）都有门对照真相检查
- [ ] 文档、断言数、版本号同步

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| staging 页面的嵌入算法被误改 | L | H | 不碰 `stagingCore`；重建测试兜底 |
| 合并报告给 script 面板传参数时漏掉 outline | L | L | report 的 script 面板 `needs` 已含 `--outline`（:90） |
| storyboard 自测意外依赖 script 样例 | L | M | 它读自己的 upstream 副本；每个任务结束都跑全部自测 |

## Notes
- `migrateStaging` 是整个 3.0 里唯一允许按位置查找的地方：2.x 数据本来就按位置定位，迁移就是把它一次性翻译成 id。

# Plan: 稳定 id ① — 公共 ids 模块 + novel-outline + novel-art

## Summary
在 shuohao-skills 里加入程序分配的稳定 id：先做五个 skill 共用（各自一份、逐字节相同）的 `ids.mjs`，再让 novel-outline 给每一集分配 `ep_` id、给爽点绑定 `episodeRef`，并新增 `ids` 门、`ids` / `renumber` / `migrate` 命令；novel-art 的 `usage.episodes` 改为集 id。这是三份计划中的第一份，后两份（script + staging、storyboard）依赖这里产出的 3.0 大纲样例。

## User Story
作为使用这条流水线的作者，我希望每一集有不随插入、重排而改变的 id，下游按 id 对账，这样我在中间插入一集时，爽点、美术用量和下游剧本都不会悄悄指错集。

## Problem → Solution
集只靠 `ep` 集号识别，爽点按集号挂集，美术存集号列表 → 每一集有 `ep_` id；爽点用 `episodeRef` 绑定（`episode` 集号作为显示缓存，由门检查一致）；美术存集 id；插入一集时，门会强制运行 `renumber`。

## Metadata
- **Complexity**: Large
- **Source PRD**: N/A（来源：`/Users/lance/Development/ai-video/shuohao-skills-stable-ids/docs/superpowers/specs/2026-10-26-stable-ids-design.md`）
- **PRD Phase**: N/A（稳定 id 三份计划之 ①；对应设计计划的 Task 0–2）
- **Estimated Files**: 约 22 个

---

## UX Design

### Before
```
outline.json  episodes: [{ ep: 3, ... }]   beats: [{ id: B02, episode: 3 }]
art.json      usage: { episodes: [1, 6] }
在第 2、3 集之间插一集 → 手工把后面所有 ep 加一、爽点 episode 加一、美术用量也要改
                         漏改任何一处 → 不报错，悄悄指错集
```

### After
```
outline.json  episodes: [{ id: ep_k3f9q2xa, ep: 3, ... }]
              beats: [{ id: B02, episode: 3, episodeRef: ep_k3f9q2xa }]
art.json      usage: { episodes: [ep_…, ep_…] }   （render --outline 显示成 1、6）
插一集 → ids --write 补 id → 「集号从 1 连续」门报错 → renumber --write 一次改齐
         手工改错集号 → ids 门：B02 指向的集是第 4 集，episode 却写 3
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 写完分集 | 直接 validate | 先 `ids --write` 再 validate | SKILL.md Step 5 写明 |
| 插入一集 | 手工重编号 | `ids --write` + `renumber --write` | |
| 2.x 大纲 | — | `migrate`（等同 `ids`） | |
| 美术报告 | 显示集号 | `--outline` 时显示集号，否则显示「N 集」 | |

---

## Mandatory Reading

工作目录 `W=/Users/lance/Development/ai-video/shuohao-skills-stable-ids`（git worktree，分支 `feat/stable-ids`）。**不要在** `/Users/lance/Development/ai-video/shuohao-skills` 里改动（那是 `~/.claude/skills` 软链指向的、正在使用的版本）。

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `$W/docs/superpowers/specs/2026-10-26-stable-ids-design.md` | all | 设计依据，含"显示缓存模式" |
| P0 | `$W/AGENTS.md` | all | 中文不用单字词；skill 自包含；样例各用各的 |
| P0 | `$W/skills/novel-outline/scripts/novel-outline.mjs` | 1–8, 178–348, 363–521, 587–620, 1555–1682 | 门、validate、英文门标签、CLI |
| P0 | `$W/skills/novel-outline/scripts/selftest.mjs` | 1–45, 84, 107, 597 | 测试写法、门数断言 |
| P1 | `$W/skills/novel-art/scripts/novel-art.mjs` | 20–82, 213–300, 380–460, 481–650, 935–1035 | seed、validate、i18n、render、CLI |
| P1 | `$W/skills/novel-art/scripts/selftest.mjs` | 1–40, 79–121, 252–260, 258–470 | |
| P1 | `$W/skills/novel-outline/references/schema.md` | 1–104 | 要更新的文档 |
| P2 | `$W/skills/character-refs/scripts/core.mjs` | 4, 81 | 仓库里唯一的 `node:crypto` 用法 |

## External Documentation
No external research needed — 只用 Node 标准库的 `node:crypto.randomBytes`。

---

## Patterns to Mirror

### NAMING_CONVENTION
```js
// SOURCE: skills/novel-outline/scripts/novel-outline.mjs:18-19, 361
export const ADAPT_MODES = ['忠实', '抽核', '借壳'];
export const BEAT_WEIGHTS = ['major', 'minor'];
export const STAGES = ['skeleton', 'beats', 'full'];
```
→ 常量 UPPER_SNAKE；导出的纯函数 camelCase；注释用中文，讲"为什么"。

### FILE_HEADER
```js
// SOURCE: skills/novel-outline/scripts/novel-outline.mjs:1-8
#!/usr/bin/env node
// novel-outline — deterministic helpers for the novel-outline skill.
// Zero dependencies on purpose: the skill must work in any directory
// without an npm install. Node 18+ (stdlib only).
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
```

### GATE_PATTERN
```js
// SOURCE: skills/novel-outline/scripts/novel-outline.mjs:178-184, 330-336
export function gateReport(outline) {
  const th = thresholdsOf(outline);
  const gates = [];
  const add = (id, label, ok, detail = '', enKey = null) =>
    gates.push({ id, label, ok, detail, ...(enKey ? { enKey } : {}) });
  ...
  add('refs', hasProps ? '…' : '…', eps.length > 0 && refBad.length === 0, refBad.join('；'), hasProps ? 'refs-props' : null);
```
→ 新门用 `add('ids', 'id 齐全且一致（集 id、爽点归属）', ok, bad.join('；'))`，放在 `gates` 的**第一位**。`GATE_LABELS_EN`（:587）加 `ids: 'IDs complete and consistent (episode ids, beat ownership)'`。

### VALIDATE_PROBLEMS
```js
// SOURCE: skills/novel-outline/scripts/novel-outline.mjs:504-514
eps.forEach((e, i) => {
  if (e?.ep !== i + 1) p(`第 ${i + 1} 个条目的 ep 是 ${e?.ep}，编号必须从 1 连续`);
  ...
});
for (const g of gateReport(outline)) {
  if (g.id === 'beat-gap' || g.id === 'major-early') continue;
  if (!g.ok) p(`质量门未过：${g.label}${g.detail ? `（${g.detail}）` : ''}`);
}
```
→ full 档会自动带出 `ids` 门的失败，不需要另写。beats 档只看 beat-gap / major-early，不受 `ids` 门影响（这时分集还没写）。

### CLI_PATTERN
```js
// SOURCE: skills/novel-outline/scripts/novel-outline.mjs:1608-1621
if (cmd === 'validate') {
  const [path] = rest;
  if (!path) throw new Error('用法：validate <outline.json> [--stage skeleton|beats|full]');
  ...
  console.log(`✓ 通过校验（stage=${stage}）`);
  return;
}
```
→ 新命令 `ids` / `renumber` / `migrate`：`const [path] = rest`；结果用 `JSON.stringify(doc, null, 2) + '\n'` 输出——`--write` 写回原文件，否则打印到 stdout；写回后 stderr 打印 `✓ 补了 N 个 id`。

### TEST_STRUCTURE
```js
// SOURCE: skills/novel-outline/scripts/selftest.mjs:32-42
let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(actual, expected, msg) { assert.strictEqual(actual, expected, `${msg} — 期望 ${expected}，实际 ${actual}`); passed++; }
const clone = () => JSON.parse(JSON.stringify(FIXTURE));
const gate = (o, id) => gateReport(o).find((g) => g.id === id);
```
→ 每条新规则都要有击穿用例：`clone()` 后改坏，断言门 `ok === false`，`detail` 里点名。

### JSON_FORMAT
样例文件的格式恰好是 `JSON.stringify(doc, null, 2) + '\n'`（已核对 `渡口-outline.json`）。`--write` 必须用同样的格式写回，保证 git diff 只显示真正的改动。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `skills/novel-outline/scripts/ids.mjs` | CREATE | 权威副本 |
| `skills/{novel-art,novel-script,novel-staging,novel-storyboard}/scripts/ids.mjs` | CREATE | 逐字节相同的副本（自包含） |
| `scripts/ids-sync-selftest.mjs` | CREATE | 副本一致 + ids 模块行为 |
| `skills/novel-outline/scripts/novel-outline.mjs` | UPDATE | ids 门、assign / renumber、CLI |
| `skills/novel-outline/scripts/selftest.mjs` | UPDATE | 新用例；门数 14 → 15 |
| `skills/novel-outline/examples/渡口-outline.json` | UPDATE | `ids --seed 渡口 --write` 迁移 |
| `skills/novel-outline/references/schema.md`、`episode-pass.md` | UPDATE | id 字段、显示缓存、插入一集的流程 |
| `skills/novel-outline/SKILL.md`、`README.md`、`README.en.md` | UPDATE | Step 5 的 `ids --write`、命令表、断言数、版本 3.0.0 |
| `skills/novel-art/scripts/novel-art.mjs` | UPDATE | seed 用集 id；validate；render `--outline`；`migrate` |
| `skills/novel-art/scripts/selftest.mjs` | UPDATE | |
| `skills/novel-art/examples/渡口-art.json` | UPDATE | `migrate --outline` |
| `skills/novel-art/references/test-fixtures/upstream/渡口-outline.json` | UPDATE | 换成 3.0 大纲（逐字节拷贝） |
| `skills/novel-art/references/schema.md`、`SKILL.md`、`README*.md` | UPDATE | |

## NOT Building
- novel-script / staging / storyboard 的改动（②③ 计划）。它们的 upstream 夹具在本计划里**不动**，仍是 2.x 副本，自测照常通过。
- CHANGELOG、根 README、AGENTS.md 的 3.0.0 条目（③ 计划收尾时统一写）。
- 不打标签、不推送。

---

## Step-by-Step Tasks

### Task 1: `ids.mjs` 权威副本
- **ACTION**: 新建 `skills/novel-outline/scripts/ids.mjs`。
- **IMPLEMENT**:
  ```js
  // 稳定 id：集、剧本场次、节拍、分镜段、分镜切的身份。由程序分配，模型不写；已有的 id 永远不改。
  // 这个文件在 novel-outline / novel-art / novel-script / novel-staging / novel-storyboard 各有一份，
  // 必须逐字节相同（scripts/ids-sync-selftest.mjs 会查）——改的时候五份一起改。
  import { createHash, randomBytes } from 'node:crypto';

  export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford：去掉 i l o u
  export const ID_LENGTH = 8;
  export const ID_PREFIXES = ['ep', 'sc', 'bt', 'sg', 'ct'];
  export const ID_RE = /^(ep|sc|bt|sg|ct)_[0-9a-hjkmnp-tv-z]{8}$/;
  const MAX_TRIES = 64;

  export const isId = (x, prefix = null) =>
    typeof x === 'string' && ID_RE.test(x) && (prefix === null || x.startsWith(`${prefix}_`));

  /** 加密随机：256 是 32 的倍数，取低 5 位没有偏差。 */
  export const cryptoRng = () => randomBytes(1)[0] & 31;

  /** 确定性随机：只给样例迁移和自测使用（--seed）。种子文本 → sha256 → mulberry32。 */
  export function seededRng(seed) {
    let a = createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) & 31;
    };
  }

  export function newId(prefix, taken = new Set(), rng = cryptoRng) {
    if (!ID_PREFIXES.includes(prefix)) throw new Error(`未知的 id 前缀：${prefix}`);
    for (let i = 0; i < MAX_TRIES; i++) {
      let body = '';
      for (let k = 0; k < ID_LENGTH; k++) body += ID_ALPHABET[rng()];
      const id = `${prefix}_${body}`;
      if (!taken.has(id)) return id;
    }
    throw new Error(`连续 ${MAX_TRIES} 次撞上已有 id，随机源可能坏了`);
  }

  /** 文档里所有已用的 id（任意深度、任意字段名为 id 的合法 id）。 */
  export function collectIds(doc) {
    const seen = new Set();
    const walk = (x) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') {
        if (isId(x.id)) seen.add(x.id);
        Object.values(x).forEach(walk);
      }
    };
    walk(doc);
    return seen;
  }

  /** 给缺 id 的条目补 id；已有 id 原样保留。返回新数组和更新后的已用集合，不改入参。 */
  export function assignIds(items, prefix, taken, rng = cryptoRng) {
    const used = new Set(taken);
    const out = (items ?? []).map((it) => {
      if (!it || typeof it !== 'object' || it.id !== undefined) return it;
      const id = newId(prefix, used, rng);
      used.add(id);
      return { id, ...it };
    });
    return { items: out, taken: used };
  }

  /** 同一文件内 id 重复检查：返回重复的 id 列表。 */
  export function duplicateIds(ids) {
    const seen = new Set();
    const dup = new Set();
    for (const id of ids) (seen.has(id) ? dup : seen).add(id);
    return [...dup];
  }
  ```
- **MIRROR**: FILE_HEADER（零依赖）、NAMING_CONVENTION。
- **GOTCHA**: `{ id, ...it }` 让 id 排在对象的第一个键，样例 diff 更好读。`it.id !== undefined` 时一律不动，包括格式错的 id——是否合法交给门去判断，`ids` 不替人掩盖。
- **VALIDATE**: Task 3 的同步自测。

### Task 2: 复制四份副本
- **ACTION**: `for s in novel-art novel-script novel-staging novel-storyboard; do cp skills/novel-outline/scripts/ids.mjs skills/$s/scripts/ids.mjs; done`
- **GOTCHA**: 以后改动只改 outline 那一份再拷贝；同步自测会拦下不一致。
- **VALIDATE**: `cmp` 五份副本。

### Task 3: `scripts/ids-sync-selftest.mjs`
- **ACTION**: 新建，风格同 `scripts/report-selftest.mjs`（`ok` / `eq` + 结尾打印 `✓ N 项自测全部通过`）。
- **IMPLEMENT**（断言）：
  - 五份副本逐字节相同。
  - `newId('sc', new Set(), seededRng('x'))` 两次结果相同，且匹配 `ID_RE`。
  - 未知前缀抛错。
  - `rng` 恒返回 0 时：第一次得到 `sc_00000000`；`taken` 里已有它时连续撞号，`MAX_TRIES` 次后抛错。
  - `assignIds` 不改入参（`deepStrictEqual` 对比原对象）、只补缺的、补的 id 互不重复且不在 `taken` 里。
  - `collectIds` 能找到嵌套的 id。
  - `duplicateIds(['a', 'b', 'a'])` 得到 `['a']`。
  - `cryptoRng` 抽 1,000 次，值都落在 0–31。
- **VALIDATE**: `node scripts/ids-sync-selftest.mjs`

### Task 4: novel-outline — 自测先行（RED）
- **ACTION**: 在 `selftest.mjs` 末尾的汇总打印之前，新增 `/* ---------------- 稳定 id ---------------- */` 段；更新门数断言 :84、:107、:597（14 → 15）。
- **IMPLEMENT**（断言）：
  - 样例（迁移后）：`gate(FIXTURE, 'ids').ok`；每集 `isId(e.id, 'ep')`；每个爽点 `episodeRef` 都在。
  - 击穿用例：
    - 删掉一集的 `id` → `ids` 门失败，detail 含"第 N 集缺 id"。
    - id 格式错（`'ep_1'`）→ 失败。
    - 两集 id 相同 → 失败，提到"重复"。
    - 爽点 `episodeRef` 悬空 → 失败。
    - 爽点 `episode` 与 `episodeRef` 所指那一集的 `ep` 不一致 → 失败，detail 点名爽点 id。
    - 爽点缺 `episodeRef`（而分集已写）→ 失败。
  - `assignOutlineIds(o, seededRng('t'))`：给缺 id 的集补上；已有 id 不变；按 `episode` 补上 `episodeRef`；已有的 `episodeRef` 不改；不改入参；同一种子结果可复现。
  - 插入一集：
    1. 在 index 2 处插入一条无 id、`ep: null` 的分集。
    2. 运行 `assignOutlineIds`，再运行 `renumberOutline`。
    3. 断言：所有 `ep` 等于位置 + 1；原第 3 集现在 `ep === 4`，id 不变；原来挂在第 3 集的爽点 `episode === 4`，`episodeRef` 不变。
    4. 插入后、`renumber` 之前，`validateOutline` 报"编号必须从 1 连续"。
  - beats 档（没有 episodes）`validateOutline(o, 'beats')` 不因 `ids` 门失败（beats 档本来就只看两道门）。
  - CLI（`spawnSync(process.execPath, [SCRIPT, 'ids', tmp, '--seed', 'x'])`）：
    - stdout 是合法 JSON，且带 id。
    - `--write` 写回后再运行一次不变（幂等）。
    - `renumber --write` 写回后 `validate` 通过。
    - `migrate` 与 `ids` 输出相同。
- **MIRROR**: TEST_STRUCTURE。
- **VALIDATE**: `node skills/novel-outline/scripts/selftest.mjs` 失败（RED）。

### Task 5: novel-outline — 实现（GREEN）
- **IMPLEMENT**：
  1. `import { assignIds, collectIds, cryptoRng, duplicateIds, isId, seededRng } from './ids.mjs';`
  2. `export function assignOutlineIds(outline, rng = cryptoRng)`：
     - `const { items: episodes } = assignIds(outline.episodes ?? [], 'ep', collectIds(outline), rng)`
     - `const byEp = new Map(episodes.filter((e) => isId(e?.id, 'ep')).map((e) => [e.ep, e.id]))`
     - `beats = (outline.beats ?? []).map((b) => b?.episodeRef !== undefined || !byEp.has(b?.episode) ? b : { ...b, episodeRef: byEp.get(b.episode) })`
     - 返回 `{ ...outline, episodes, beats }`
  3. `export function renumberOutline(outline)`：`episodes.map((e, i) => ({ ...e, ep: i + 1 }))`；`byId = Map(id → ep)`；有 `episodeRef` 且在 `byId` 里的爽点改写 `episode`；`params.episodes` 若存在且不等于新集数，同步更新（插入一集等于加一集）。
  4. `gateReport` 第一位加 `ids` 门：
     - `bad` 收集以下问题：
       - `第 ${i + 1} 集缺 id` / `id 格式不对`
       - `duplicateIds(eps.map((e) => e?.id).filter(Boolean))`：`集 id ${id} 重复`
       - 当 `eps.length > 0` 时，对每个爽点检查：
         - 缺 `episodeRef`：`爽点 ${b.id} 缺 episodeRef（运行 ids --write）`
         - 悬空：`爽点 ${b.id} 的 episodeRef 不在分集里`
         - 不一致：`爽点 ${b.id} 写的是第 ${b.episode} 集，episodeRef 指向第 ${target.ep} 集`
     - `ok = eps.length > 0 && bad.length === 0`
  5. `GATE_LABELS_EN` 加 `ids`。
  6. CLI：
     - USAGE 增加三行：`ids <outline.json> [--write] [--seed s]`、`renumber <outline.json> [--write]`、`migrate <2.x outline.json> [--write] [--seed s]`（迁移 2.x 大纲，等同 ids）。
     - 一个 `writeOrPrint(path, doc, write, note)` 帮手函数；`ids` 与 `migrate` 共用一个分支；`--seed` 存在时用 `seededRng(seed)`。
     - 写回后 stderr 打印 `✓ 补了 ${n} 个集 id、${m} 个爽点归属`（`n`、`m` 按新旧对比计算）。
- **IMPORTS**: 见第 1 点。
- **GOTCHA**:
  - `renumber` 只改 `ep` 和爽点的 `episode`，不碰 id。
  - 没有 `episodeRef` 的爽点在 renumber 时保持原样，`ids` 门会把它报出来。
  - `writeFileSync` 前 import `writeFileSync`（已经导入）。
- **VALIDATE**: outline 自测通过（GREEN）。

### Task 6: 迁移 outline 样例
- **ACTION**: `node skills/novel-outline/scripts/novel-outline.mjs migrate skills/novel-outline/examples/渡口-outline.json --seed 渡口 --write`，然后 `validate` 通过、`checkup` 15/15。
- **GOTCHA**: 只有这一份样例使用 `--seed`，以后不再重新生成（id 一旦定下就提交固定）。`git diff` 应该只出现新增的 `id` 和 `episodeRef` 行。
- **VALIDATE**: `git diff --stat` 只涉及该样例；自测通过。

### Task 7: novel-art — 自测先行（RED）
- **ACTION**:
  - 用迁移后的大纲覆盖 `skills/novel-art/references/test-fixtures/upstream/渡口-outline.json`（`cp`）。
  - 改写 :84、:100 两处（`usage.episodes` 变成 id，断言可以写成 `.map(idToEp).join(',') === '1,2,3,4,5,6'`）。
- **IMPLEMENT**（新断言）：
  - seed 产出的 `usage.episodes` 每项都满足 `isId(x, 'ep')`。
  - 大纲缺集 id 时 `seedFromOutline` 抛错，消息提示先运行 novel-outline 的 `ids --write`。
  - `validateArt` 拦下 `usage.episodes: [1]`（不是集 id）。
  - `renderMarkdown(FIXTURE, null, { outline: OUTLINE })` 显示集号（`1、2、3、4、5、6`）；不给 outline 时显示「6 集」。
  - `migrateArt(2.x art, OUTLINE)`：集号换成 id；集号在大纲里找不到时抛错并点名；不改入参。
  - CLI `render --outline`、`migrate --outline` 冒烟测试。
- **VALIDATE**: art 自测失败（RED）。

### Task 8: novel-art — 实现（GREEN）
- **IMPLEMENT**:
  - `import { isId } from './ids.mjs';`
  - `seedFromOutline`：先检查 `eps.every((e) => isId(e?.id, 'ep'))`，否则抛 `Error('大纲还没有集 id：先运行 novel-outline 的 ids --write')`。场景和道具的 `episodes` 改用 `.map((e) => e.id)`；`carried`（承载爽点）的计算改为按 `episodeRef` 匹配：`beats.filter((b) => idSet.has(b.episodeRef))`。
  - validate 两处（:251、:292）：`usage.episodes` 必须是数组且每项 `isId(x, 'ep')`，否则报 `[label] usage.episodes 必须是集 id 数组`。
  - render：`renderMarkdown(doc, lang = null, ctx = {})` / `renderHtml(doc, lang = null, ctx = {})`。新增 `episodesText(ids, ctx, t)`：有 `ctx.outline` 就把 id 映射成 `ep` 并用 `t.listSep` 连接；映射不到的 id 显示成 `?`；没有 outline 就显示 `t.epsCount(ids.length)`。i18n 的 zh / en 各加一条 `epsCount`。替换 :490、:519、:581、:590、:608、:646 六处。
  - `export function migrateArt(art, outline)`：建立 `ep → id` 映射，把场景和道具的 `usage.episodes` 换成 id；找不到就抛 `Error('第 N 集在大纲里没有对应的集 id')`；返回新对象。
  - CLI：`render` 支持 `--outline`；新增 `migrate <2.x art.json> --outline <3.0 outline.json> [--write]`；USAGE 同步。
- **GOTCHA**: `render` 里用来挂图的 `item.sheetImage = …`（:1012）会修改 doc——这是现有代码，不在本次范围；新代码不要再新增这种修改。
- **VALIDATE**: art 自测通过。

### Task 9: 迁移 art 样例
- **ACTION**: `node skills/novel-art/scripts/novel-art.mjs migrate skills/novel-art/examples/渡口-art.json --outline skills/novel-outline/examples/渡口-outline.json --write`，然后 `validate --cast`、`checkup` 10/10 通过。
- **VALIDATE**: diff 只涉及 `usage.episodes`。

### Task 10: 文档
- **novel-outline**：
  - `schema.md`：示例 JSON 加 `id` 和 `episodeRef`；episodes 表加 `id` 行；beats 表加 `episodeRef` 行，并写明显示缓存规则；新增"插入一集"小节（`ids` → `renumber`）；"ID 纪律"补一句：C/S/P/B 写定后不重排。
  - `episode-pass.md`：分批合并时保留 `id`，新写的集不写 id，合并后运行 `ids --write`。
  - `SKILL.md`：Step 5 合并后运行 `ids --write`；命令表；自测断言数；frontmatter `version: 3.0.0`。
  - `README.md` / `README.en.md`：命令表和断言数。
- **novel-art**：
  - `schema.md`：`usage.episodes` 是集 id 数组。
  - `SKILL.md`：`render --outline`、`migrate`，`version: 3.0.0`。
  - `README*.md`。
- **GOTCHA**: AGENTS.md 规定中文不用单字词（写「保留」不写「保」，「使用」不写「用」）。
- **VALIDATE**: `grep -n "episodeRef" skills/novel-outline/references/schema.md` 有结果；断言数与自测实际输出一致。

### Task 11: 提交
- 只暂存明确的路径，作者 `eternityspring <eternityspring@163.com>`（用 `-c` 指定，不改配置）。
- 分 3 个提交：
  - `feat(ids): 五个 skill 共用的稳定 id 模块与同步自测`
  - `feat(novel-outline)!: 集 id 与爽点归属（3.0.0）`
  - `feat(novel-art)!: 用量按集 id 记录（3.0.0）`
- 不推送。

---

## Testing Strategy

| Test | Input | Expected | Edge? |
|---|---|---|---|
| 副本一致 | 五份 ids.mjs | 逐字节相同 | |
| 种子可复现 | `seededRng('x')` 两次 | 同样的 id | |
| 撞号上限 | rng 恒 0、taken 已有 | MAX_TRIES 后抛错 | ✓ |
| ids 门：缺 / 格式 / 重复 / 悬空 / 不一致 / 缺 episodeRef | 改坏样例 | 各自点名 | ✓ |
| 插入一集 + renumber | index 2 插入 | 集号连续，爽点跟着原来那一集 | ✓ |
| beats 档 | 没有 episodes | 不受 ids 门影响 | ✓ |
| CLI ids 幂等 | 写回两次 | 第二次无变化 | ✓ |
| art seed 拒绝 2.x 大纲 | 没有集 id | 抛错并提示 | ✓ |
| art render 有 / 无大纲 | | 显示集号 / 显示「N 集」 | |
| art migrate 找不到集号 | 集号 99 | 抛错点名 | ✓ |

---

## Validation Commands

```bash
W=/Users/lance/Development/ai-video/shuohao-skills-stable-ids; cd $W
node scripts/ids-sync-selftest.mjs | tail -1
for f in skills/*/scripts/selftest.mjs; do printf "%s: " "$f"; node "$f" | tail -1 || exit 1; done
node scripts/report-selftest.mjs | tail -1
O=skills/novel-outline/scripts/novel-outline.mjs; A=skills/novel-art/scripts/novel-art.mjs
node $O validate skills/novel-outline/examples/渡口-outline.json && node $O checkup skills/novel-outline/examples/渡口-outline.json
node $A validate skills/novel-art/examples/渡口-art.json --cast skills/novel-art/references/test-fixtures/upstream/渡口-cast.json
node $A render skills/novel-art/examples/渡口-art.json --md --outline skills/novel-outline/examples/渡口-outline.json | grep -c "1、"
cmp skills/novel-outline/examples/渡口-outline.json skills/novel-art/references/test-fixtures/upstream/渡口-outline.json
```
EXPECT：全部通过；outline 15/15、art 10/10；`cmp` 无输出；script / staging / storyboard 的自测照旧通过（夹具没动）。

### Manual Validation
- [ ] `git diff` 里两份样例只多出 id、`episodeRef`、`usage.episodes` 的变化
- [ ] 渲染出的 outline 报告和改动前肉眼一致（集号照旧显示）

## Acceptance Criteria
- [ ] Task 1–11 完成
- [ ] 全部验证命令通过
- [ ] 新规则都有击穿用例
- [ ] 文档、断言数、版本号同步

## Completion Checklist
- [ ] 零依赖（只用 `node:crypto`）
- [ ] 新函数不改入参
- [ ] 中文消息、英文门标签同步更新
- [ ] AGENTS.md 规则遵守
- [ ] 主工作目录 `/Users/lance/Development/ai-video/shuohao-skills` 没被改动

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| outline 门的顺序变化影响按下标取门的旧断言 | M | L | 旧断言大多按 id 取门；跑一遍全部用例确认 |
| 其他 skill 的自测意外读了 outline 样例而不是自己的夹具 | L | M | 每个任务结束都跑全部七个自测 |
| `--seed` 被误用在真实项目 | L | M | USAGE 和 schema.md 写明"只用于样例与自测" |

## Notes
- 本计划 ①；② script + staging，③ storyboard + 收尾（CHANGELOG、根 README、AGENTS.md、夹具一致性检查）。
- 平台（ai-video-platform）的改键在 ③ 之后另起计划。

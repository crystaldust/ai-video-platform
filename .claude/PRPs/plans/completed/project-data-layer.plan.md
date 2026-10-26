# Plan: 项目数据层（Phase 1）

## Summary
为平台建立唯一的数据底座：每个项目一个 SQLite 文件，所有制作对象（集、场次、角色、场景、道具、爽点、视频段、分镜）都有稳定 ID；对象内容按"侧面"（facet，即由哪一阶段产出）只追加地保存版本，对象之间的引用钉在被引用方的具体版本上，因此"过期"可以现算、上游可以追溯。同时把现有 novel-* skill 的 6 种产物 JSON 投影进这套模型，并提供内容寻址的素材库，以及生成任务、候选、审阅、选用、剪辑的表结构（本阶段只建表，不做业务逻辑）。

## User Story
作为自部署 AI 短剧作者，我希望把 novel-* skill 的产物导入一个项目库，并能用 ID 查到任何一个分镜依赖的角色、场景、道具、剧本场次各是哪个版本，这样后续的局部返工、影响追踪和成本追溯都有可靠的数据基础，而不是靠文件名和人名去猜。

## Problem → Solution
各阶段产物是散落的 JSON 文件，之间靠 C01/S01 文本 ID 对账；改了上游不知道谁过期；素材靠文件名管理 → 一个项目库：稳定 ID + 只追加版本 + 钉版本的引用 + 现算的过期判断 + 按哈希存放的素材。

## Metadata
- **Complexity**: Large
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`
- **PRD Phase**: Phase 1 — 项目数据层
- **Estimated Files**: 约 36 个（src 约 20 个、test 约 16 个、fixture 6 个、配置 3 个）

---

## UX Design

### Before
N/A — 内部能力。现状：作者在若干目录里手工保存 `outline.json`、`script.json`……，靠肉眼对 ID。

### After
N/A — 内部能力。提供一个最小 CLI，用来手工验证：
```
$ node src/cli.ts init ./projects/duko --name 渡口
$ node src/cli.ts import ./projects/duko outline 渡口-outline.json
$ node src/cli.ts lineage ./projects/duko cut E01-01.c1
$ node src/cli.ts stale ./projects/duko
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 产物保存 | 散落 JSON 文件 | `import` 进项目库，原文完整保留为产物版本 | 相同内容重复导入不产生新版本 |
| 查依赖 | 人工翻 JSON | `lineage <kind> <key>` | 返回每个上游对象及其被引用时的版本 |
| 发现过期 | 无 | `stale` | 引用钉住的版本 ≠ 被引用方当前版本 → 过期 |
| 素材 | 按文件名 | `media add` 按 sha256 存放 | 同一文件只存一份 |

---

## Mandatory Reading

本仓库目前没有代码，下面要模仿的模式全部来自本机已有的 skill（与平台同一作者、同一代码风格）。

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `~/.claude/skills/novel-*/references/schema.md`（7 个） | all | 6 种产物的结构，投影规则以它们为准 |
| P0 | `~/.claude/skills/novel-script/scripts/novel-script.mjs` | 22-32, 248-252, 307-326, 1066-1091 | 命名、默认参数常量、problems 数组、seed 写法、CLI 错误处理 |
| P0 | `~/.claude/skills/character-refs/scripts/core.mjs` | 81, 362-394 | 哈希工具；"过期不存标记、每次现算"的版本模型——本阶段的引用钉版本就是把它推广到全项目 |
| P1 | `~/.claude/skills/novel-script/scripts/selftest.mjs` | 1-41 | 测试风格：每道门都要有击穿用例 |
| P1 | `~/.claude/skills/novel-storyboard/examples/渡口-storyboard.json` | segments/cuts | 段 id `E01-01`、分镜无 id、`sceneIndex` 指向剧本场次 |
| P2 | `docs/original_idea.md` | 第三、五节 | 三态与"082 第三版已生成但尚未选用"的语义 |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| `node:sqlite` | https://nodejs.org/api/sqlite.html | `DatabaseSync` 同步 API；`prepare().run/get/all`；本机 Node 25.8.2 已验证无需 flag、无实验警告 |
| Node 类型剥离 | https://nodejs.org/api/typescript.html | Node ≥ 23.6 默认可直接运行 `.ts`；只支持可擦除语法：**不能用 `enum`、`namespace`、参数属性**；相对导入必须写 `.ts` 后缀 |
| TypeScript 7 | npm `typescript@7.0.2` | 已在 scratchpad 验证下面的 tsconfig 能 `tsc -p .` 通过 |
| SQLite STRICT 表 | https://sqlite.org/stricttables.html | 列类型严格校验；`json_valid()` 做 JSON 列 CHECK |
| `node --test` 覆盖率 | https://nodejs.org/api/test.html | `--experimental-test-coverage --test-coverage-lines=80 --test-coverage-include=...` 能直接卡阈值 |

```
KEY_INSIGHT: node:sqlite 返回 null-prototype 对象，lastInsertRowid 可能是 number|bigint
APPLIES_TO: 所有 repo 函数
GOTCHA: 一律 Number(result.lastInsertRowid)；参数不接受 undefined 和 boolean——传 null 和 0/1；比较对象时先展开 {...row}

KEY_INSIGHT: PRAGMA foreign_keys 每个连接都要单独打开
APPLIES_TO: src/db/connection.ts
GOTCHA: 不开的话外键约束静默失效，测试也会"通过"

KEY_INSIGHT: 类型剥离 + verbatimModuleSyntax
APPLIES_TO: 全部源文件
GOTCHA: 纯类型导入必须写 `import type`，否则运行时报找不到导出
```

---

## Patterns to Mirror

### NAMING_CONVENTION
```js
// SOURCE: ~/.claude/skills/novel-script/scripts/novel-script.mjs:22-32
export const DEFAULT_PARAMS = {
  charsPerSecond: 4.5, // 中文口语偏快档
  actionSeconds: 2.5,  // 每个动作节拍的估时
  ...
};
export function paramsOf(doc) {
  return { ...DEFAULT_PARAMS, ...(doc?.params ?? {}) };
}
```
→ 常量 `UPPER_SNAKE`，函数 `camelCase` 动词开头，文件 `kebab-case`。注释用中文，解释"为什么"，不复述代码。

### ERROR_HANDLING（problems 数组 + 抛错）
```js
// SOURCE: novel-script.mjs:248-252
export function validateScript(doc, ctx = {}) {
  const problems = [];
  const p = (msg) => problems.push(msg);
  if (!doc || typeof doc !== 'object') return ['script.json 不是对象'];
```
```js
// SOURCE: novel-script.mjs:1009
if (!path) throw new Error('用法：seed <outline.json> [--eps 1-6]');
```
→ 投影函数返回 `problems: string[]`（中文、可操作、带定位，如 `第 1 集第 2 场引用了 S09，项目里没有这个场景`）。导入只要有 problem 就**整体不写库**，抛出 `ImportError`（携带 `problems`）。其余错误抛 `Error`，消息用中文。

### LOGGING_PATTERN
```js
// SOURCE: novel-script.mjs:1026, 1040-1042, 1085-1089
if (!ctx.outline) console.error('⚠️ 没给 --outline，跳过角色引用与爽点认领检查');
console.error(`✗ ${problems.length} 处违规：\n`);
for (const x of problems) console.error('  ' + x);
process.exit(1);
...
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
```
→ 库代码**不打日志**，只返回或抛出；只有 `src/cli.ts` 写 stderr 或 stdout。结果写 stdout，警告和错误写 stderr。

### VERSION_AND_STALENESS（REPOSITORY_PATTERN 的核心）
```js
// SOURCE: ~/.claude/skills/character-refs/scripts/core.mjs:362-394
/*
 * 过期不存标记，每次现算：看这张图记下的「文字指纹、画风指纹、参考图版本与文件指纹」
 * 和现在是否一致。…过期只标记，不删除；要不要重出由人决定。
 */
for (const r of cur.refs ?? []) {
  const now = current(outfit, r.view);
  if (!now) why.push({ code: 'ref-missing', view: r.view });
  else if (now.v !== r.v || now.sha256 !== r.sha256) why.push({ code: 'ref-changed', view: r.view, v: now.v });
}
```
→ `ref.to_version_id` 记下"被引用时的版本"；过期 = 被引用方当前版本 ≠ 钉住的版本。不存过期标记，查询时现算。

### SERVICE_PATTERN（确定性投影 = skill 的 seed）
```js
// SOURCE: novel-script.mjs:307-326
export function seedFromOutline(outline, epRange = null) {
  const perEp = (outline?.params?.minutesPerEpisode ?? 3) * 60;
  ...
  return { source: outline?.source ?? '', episodes };
}
```
→ 投影是纯函数：`(doc, ctx) → { entities, refs, problems }`，不碰数据库，便于用渡口样例做单元测试。写库集中在 `import-artifact.ts`。

### TEST_STRUCTURE
```js
// SOURCE: ~/.claude/skills/novel-script/scripts/selftest.mjs:1-41
// 原则：每道质量门都要有击穿用例——证明它真的会拦，不是一个永远为真的假测试。
const FIXTURE = JSON.parse(readFileSync(join(here, '../examples/渡口-script.json'), 'utf8'));
const clone = (x) => structuredClone(x);
eq(lineChars(null), 0, 'null 不崩');
```
→ 用 `node:test` + `node:assert/strict`，按 AAA 写，测试名用中文描述行为；固定使用渡口样例；每条拦截规则都配一个"故意弄坏样例"的反例（`structuredClone` 后改坏）。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `package.json` | CREATE | `type: module`、engines、scripts；devDeps 只有 `typescript@7.0.2`、`@types/node@25.9.9` |
| `tsconfig.json` | CREATE | 只做类型检查（noEmit），配置已验证 |
| `.gitignore` | CREATE | `node_modules/`、`coverage/`、`*.sqlite*`、`/projects/` |
| `src/domain/types.ts` | CREATE | 类型联合：EntityKind、Facet、Stage、行类型、Projection |
| `src/domain/keys.ts` | CREATE | 键的生成与校验：`E01`、`E01-SC01`、`E01-01`、`E01-01.c1` |
| `src/domain/hash.ts` | CREATE | 规范化 JSON + sha256 |
| `src/db/connection.ts` | CREATE | 打开连接（外键、WAL、busy_timeout）+ `withTransaction` |
| `src/db/migrations.ts` | CREATE | `MIGRATIONS` 数组 + 基于 `user_version` 的 `migrate()` |
| `src/db/schema-v1.ts` | CREATE | v1 的 SQL（下文给出完整内容） |
| `src/repo/artifacts.ts` | CREATE | 产物版本：只追加，按哈希幂等 |
| `src/repo/entities.ts` | CREATE | 对象、对象版本、引用的读写 |
| `src/repo/lineage.ts` | CREATE | 上游追溯（递归 CTE）+ 过期引用查询 |
| `src/repo/media.ts` | CREATE | 内容寻址素材入库与核验 |
| `src/import/projection.ts` | CREATE | 投影共用工具（`entity()`、`ref()`、`epKeyOf`） |
| `src/import/projections/outline.ts` | CREATE | outline → episode/character/location/prop/beat |
| `src/import/projections/cast.ts` | CREATE | cast → character（按名字和别名对上大纲人物） |
| `src/import/projections/art.ts` | CREATE | art → location/prop |
| `src/import/projections/script.ts` | CREATE | script → episode/script_scene |
| `src/import/projections/staging.ts` | CREATE | staging → location/script_scene |
| `src/import/projections/storyboard.ts` | CREATE | storyboard → segment/cut |
| `src/import/projections/index.ts` | CREATE | `PROJECTIONS: Record<Stage, ProjectFn>` |
| `src/import/import-artifact.ts` | CREATE | 在一个事务里：产物版本 → 对象版本 → 引用；带 `ImportError` |
| `src/project.ts` | CREATE | `createProject` / `openProject`（目录布局、project_meta） |
| `src/cli.ts` | CREATE | init / import / lineage / stale / media add / media verify |
| `test/fixtures/duko/渡口-{outline,cast,art,script,staging,storyboard}.json` | CREATE | 从各 skill 的 `examples/` 原样复制（6 份互相对得上） |
| `test/helpers.ts` | CREATE | `tempProject()`、`loadFixture()`、`importAll()` |
| `test/keys.test.ts` 等约 14 个测试文件 | CREATE | 见 Testing Strategy |

## NOT Building

- 节点执行器、skill 包注册、调用 LLM（Phase 2）
- 模型适配、预设、费用估算（Phase 3）
- 生成任务、审阅、选用、剪辑的**业务 API**——本阶段只建表，并用一条场景测试证明表结构能表达 082 案例（Phase 5–7）
- "需复核"的持久化标记或界面——过期只现算（Phase 4/6）
- 多项目的工作区索引（Phase 4）
- 项目导出与分享格式（PRD 待定问题）
- `character-refs` 的 `asset.json` 投影——它属于图片阶段，Phase 5 再接入素材版本
- 任何 Web 服务或 UI

---

## 数据模型（实现以此为准）

### 概念
- **对象（entity）**：`(kind, key)` 全局唯一，例如 `character/C01`、`segment/E01-02`。对象只是一个身份，本身没有内容。
- **侧面（facet）**：哪一阶段为这个对象写了内容。同一个 `location/S01` 有 `outline`（名称、是否主场景）、`art`（锚点、光照、提示词）、`staging`（认出的家具）三个侧面，各自独立地版本化。
- **对象版本（entity_version）**：某个侧面的一次内容快照，`v` 从 1 递增，只追加；内容哈希和上一版相同就不新建。
- **引用（ref）**：从某个对象版本指向另一个对象的某个侧面，并**钉住**当时的版本 `to_version_id`。
- **过期**：引用方是它那个侧面的当前版本，而被引用方的当前版本 ≠ 钉住的版本。
- **产物版本（artifact_version）**：skill 输出的整份 JSON 原文，按阶段只追加保存；对象版本记录自己来自哪个产物版本。

### Kind / Facet / Stage
```ts
export const ENTITY_KINDS = ['episode', 'character', 'location', 'prop', 'beat', 'script_scene', 'segment', 'cut'] as const;
export const STAGES = ['outline', 'cast', 'art', 'script', 'staging', 'storyboard'] as const;
// 第一版 facet 与 stage 一一对应；独立成类型，是为了以后非 skill 来源（人工编辑、图片阶段）也能写侧面
export const FACETS = STAGES;
```

### 键格式（`src/domain/keys.ts`）
| kind | key | 来源 |
|---|---|---|
| episode | `E01`（`ep` 补齐两位，≥100 时原样 `E100`） | outline/script 的 `ep` |
| character | `C01` | outline `characters[].id`；cast 按名字对上 |
| location | `S01` | outline/art `scenes[].id`、staging `locations[].sceneId` |
| prop | `P01` | outline/art `props[].id` |
| beat | `B01` | outline `beats[].id` |
| script_scene | `E01-SC01`（集 + 第几场，1 起，两位） | script `episodes[].scenes[]` 的顺序；staging `(ep, scene)`；storyboard `sceneIndex` |
| segment | `E01-01` | storyboard `segments[].id`，原样 |
| cut | `E01-01.c1`（段号 + `.c` + 段内序号，1 起） | storyboard `cuts[]` 的顺序，与素材文件 `f<切序>.png` 的序号一致 |

校验正则：`/^E\d{2,}$/`、`/^C\d{2,}$/`、`/^S\d{2,}$/`、`/^P\d{2,}$/`、`/^B\d{2,}$/`、`/^E\d{2,}-SC\d{2,}$/`、`/^E\d{2,}-\d{2,}$/`、`/^E\d{2,}-\d{2,}\.c\d+$/`。

### 投影规则（6 个 projection 都按这张表实现）
每条引用写作 `role → kind[facet 优先级]`：按顺序取第一个已存在的侧面；`optional` 的引用在目标不存在时直接跳过，非 optional 的则记一条 problem。

| Stage | 产出（kind/facet，payload） | 引用 |
|---|---|---|
| outline | episode/outline：`episodes[i]` 原样；title `第N集` | `cast → character[outline]`（characterIds）、`location → location[outline]`（sceneIds）、`prop → prop[outline]`（propIds） |
| | character/outline：`characters[i]`；title `name` | — |
| | location/outline：`scenes[i]`；title `name` | — |
| | prop/outline：`props[i]`（可选数组）；title `name` | — |
| | beat/outline：`beats[i]`；title `type` | `episode → episode[outline]` |
| cast | character/cast：`characters[i]` 原样；key 按 `name` 或 `aliases` 匹配大纲人物的 **title** | —（`relationships` 用人名，留在 payload 里） |
| art | location/art：`scenes[i]`；title `name` | `variant-of → location[art]`（variantOf，可选字段） |
| | prop/art：`props[i]` | `location → location[art, outline]`（relatedScenes） |
| script | episode/script：`episodes[i]` 去掉 `scenes`，加 `sceneKeys: string[]` | — |
| | script_scene/script：`scenes[j]` 原样 + `ep`、`index` | `episode → episode[script]`、`location → location[art, outline]`、`cast → character[outline]`、`prop → prop[art, outline]` |
| staging | location/staging：`locations[i]` | `read-from → location[art]`（optional） |
| | script_scene/staging：`scenes[i]` | `staged → script_scene[script]`、`location → location[staging]` |
| storyboard | segment/storyboard：`segments[i]` 去掉 `cuts`，加 `ep`、`cutKeys` | `scene → script_scene[script]`、`staging → script_scene[staging]`（optional） |
| | cut/storyboard：`cuts[k]` 原样 + `index` | `segment → segment[storyboard]`、`cast → character[cast, outline]`、`prop → prop[art, outline]` |

投影自身要查的问题（返回 problem，不抛错）：
- 文档不是对象，或缺少数组字段（`characters`/`scenes`/`episodes`/`segments`）
- 键格式不合法；同一份文档里 `(kind,key)` 重复
- cast：卡片名字和别名都对不上任何大纲人物 → `cast 里的「X」在大纲人物表里找不到（先导入 outline，或检查名字）`
- storyboard：`sceneIndex` 不是正整数

导入时要查的问题（需要数据库）：非 optional 的引用目标不存在，或任何候选侧面都还没有版本 → `第 1 集第 2 场（E01-SC02）引用了 location/S09，项目里没有它的 art/outline 版本`。

### Schema v1（`src/db/schema-v1.ts` 导出这一整段 SQL 字符串）
```sql
CREATE TABLE project_meta (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- skill 产物原文：按阶段只追加
CREATE TABLE artifact_version (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('outline','cast','art','script','staging','storyboard')),
  v INTEGER NOT NULL CHECK (v >= 1),
  doc TEXT NOT NULL CHECK (json_valid(doc)),
  content_hash TEXT NOT NULL,
  skill TEXT,              -- 例如 novel-script@1.2.0；未知为 NULL
  source_path TEXT,        -- 导入时的源文件路径，只作记录
  created_at TEXT NOT NULL,
  UNIQUE (stage, v)
) STRICT;

CREATE TABLE entity (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('episode','character','location','prop','beat','script_scene','segment','cut')),
  key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (kind, key)
) STRICT;

CREATE TABLE entity_version (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entity(id),
  facet TEXT NOT NULL CHECK (facet IN ('outline','cast','art','script','staging','storyboard')),
  v INTEGER NOT NULL CHECK (v >= 1),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  content_hash TEXT NOT NULL,
  artifact_version_id INTEGER REFERENCES artifact_version(id),
  created_at TEXT NOT NULL,
  UNIQUE (entity_id, facet, v)
) STRICT;

-- 引用钉在被引用方的具体版本上；过期现算，不存标记
CREATE TABLE ref (
  id INTEGER PRIMARY KEY,
  from_version_id INTEGER NOT NULL REFERENCES entity_version(id),
  role TEXT NOT NULL,
  to_version_id INTEGER NOT NULL REFERENCES entity_version(id),
  UNIQUE (from_version_id, role, to_version_id)
) STRICT;
CREATE INDEX ref_to ON ref(to_version_id);

CREATE VIEW current_version AS
  SELECT ev.* FROM entity_version ev
  WHERE ev.v = (SELECT MAX(v) FROM entity_version x WHERE x.entity_id = ev.entity_id AND x.facet = ev.facet);

-- 素材：内容寻址，rel_path 相对项目目录
CREATE TABLE media_file (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  rel_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  created_at TEXT NOT NULL
) STRICT;

-- 以下为 Phase 5–7 预留的结构：本阶段只建表，并用场景测试验证它能表达 082 案例
CREATE TABLE generation_task (
  id INTEGER PRIMARY KEY,
  target_version_id INTEGER NOT NULL REFERENCES entity_version(id), -- 按哪个设计版本生成
  capability TEXT NOT NULL CHECK (capability IN ('text','image','video','audio')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','submitted','running','succeeded','failed','rejected')),
  provider_task_id TEXT,
  planned_input TEXT NOT NULL CHECK (json_valid(planned_input)),
  actual_input TEXT CHECK (actual_input IS NULL OR json_valid(actual_input)),
  cost_estimate REAL,
  cost_actual REAL,
  currency TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
-- 同一供应商任务 ID 只能落库一次：防止断线恢复时重复付费
CREATE UNIQUE INDEX task_provider_id ON generation_task(provider, provider_task_id) WHERE provider_task_id IS NOT NULL;

CREATE TABLE task_event (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES generation_task(id),
  status TEXT NOT NULL,
  detail TEXT CHECK (detail IS NULL OR json_valid(detail)),
  at TEXT NOT NULL
) STRICT;

-- 候选素材：任务执行成功的产出，"合格"和"选用"分别记录
CREATE TABLE candidate (
  id INTEGER PRIMARY KEY,
  target_entity_id INTEGER NOT NULL REFERENCES entity(id),
  task_id INTEGER REFERENCES generation_task(id),   -- 人工上传的为 NULL
  media_file_id INTEGER NOT NULL REFERENCES media_file(id),
  label TEXT NOT NULL,                               -- 例如 v3
  created_at TEXT NOT NULL,
  UNIQUE (target_entity_id, label)
) STRICT;

CREATE TABLE review (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidate(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail','note')),
  at_seconds REAL CHECK (at_seconds IS NULL OR at_seconds >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;

-- 选用记录只追加，最新一条生效；candidate_id 为 NULL 表示撤销选用
CREATE TABLE selection (
  id INTEGER PRIMARY KEY,
  target_entity_id INTEGER NOT NULL REFERENCES entity(id),
  candidate_id INTEGER REFERENCES candidate(id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE edit_version (
  id INTEGER PRIMARY KEY,
  episode_entity_id INTEGER NOT NULL REFERENCES entity(id),
  v INTEGER NOT NULL CHECK (v >= 1),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (episode_entity_id, v)
) STRICT;

-- 剪辑片段钉在具体候选上：换选不会悄悄改动旧剪辑
CREATE TABLE edit_clip (
  id INTEGER PRIMARY KEY,
  edit_version_id INTEGER NOT NULL REFERENCES edit_version(id),
  position INTEGER NOT NULL CHECK (position >= 1),
  candidate_id INTEGER NOT NULL REFERENCES candidate(id),
  in_s REAL NOT NULL CHECK (in_s >= 0),
  out_s REAL NOT NULL,
  CHECK (out_s > in_s),
  UNIQUE (edit_version_id, position)
) STRICT;

-- 三态：执行（任务状态）/ 合格（最近一条非 note 审阅）/ 选用（该对象最近一条 selection）
CREATE VIEW candidate_state AS
SELECT c.id AS candidate_id, c.target_entity_id, c.label,
  COALESCE(t.status, 'manual') AS exec_status,
  COALESCE((SELECT r.verdict FROM review r WHERE r.candidate_id = c.id AND r.verdict <> 'note'
            ORDER BY r.id DESC LIMIT 1), 'unreviewed') AS qc_status,
  (SELECT s.candidate_id FROM selection s WHERE s.target_entity_id = c.target_entity_id
     ORDER BY s.id DESC LIMIT 1) IS c.id AS selected
FROM candidate c LEFT JOIN generation_task t ON t.id = c.task_id;
```

### 项目目录布局
```
<projectDir>/
  project.sqlite
  media/<sha256 前 2 位>/<sha256>.<ext>
```

---

## Step-by-Step Tasks

### Task 1: 工程脚手架
- **ACTION**: 创建 `package.json`、`tsconfig.json`、`.gitignore`，执行 `pnpm install`。
- **IMPLEMENT**:
  ```json
  {
    "name": "ai-video-platform", "version": "0.1.0", "private": true, "type": "module",
    "license": "Apache-2.0",
    "engines": { "node": ">=24" },
    "scripts": {
      "typecheck": "tsc -p .",
      "test": "node --test \"test/**/*.test.ts\"",
      "coverage": "node --test --experimental-test-coverage --test-coverage-include=\"src/**/*.ts\" --test-coverage-exclude=\"src/cli.ts\" --test-coverage-lines=80 --test-coverage-branches=70 --test-coverage-functions=80 \"test/**/*.test.ts\"",
      "cli": "node src/cli.ts"
    },
    "devDependencies": { "typescript": "7.0.2", "@types/node": "25.9.9" }
  }
  ```
  `tsconfig.json`（已在 scratchpad 验证）：
  ```json
  { "compilerOptions": { "target": "esnext", "module": "nodenext", "moduleResolution": "nodenext",
    "strict": true, "noEmit": true, "allowImportingTsExtensions": true, "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "types": ["node"] }, "include": ["src", "test"] }
  ```
- **MIRROR**: skill 的"零依赖"原则——运行时**零依赖**，devDeps 只有类型检查用的两个包。
- **GOTCHA**: 不要加 ts-node/tsx/vitest；直接运行 `.ts` 靠 Node 内置的类型剥离。
- **VALIDATE**: `pnpm typecheck` 在只有一个空 `src/domain/types.ts` 时就能通过。

### Task 2: 复制渡口样例 + 测试工具
- **ACTION**: 把 6 份样例 JSON 复制到 `test/fixtures/duko/`；写 `test/helpers.ts`。
- **IMPLEMENT**: `cp ~/.claude/skills/novel-{outline,characters,art,script,staging,storyboard}/examples/渡口-*.json test/fixtures/duko/`（novel-characters 的文件叫 `渡口-cast.json`）。helpers：
  - `loadFixture(stage: Stage): unknown`——用 `readFileSync` 读样例，每次返回新对象
  - `tempProject(): { dir, project, cleanup }`——在 `mkdtempSync(join(tmpdir(), 'avp-'))` 下 `createProject`
  - `importAll(project, stages = STAGES)`——按 outline → cast → art → script → staging → storyboard 顺序导入
- **MIRROR**: TEST_STRUCTURE（固定样例，`structuredClone` 后改坏做反例）。
- **GOTCHA**: 样例的文件名含中文，路径用 `join` 拼，不要手写分隔符。测试之间不能共享同一个项目目录。
- **VALIDATE**: 6 份样例在 Node 里都能 `JSON.parse` 成功。

### Task 3: 领域类型、键、哈希
- **ACTION**: 写 `src/domain/types.ts`、`keys.ts`、`hash.ts`，以及 `test/keys.test.ts`、`test/hash.test.ts`。
- **IMPLEMENT**:
  - `types.ts`：上文的 `ENTITY_KINDS`/`STAGES`/`FACETS` 加派生类型（`type EntityKind = typeof ENTITY_KINDS[number]`），以及：
    ```ts
    export interface EntityDraft { readonly kind: EntityKind; readonly key: string; readonly title: string; readonly facet: Facet; readonly payload: unknown; }
    export interface RefDraft { readonly from: { kind: EntityKind; key: string; facet: Facet }; readonly role: string;
      readonly to: { kind: EntityKind; key: string }; readonly toFacets: readonly Facet[]; readonly optional: boolean; readonly where: string; }
    export interface Projection { readonly entities: readonly EntityDraft[]; readonly refs: readonly RefDraft[]; readonly problems: readonly string[]; }
    export interface ProjectionContext { readonly characterKeyByName: ReadonlyMap<string, string>; }
    ```
    `where` 是给人看的定位文字（如 `第 1 集第 2 场`），用来拼 problem。
  - `keys.ts`：`episodeKey(ep)`、`scriptSceneKey(ep, index)`、`cutKey(segmentId, index)`、`KEY_PATTERNS: Record<EntityKind, RegExp>`、`isValidKey(kind, key)`；`ep`/`index` 不是正整数时抛 `Error('集号必须是正整数：…')`。
  - `hash.ts`：`canonicalJson(x)`——对象键递归排序，数组保持顺序，`undefined` 字段丢弃；`contentHash(x) = sha256(canonicalJson(x))`，返回完整的十六进制串。
- **MIRROR**: `core.mjs:81` 的 `sha256` 写法（`createHash('sha256').update(x).digest('hex')`）。
- **IMPORTS**: `import { createHash } from 'node:crypto'`
- **GOTCHA**: 键序不同但内容相同的 JSON 必须得到同一个哈希，否则重复导入会凭空产生新版本。
- **VALIDATE**: 单测（见 Testing Strategy）。

### Task 4: 连接与迁移
- **ACTION**: 写 `src/db/connection.ts`、`schema-v1.ts`、`migrations.ts`，以及 `test/migrations.test.ts`。
- **IMPLEMENT**:
  - `openDb(path: string): DatabaseSync`——`new DatabaseSync(path)` 后执行 `PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`，再调 `migrate(db)`。
  - `withTransaction<T>(db, fn: () => T): T`——`BEGIN IMMEDIATE` → fn → `COMMIT`；抛错时 `ROLLBACK` 再原样抛出。
  - `MIGRATIONS: readonly string[] = [SCHEMA_V1]`；`migrate(db)` 读 `PRAGMA user_version`，在一个事务里依次执行未跑过的迁移并设置 `user_version`；如果库的版本比代码新，抛 `Error('项目库版本 N 比程序支持的 M 新，请升级平台')`。
  - 常量 `BUSY_TIMEOUT_MS = 5000`。
- **GOTCHA**: `PRAGMA journal_mode` 对 `:memory:` 返回 `memory`，属正常，不要当成失败；`user_version` 不能参数化，用模板拼接的整数，并先校验 `Number.isInteger`。
- **VALIDATE**: 新库 `user_version = 1`；迁移跑两次不报错；外键生效（插入一个指向不存在 entity 的 `entity_version` 会抛错）；手动把 `user_version` 设为 99 后打开会抛"版本比程序新"。

### Task 5: 项目创建与打开
- **ACTION**: 写 `src/project.ts` 和 `test/project.test.ts`。
- **IMPLEMENT**:
  ```ts
  export interface Project { readonly dir: string; readonly db: DatabaseSync; readonly meta: ProjectMeta; close(): void; }
  export function createProject(dir: string, name: string): Project   // 目录不存在就创建；已有 project.sqlite 则抛错
  export function openProject(dir: string): Project                    // 没有 project.sqlite 则抛 '不是项目目录：…'
  export const DB_FILE = 'project.sqlite'; export const MEDIA_DIR = 'media';
  ```
  `meta.id` 用 `randomUUID()`。`name` 去掉首尾空白后为空则抛错。
- **VALIDATE**: 创建后能重新打开并读到同样的 meta；重复创建抛错；打开空目录抛错。

### Task 6: 产物与对象仓储
- **ACTION**: 写 `src/repo/artifacts.ts`、`src/repo/entities.ts`，以及 `test/entities.test.ts`。
- **IMPLEMENT**（全部接收 `db: DatabaseSync`，返回普通对象，不返回 SQLite 行对象）：
  - `appendArtifactVersion(db, { stage, doc, skill, sourcePath }) → { id, v, unchanged }`：哈希和该阶段最新一版相同 → 返回旧版本并标 `unchanged: true`。
  - `ensureEntity(db, kind, key, title) → id`：不存在就插入；已存在且 title 不同则更新 title（title 只用于显示，不参与版本）。
  - `appendEntityVersion(db, { entityId, facet, payload, artifactVersionId }) → { id, v, created }`：哈希和当前版本相同 → `created: false`。
  - `currentVersion(db, kind, key, facet) → VersionRow | null`；`listVersions(db, kind, key, facet?)`。
  - `insertRef(db, fromVersionId, role, toVersionId)`：用 `INSERT OR IGNORE`。
  - `characterKeyIndex(db) → Map<string, string>`：取所有 character 的 outline 当前版本，把 `name` 映射到 key，供 cast 投影使用。
  - 类型 `VersionRow { id, entityId, kind, key, facet, v, payload: unknown, contentHash, createdAt }`，payload 用 `JSON.parse` 还原。
- **MIRROR**: VERSION_AND_STALENESS——只追加，从不 UPDATE 版本行。
- **GOTCHA**: `Number(run().lastInsertRowid)`；时间统一用 `new Date().toISOString()`。
- **VALIDATE**: 同样内容追加两次只有 v1；改一个字段后出现 v2，v1 仍可读；不同 facet 的版本号各自独立。

### Task 7: 投影（6 个纯函数）
- **ACTION**: 写 `src/import/projection.ts` 和 `src/import/projections/*.ts`，以及 `test/projections.test.ts`。
- **IMPLEMENT**: 签名统一为 `export function projectOutline(doc: unknown, ctx: ProjectionContext): Projection`（其余同理）。严格按上文的投影规则表实现。共用工具：
  - `entity(kind, key, title, facet, payload): EntityDraft`
  - `ref(from, role, to, toFacets, where, optional = false): RefDraft`
  - `isRecord(x)`、`arrayField(doc, name, problems, label)`——缺字段时记 problem 并返回 `[]`
  - 每个投影最后做一次 `(kind,key)` 去重检查
  - `index.ts`：`export const PROJECTIONS: Readonly<Record<Stage, ProjectFn>>`
- **MIRROR**: SERVICE_PATTERN（seed 式的确定性搬运）+ ERROR_HANDLING（problems 数组）。
- **GOTCHA**:
  - payload 一律用解构加展开**构造新对象**（如 `const { scenes, ...rest } = ep; payload = { ...rest, sceneKeys }`），不要改动入参 doc（遵守"不可变"规则）。
  - cast 卡片没有 `id`，只能靠 `ctx.characterKeyByName` 匹配；渡口的 cast 只有 4 张卡（没有 C05 更夫），这是合法的。
  - storyboard 段内的 `characters` 不在 segment 上，在每个 cut 上。
  - art 的 S03 有 `variantOf: 'S02'`，目标在同一份文档里。
- **VALIDATE**: 渡口样例的每个投影 `problems` 都为空，实体数量符合预期（见测试表）；反例都能拦下。

### Task 8: 事务化导入
- **ACTION**: 写 `src/import/import-artifact.ts`，以及 `test/import.test.ts`、`test/import-all.test.ts`。
- **IMPLEMENT**:
  ```ts
  export class ImportError extends Error { readonly problems: readonly string[]; constructor(problems: readonly string[]) {...} }
  export interface ImportResult { readonly stage: Stage; readonly artifactV: number; readonly unchanged: boolean;
    readonly created: number; readonly reused: number; readonly refs: number; }
  export function importArtifact(project: Project, stage: Stage, doc: unknown, opts?: { skill?: string; sourcePath?: string }): ImportResult
  ```
  流程（整个过程包在一次 `withTransaction` 里）：
  1. `ctx = { characterKeyByName: characterKeyIndex(db) }`；`projection = PROJECTIONS[stage](doc, ctx)`；有 problems 就抛 `ImportError`（此时还没写任何东西）。
  2. `appendArtifactVersion`；如果 `unchanged`，直接返回（created = 0）。
  3. 对每个 EntityDraft 执行 `ensureEntity` + `appendEntityVersion`，记下 `(kind,key,facet) → {versionId, created}`。
  4. 对每个 RefDraft：只有 from 的版本是**本次新建**的才写引用（复用的旧版本已经有引用了）；目标按 `toFacets` 顺序取第一个存在的 `currentVersion`（第 3 步之后取，所以同一份文档内的引用指向新版本）；找不到时，optional 的跳过，否则把问题收集起来。
  5. 收集到的问题不为空 → 抛 `ImportError` → 事务回滚，库里什么都不留。
- **GOTCHA**: `ImportError` 是普通 class，不能用参数属性（`erasableSyntaxOnly`），在构造函数里显式赋值 `this.problems = problems`，并设置 `this.name = 'ImportError'`。
- **VALIDATE**: 见测试表——全量导入、重复导入幂等、修改后出现新版本、引用缺失时回滚、跳过 cast 时 cut 的人物引用回退到 outline 侧面。

### Task 9: 追溯与过期
- **ACTION**: 写 `src/repo/lineage.ts` 和 `test/lineage.test.ts`。
- **IMPLEMENT**:
  - `getLineage(db, kind, key, opts?: { facet?: Facet; maxDepth?: number }) → LineageNode[]`：从该对象（指定侧面或全部侧面）的当前版本出发，沿 `ref.to_version_id` 递归（`WITH RECURSIVE`，用 `UNION` 去重，`depth < maxDepth`，默认 `MAX_LINEAGE_DEPTH = 20`）。节点为 `{ kind, key, title, facet, v, versionId, role, depth, isCurrent }`，同一个 versionId 只保留深度最小的那个。按 depth、kind、key 排序。
  - `findStaleRefs(db) → StaleRef[]`：只看 from 是当前版本的引用；如果 to 所在的 `(entity, facet)` 当前版本 id ≠ `to_version_id`，就算过期。返回 `{ from: {kind,key,facet,v}, role, to: {kind,key,facet}, pinnedV, currentV }`。
- **MIRROR**: VERSION_AND_STALENESS（现算，不存标记）。
- **GOTCHA**: `isCurrent=false` 的节点正是"这个分镜是按旧版角色做的"的证据，不能被过滤掉。
- **VALIDATE**: 全量导入后，`cut/E01-01.c1` 的追溯包含 `segment/E01-01`、`script_scene/E01-SC01`（script）、`episode/E01`（script）、`location/S02`（art）、`character/C01`（cast）、`prop/P01`（art）；全量导入后 `findStaleRefs` 为空；把 art 里 S02 的一个锚点改掉再导入，出现的过期引用全部指向 `location/S02`（art），来源恰好是这 4 个：`script_scene/E01-SC01` 和 `E06-SC02`（script）、`location/S02`（staging 的 read-from）、`location/S03`（art 的 variant-of）。

### Task 10: 素材库
- **ACTION**: 写 `src/repo/media.ts` 和 `test/media.test.ts`。
- **IMPLEMENT**:
  - `MIME_BY_EXT`：png/jpg/jpeg/webp/mp4/mov/webm/wav/mp3/m4a/json/srt，未知的用 `application/octet-stream`。
  - `addMediaFile(project, srcPath) → MediaRow`：流式算 sha256（`createReadStream` 通过管道送进 hash，函数为 `async`）；目标路径 `media/<sha前2位>/<sha>.<ext小写>`；已存在同哈希的行就直接返回；否则 `mkdirSync(recursive)` + `copyFileSync(src, dst, constants.COPYFILE_EXCL)`（目标已存在时忽略 `EEXIST`）再插入行。源文件不存在时抛 `Error('素材文件不存在：…')`。
  - `verifyMedia(project) → { ok: number; missing: string[]; mismatched: string[] }`：重新计算每个文件的哈希。
- **GOTCHA**: 先拷贝、再插库：拷贝失败时库里不会留下孤立的行；插库失败只会留下一个可以重新利用的文件，无害。
- **VALIDATE**: 同一文件加两次只有一行、一个文件；内容不同就是两行；手动篡改文件后 `verifyMedia` 报告 mismatched；删除文件后报告 missing。

### Task 11: 082 场景测试（验证预留表结构）
- **ACTION**: 写 `test/scenario-082.test.ts`，只用 SQL 和 Task 6/10 的函数，不新增业务 API。
- **IMPLEMENT**: 全量导入渡口 → 取 `segment/E01-01` 和 `E01-02` 的当前版本 → 加 3 个小的假 mp4（写入临时文件后 `addMediaFile`）→ 插入 3 条 `generation_task`（081 v1 succeeded；082 v1 succeeded；082 v2 用同样的 provider+provider_task_id 再插一次 → 期望唯一索引报错；改用新的 id → succeeded）→ 插入 candidate → 对 082 v1 写 review fail（`at_seconds = 2.4`，note "多了一个贝内特"）→ selection：081→v1、082→v1，然后 082→v2 → edit_version v1（081 v1 + 082 v1）、v2（081 v1 + 082 v2）。
- **VALIDATE**（断言）：
  - `candidate_state`：082 v1 = `succeeded / fail / 0`，082 v2 = `succeeded / unreviewed / 1`，081 v1 = `succeeded / unreviewed / 1`
  - edit v1 的 clip 仍然指向 082 v1（旧剪辑没有被悄悄改掉）；edit v2 第 1 个 clip 的 candidate 和 v1 相同（081 没有重做）
  - 提交重复的 provider_task_id 时抛错
  - `out_s <= in_s` 的 clip 插入抛错

### Task 12: CLI
- **ACTION**: 写 `src/cli.ts` 和 `test/cli.test.ts`（通过 `spawnSync(process.execPath, ['src/cli.ts', ...])` 做冒烟测试）。
- **IMPLEMENT**: 命令：
  ```
  init <dir> --name <名称>
  import <dir> <stage> <file.json> [--skill <name@ver>]
  lineage <dir> <kind> <key> [--facet <facet>]
  stale <dir>
  media add <dir> <file>
  media verify <dir>
  ```
  结果以 JSON 输出到 stdout（`JSON.stringify(x, null, 2)`）。遇到 `ImportError` 时，stderr 输出 `✗ N 处问题：` 加逐条列表，exit 1；其它错误输出 message，exit 1；不认识的命令输出 USAGE，exit 1；不带参数时输出 USAGE，exit 0。保留 skill 的 `isMainModule` 和 EPIPE 处理。
- **MIRROR**: LOGGING_PATTERN（novel-script.mjs:999-1091）。
- **GOTCHA**: `stage`/`kind`/`facet` 参数要用 `STAGES`/`ENTITY_KINDS` 校验，不合法时报中文错误并列出可选值。
- **VALIDATE**: 冒烟测试：init → 依次 import 6 份 → lineage 输出包含 `"key": "C01"` → 导入一个坏掉的 script 时 exit 1，且 stderr 包含 `处问题`。

---

## Testing Strategy

### Unit / Integration Tests

| Test file | Test | Input | Expected | Edge? |
|---|---|---|---|---|
| keys | 集号补两位 | `episodeKey(1)` / `(123)` | `E01` / `E123` | ✓ |
| keys | 非正整数拦截 | `episodeKey(0)`、`scriptSceneKey(1, 1.5)` | 抛错 | ✓ |
| keys | 正则覆盖每个 kind | 合法与非法键各一个 | true / false | |
| hash | 键序无关 | `{a:1,b:[1,2]}` 与 `{b:[1,2],a:1}` | 哈希相同 | ✓ |
| hash | 数组顺序有关 | `[1,2]` 与 `[2,1]` | 哈希不同 | |
| hash | 丢弃 undefined | `{a:1,b:undefined}` 与 `{a:1}` | 相同 | ✓ |
| migrations | 新库版本为 1，重复迁移幂等 | `:memory:` | `user_version=1` | |
| migrations | 外键生效 | 插入 entity_id=999 的版本 | 抛错 | ✓ |
| migrations | 拒绝更新的库 | `user_version=99` | 抛"比程序支持的新" | ✓ |
| project | 创建→打开→meta 一致；重复创建、打开空目录、空名称都抛错 | 临时目录 | — | ✓ |
| entities | 同内容只有 v1；改内容出现 v2；facet 之间互不影响 | — | — | |
| projections | outline 渡口 | 样例 | 6 episode + 5 character + 3 location + 2 prop + 4 beat，problems 为空 | |
| projections | cast 渡口 | 样例 + 大纲人名索引 | 4 个 character/cast，分别对应 C01–C04 | |
| projections | cast 名字对不上 | 改 name 为「张三」 | 1 条 problem，提到「张三」 | ✓ |
| projections | art 渡口 | 样例 | 3 location + 2 prop，S03 有 variant-of → S02 | |
| projections | script 渡口 | 样例 | 6 episode/script + 9 script_scene（1:2,2:1,3:1,4:1,5:2,6:2） | |
| projections | staging 渡口 | 样例 | 3 location/staging + 9 script_scene/staging | |
| projections | storyboard 渡口 | 样例 | 10 segment + 34 cut，键 `E01-01.c1`… | |
| projections | 缺数组字段 | 删掉 `episodes` | problem，不抛错 | ✓ |
| projections | 文档内键重复 | 两个 C01 | problem | ✓ |
| projections | 非对象输入 | `null`、`[]`、`"x"` | problem，不抛错 | ✓ |
| projections | 不改动入参 | 投影前后 `deepEqual(原样例)` | 相等 | ✓ |
| import | 全量 6 阶段 | 渡口 | 无异常；每阶段 artifactV=1 | |
| import | 重复导入幂等 | 同一份 script 再导入一次 | `unchanged:true`，版本数不变 | ✓ |
| import | 修改产生新版本 | script 第 1 集第 1 场改一句台词 | 只有 `E01-SC01/script` 变成 v2，其余场次仍为 v1 | |
| import | 引用缺失时回滚 | script 某场 sceneId 改为 S09 | `ImportError`，提到 S09；库里 script 产物数为 0 | ✓ |
| import | 跳过 cast | 不导入 cast 直接导入 storyboard | cut 的 cast 引用指向 character/outline | ✓ |
| import | 先导入 cast（没有大纲） | 空项目只导入 cast | `ImportError`（人名找不到） | ✓ |
| lineage | 追溯 cut `E01-01.c1` | 全量导入 | 包含 6 个上游对象（Task 9），深度 ≥ 2 | |
| lineage | 旧版本仍可见 | 修改 C01 的 cast 后重新导入 | 追溯里 C01/cast 的 `isCurrent=false` | ✓ |
| lineage | 过期引用 | 修改 art 的 S02 后重新导入 | `findStaleRefs` 非空，且全部指向 location/S02 | |
| lineage | 不存在的对象 | `cut/E99-01.c1` | 返回 `[]` | ✓ |
| media | 去重、篡改、丢失、源文件不存在 | 临时文件 | 见 Task 10 | ✓ |
| scenario-082 | 三态与剪辑版本 | 见 Task 11 | 见 Task 11 | |
| cli | 冒烟测试 | 见 Task 12 | 见 Task 12 | ✓ |

> 测试里的实体数量已在规划时用样例核对过：outline 有 5 个人物、3 个场景、2 件道具、4 个爽点、6 集；script 9 场；staging 9 场、3 个地点；storyboard 只有第 1 集，10 段，各段分镜数为 4+4+4+3+3+4+3+4+3+2 = 34。

### Edge Cases Checklist
- [x] 空输入或非对象输入（投影不抛错，返回 problem）
- [ ] 最大规模：60 集大纲的导入耗时——本阶段不设门槛，记录在 Notes 里
- [x] 类型不对（键格式、sceneIndex 不是整数）
- [x] 并发：每个项目只有一个连接，`busy_timeout` 兜底；本阶段不测多进程
- [ ] 网络失败——本阶段不涉及
- [x] 权限或文件问题：素材源文件不存在、项目目录不存在或已存在

---

## Validation Commands

### Static Analysis
```bash
pnpm typecheck
```
EXPECT: 零类型错误

### Unit Tests
```bash
pnpm test
```
EXPECT: 全部通过

### Coverage
```bash
pnpm coverage
```
EXPECT: lines ≥ 80%、functions ≥ 80%、branches ≥ 70%（不达标时命令退出码非 0）

### Database Validation
```bash
node src/cli.ts init /tmp/avp-duko --name 渡口 && \
for s in outline cast art script staging storyboard; do \
  f=test/fixtures/duko/渡口-$s.json; node src/cli.ts import /tmp/avp-duko $s "$f" || exit 1; done && \
sqlite3 /tmp/avp-duko/project.sqlite "PRAGMA user_version; PRAGMA foreign_key_check; SELECT kind, COUNT(*) FROM entity GROUP BY kind;"
```
EXPECT: `user_version = 1`；`foreign_key_check` 无输出；各 kind 的数量与测试表一致

### Browser Validation
N/A —— 本阶段没有 UI

### Manual Validation
- [ ] `node src/cli.ts lineage /tmp/avp-duko cut E01-02.c1` 的输出能让人读懂：这一格依赖哪个角色、场景、道具的第几版
- [ ] 手工改 `渡口-art.json` 里 S02 的一个锚点后重新 import，`stale` 列出受影响的场次
- [ ] 删掉 `/tmp/avp-duko`

---

## Acceptance Criteria
- [ ] 全部 12 个任务完成
- [ ] 全部验证命令通过
- [ ] 测试已写好并全部通过，覆盖率达标
- [ ] 没有类型错误
- [ ] PRD 的 Phase 1 成功标准：能完整导入一套 novel-* 产物，并通过 ID 查询任意镜头的上游角色、场景和资产版本

## Completion Checklist
- [ ] 代码风格与 skill 一致（中文 problem 消息、库代码不打日志、CLI 统一处理错误）
- [ ] 不可变：投影不修改入参；版本和引用行只插入，不更新（只有 `entity.title` 允许更新）
- [ ] 没有魔法数字（`BUSY_TIMEOUT_MS`、`MAX_LINEAGE_DEPTH`、`DB_FILE`、`MEDIA_DIR` 都是具名常量）
- [ ] 每个函数少于 50 行，每个文件少于 400 行（投影按 stage 拆成多个文件就是为了这一点）
- [ ] 运行时零依赖
- [ ] 没有超出范围的新增内容（没有任务、审阅、剪辑的业务 API）

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| "按侧面版本化"让查询变复杂 | M | M | 用 `current_version` 视图 + `lineage.ts` 统一封装，调用方不直接写递归 SQL |
| skill 的 schema 以后会变，投影随之失效 | M | M | 投影只取键和引用字段，payload 原样保存；变化时只需改对应的一个 projection 文件 |
| cast 按名字匹配很脆弱（同名角色、别名冲突） | M | L | 匹配不上就报 problem 拒绝导入；同名情况在 problem 里提示，不自动猜 |
| `node:sqlite` 的 API 还在演进 | L | M | 所有调用都收在 `db/` 和 `repo/` 里；engines 要求 ≥ 24 |
| 预留的任务和剪辑表到 Phase 5–7 时发现不合用 | M | L | 用 `user_version` 迁移演进；场景测试先验证核心语义 |
| TypeScript 7 与类型剥离的组合出问题 | L | L | 已在 scratchpad 实测 `tsc` 加运行通过；锁定版本 `7.0.2` |

## Notes
- **本项目目录目前不是 git 仓库**。建议实施前先 `git init`（这一步由用户决定，计划不自动执行）。
- 技术栈（TypeScript + Node + `node:sqlite`，运行时零依赖）来自 PRD 的建议，用户在讨论中没有反对。如果想改用 `better-sqlite3`，只影响 `db/connection.ts`。
- 选择**每个项目一个 SQLite 文件**，而不是一个库装所有项目：分享或归档时按目录复制即可，也省掉了每张表的 `project_id`。多项目列表到 Phase 4 再通过扫描目录实现。
- "侧面"是本计划新引入的概念：同一个场景 S01 被 outline、art、staging 三个 skill 分别描述，只有按侧面版本化，"改了美术不影响大纲"才能成立。
- 60 集规模的导入性能本阶段不测；如果 Phase 4 实测发现慢，再给 `entity_version(entity_id, facet, v)` 之外补索引。

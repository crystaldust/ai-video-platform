# Plan: 节点协议与 skill 挂载（PRD Phase 2）

## Summary
把 skill 变成平台能执行的节点：定义 skill 包清单（pack manifest），把本机的 novel-* 链注册成第一套包、按阶段挂载；实现执行器——按「配方」走 seed → 装配提示词 → 调文本模型 → 补 id → validate → 带违规重试 → 超过上限转人工，每次尝试都落库；通过后直接导入项目库。第一版给 outline 和 script 写完整配方，其余阶段先用通用的单遍配方（Phase 4 补全）。

## User Story
作为想把小说做成短剧的开发者型作者，我希望平台自己调用 skill 的脚本和模型、自己处理质量门不过的重试，从而不用再在对话里一步步推着 agent 跑大纲和剧本。

## Problem → Solution
skill 只能在 Claude Code / Codex 对话里由 agent 按 SKILL.md 手动执行 → 平台按清单和配方确定性地执行 skill，每次调用、每次违规、每次重试都有记录，产出自动入库。

## Metadata
- **Complexity**: Large（约 20 个文件）
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`
- **PRD Phase**: Phase 2 节点协议与 skill 挂载
- **Depends**: Phase 1（complete）；与 Phase 3 并行——本阶段只定义 `TextModel` 接口，并提供「命令行模型」和测试用的脚本化模型；正式的供应商适配器、预设、费用在 Phase 3
- **Estimated Files**: 新建 ~16，修改 ~4

---

## UX Design

### Before
```
作者 ⇄ Claude Code 对话
  「跑 novel-outline」→ agent 读 SKILL.md → 写 JSON → 跑 validate → 不过 → agent 改 → …
  产出 JSON 落在某个目录 → 作者手动 `cli import <dir> outline x.json`
```

### After
```
$ cli pack register ~/dramas/duko packs/novel.pack.json --root ~/.claude/skills
$ cli input ~/dramas/duko 梗概.txt --episodes 6 --seconds 60 --genre 悬疑
$ cli run ~/dramas/duko outline --model-cmd "claude -p"
  ▸ outline · novel-outline@3.0.0
    skeleton  #1 ✗ 2 处违规 → #2 ✓
    episodes  1–6 ✓
    ids ✓  validate ✓ 15/15
  ✓ 已导入 outline v1（run 3，4 次模型调用）
$ cli run ~/dramas/duko script --model-cmd "claude -p"
```
重试 3 次仍不过：
```
  ✗ needs_human：最后一版在 runs/7/out/outline.json，违规见 runs/7/violations.txt
    修好后：cli import ~/dramas/duko outline runs/7/out/outline.json --run 7
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 执行 skill | 对话里由 agent 执行 | `cli run <dir> <stage>` | 不需要对话推进 |
| 质量门不过 | agent 自觉改 | 执行器把违规原文带回模型重试，上限 N 次 | 默认 3 |
| 人工接管 | — | 状态 `needs_human`，留下最后一版文件和违规清单 | `import --run` 结案 |
| 追溯 | 无 | 每次尝试的提示词、输出、违规、用量都在库里 | `cli runs <dir>` 查看 |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/import/import-artifact.ts` | 25-40, 110-127 | 执行器通过后调用它入库；ImportError 的问题清单要转成「违规」回给模型 |
| P0 | `src/repo/artifacts.ts` | all | 取上游最新产物（要新增按阶段取 doc） |
| P0 | `src/cli.ts` | all | 新命令沿用 parseArgs / need / withProject / print 模式 |
| P0 | `src/db/migrations.ts`、`src/db/schema-v2.ts` | all | 新增迁移 v3 的写法 |
| P1 | `src/project.ts` | all | 项目目录结构（新增 `runs/`） |
| P1 | `test/helpers.ts`、`test/cli.test.ts` | all | 测试夹具与 CLI 冒烟写法 |
| P1 | 上游 `skills/novel-outline/SKILL.md` Step 0–6 | — | 大纲是两遍：骨架（`validate --stage beats`）→ 分批分集（≤10 集/批）→ `ids --write` → 完整 validate |
| P1 | 上游 `skills/novel-script/SKILL.md`、`references/script-pass.md` | — | 剧本：`seed <outline> --eps a-b` → 按集写 → `ids --outline --write` → `validate --outline [--art]` |
| P2 | `src/import/projections/*.ts` | — | 投影的问题清单也是一道门（平台门） |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| `node:child_process` execFile | Node 24 docs | 用 `execFile(process.execPath, [script, ...args], { timeout, maxBuffer })`，不经过 shell，参数不需要转义；超时会 kill 子进程并以 `error.killed` 表示 |
| skill 脚本 CLI | 上游各 `scripts/<skill>.mjs` 无参数时打印的 USAGE | validate 违规时 exit 1，stdout 为「✗ N 处违规…」加逐行「质量门未过：…」；通过时 exit 0 打印「✓ 通过校验」 |

外部研究结论：
```
KEY_INSIGHT: skill 的 SKILL.md 是写给交互式 agent 的（有「问用户」「开子代理」这类步骤），不能整份原样当提示词让模型一次产出
APPLIES_TO: 配方设计——每一遍只给模型对应的 pass 参考文件（outline-pass.md / episode-pass.md / script-pass.md）+ schema.md + SKILL.md 中的「边界」段
GOTCHA: SKILL.md 里「⛔ 用户拍板」在一键模式下跳过，run 记录 `skippedHumanGates`，Phase 4 再提供可选的暂停点

KEY_INSIGHT: id 由程序分配（ids --write），模型不要写 id
APPLIES_TO: 提示词装配要明确「不要输出 id 字段」；配方在 validate 之前必跑 ids
GOTCHA: ids 只补不改——模型若自己编了格式错的 id，会被 validate 的 ids 门拦下，重试提示里要点明「删掉 id 字段」
```

---

## Patterns to Mirror

### NAMING_CONVENTION
```ts
// SOURCE: src/repo/artifacts.ts:20-27
export function latestArtifact(db: DatabaseSync, stage: Stage): { id: number; v: number; contentHash: string } | null {
export function appendArtifactVersion(db: DatabaseSync, input: ArtifactInput): ArtifactVersionRef {
```
仓储函数 `动词 + 名词`，第一个参数是 `db`；输入用 `XxxInput` 接口，返回用只读接口。文件头一到三行中文注释说明职责与原则。

### ERROR_HANDLING
```ts
// SOURCE: src/import/import-artifact.ts:25-33
export class ImportError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`导入失败：${problems.length} 处问题`);
    this.name = 'ImportError';
    this.problems = [...problems];
  }
}
```
可预期的业务失败用带 `problems` 清单的错误类；不可预期的直接抛 `Error`，消息用中文、点名对象。

### TRANSACTION
```ts
// SOURCE: src/db/transaction.ts:8-19
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  ...
}
```
注意：`withTransaction` 只接同步函数。执行器是异步的（等模型），**不能**把整个 run 包进一个事务——每条 attempt 单独写入，最后的导入走 `importArtifact` 自己的事务。

### MIGRATION
```ts
// SOURCE: src/db/migrations.ts:7 / src/db/schema-v2.ts
export const MIGRATIONS: readonly string[] = [SCHEMA_V1, SCHEMA_V2];
export const SCHEMA_V2 = `
ALTER TABLE entity_version ADD COLUMN episode_key TEXT;
...`;
```
只追加新迁移；表用 `STRICT`，JSON 列加 `CHECK (json_valid(...))`，枚举列加 `CHECK (x IN (...))`。

### CLI
```ts
// SOURCE: src/cli.ts:64-71
function cmdImport(args: string[], flags: Record<string, string>) {
  const usage = 'import <dir> <stage> <file.json> [--skill <name@ver>]';
  const [dir, stage, file] = [need(args[0], usage), need(args[1], usage), need(args[2], usage)];
  if (!isStage(stage)) throw new Error(`不认识的 stage：${stage}（可选 ${STAGES.join(' / ')}）`);
  ...
  return withProject(dir, (p) => importArtifact(...));
}
```
结果 JSON 打到 stdout（`print`），问题打到 stderr（`main` 的 catch，见 `src/cli.ts:128-137`）。进度行（▸ / ✓ / ✗）写 stderr，保证 stdout 仍是可解析的 JSON。

### TEST_STRUCTURE
```ts
// SOURCE: test/helpers.ts:45 / test/import.test.ts
test('同一份产物重复导入不产生新版本', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  ...
  cleanup();
});
```
`node:test` + `node:assert/strict`；中文测试名描述行为；每个测试自建临时项目并 cleanup；夹具每次重新读盘。

---

## 关键设计

### 1. skill 包清单（pack manifest）
平台仓库自带 `packs/novel.pack.json`；注册时指定 skill 根目录（例如 `~/.claude/skills` 或 fork 的 `skills/`）。
```json
{
  "name": "novel",
  "description": "shuohao-skills 的 novel-* 链",
  "requires": { "major": 3 },
  "skills": [
    { "name": "novel-outline",    "stage": "outline",    "script": "scripts/novel-outline.mjs",    "recipe": "novel-outline" },
    { "name": "novel-characters", "stage": "cast",       "script": "scripts/novel-characters.mjs", "recipe": "single-pass" },
    { "name": "novel-art",        "stage": "art",        "script": "scripts/novel-art.mjs",        "recipe": "single-pass" },
    { "name": "novel-script",     "stage": "script",     "script": "scripts/novel-script.mjs",     "recipe": "novel-script" },
    { "name": "novel-staging",    "stage": "staging",    "script": "scripts/novel-staging.mjs",    "recipe": "single-pass" },
    { "name": "novel-storyboard", "stage": "storyboard", "script": "scripts/novel-storyboard.mjs", "recipe": "single-pass" },
    { "name": "character-refs",   "stage": null,         "script": "scripts/character-refs.mjs",   "recipe": null }
  ]
}
```
- `stage: null` 表示非文本节点（图片），Phase 5 再挂载；注册时照样记录版本。
- 版本、名称从各 `SKILL.md` frontmatter 读（`name:` / `version:`），不信清单；清单只管映射。
- 注册时记 `SKILL.md` 和脚本文件的 sha256：skill 修了 bug 没升版本号也能追溯到具体内容。
- `requires.major`：novel-outline / art / script / staging / storyboard 必须 ≥ 3（平台键依赖稳定 id），不满足拒绝注册并提示 pull 上游。novel-characters 2.x、character-refs 2.x 允许。

### 2. 配方（recipe）
配方是 TypeScript 里的步骤数组（不做通用 DSL，YAGNI），步骤类型：
| kind | 作用 |
|---|---|
| `seed` | 跑 skill 脚本拿骨架（stdout 是 JSON） |
| `llm` | 装配提示词调模型，输出 JSON；可按集分批（`batch: { size }`），结果按 ep 合并进某个字段 |
| `ids` | 跑 `ids <out> --write [...]` |
| `validate` | 跑 skill 的 validate；不过就进入**修复循环**：把整份当前 JSON + 违规原文交给模型，要求输出改好的整份 JSON（保留已有 id），再 ids → validate，直到通过或用尽尝试次数 |
| `platform-gate` | 用 `PROJECTIONS[stage]` 干跑一遍（不写库），把投影问题当违规——任何配方最后都有这一道 |

- **novel-outline**：`llm skeleton`（outline-pass.md + schema.md；产出 adaptation/characters/scenes/beats/params）→ `validate --stage beats`（修复循环）→ `llm episodes`（episode-pass.md + schema.md，每批 ≤10 集，合并进 `episodes`）→ `ids` → `validate`（full，修复循环）→ `platform-gate`。
- **novel-script**：`seed <outline> --eps a-b`（每批 ≤3 集）→ `llm`（script-pass.md + schema.md + 上游大纲 + 骨架；合并进 `episodes`）→ `ids --outline` → `validate --outline [--art]`（修复循环）→ `platform-gate`。
- **single-pass**（通用）：`seed`（skill 有 `seed` 命令且上游齐时）→ `llm`（SKILL.md 全文 + schema.md + 上游）→ `ids`（skill 有 ids 时）→ `validate`（skill 有时）→ `platform-gate`。只有提示词的第三方 skill 也能跑这个配方。

「有没有某个命令」由注册时探测：无参数运行脚本，读 USAGE 里是否有 `seed ` / `ids ` / `validate ` 行，结果存进 skill 表的 `capabilities`（与 Skill 包设计稿的 seed / validate / ids 三个标签一致）。

### 3. 提示词装配
```
system:  平台规则（只输出一个 JSON 代码块；不要写 id 字段；不要对白越界…）
         + SKILL.md 中的「边界（不做的事）」段与 frontmatter description
user:    【本遍任务】pass 参考文件全文
         【数据结构】schema.md 全文
         【项目参数】集数、单集时长、题材（来自 project_input）
         【上游】需要的上游 JSON（大纲 / 美术…），从库里最新产物取
         【骨架】seed 输出（如有）
         【只写这几集】批次范围（如有）
         【上一次的违规】逐条原文（修复循环时）
```
输出解析：取第一个 ```json 代码块，没有就取第一个 `{` 到最后一个 `}`；解析失败本身算一条违规「输出不是合法 JSON：…」，进入重试。

### 4. 文本模型接口（Phase 3 实现正式适配器）
```ts
// src/model/text-model.ts
export interface TextRequest { readonly system: string; readonly user: string; readonly maxOutputTokens?: number }
export interface TextUsage { readonly inputTokens: number | null; readonly outputTokens: number | null }
export interface TextResult { readonly text: string; readonly usage: TextUsage }
export interface TextModel {
  readonly id: string;               // 记进 run，例如 "cmd:claude -p" / "deepseek:deepseek-chat"
  complete(req: TextRequest, signal?: AbortSignal): Promise<TextResult>;
}
```
本阶段自带：
- `CommandTextModel(argv)`：把 system + user 拼好写进子进程 stdin，读 stdout 作为输出（`--model-cmd "claude -p"` 或任何能读 stdin 的命令行模型）。不经过 shell，按空白切分参数（不支持引号，USAGE 写明）。usage 记 null。
- 测试用 `ScriptedTextModel`（放 `test/support/`）：按调用顺序返回预设文本，并把收到的请求存下来供断言。

### 5. 数据（迁移 v3）
```sql
CREATE TABLE project_input (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('synopsis','novel')),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  params TEXT NOT NULL CHECK (json_valid(params)),   -- {episodes, seconds, genre}
  created_at TEXT NOT NULL
) STRICT;                                             -- 只追加，最新一条生效

CREATE TABLE skill_pack (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK (json_valid(manifest)), registered_at TEXT NOT NULL
) STRICT;

CREATE TABLE skill (
  id INTEGER PRIMARY KEY, pack_id INTEGER NOT NULL REFERENCES skill_pack(id),
  name TEXT NOT NULL, version TEXT NOT NULL, stage TEXT CHECK (stage IS NULL OR stage IN ('outline','cast','art','script','staging','storyboard')),
  dir TEXT NOT NULL, script TEXT, recipe TEXT,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities)),  -- {"seed":true,"ids":true,"validate":true}
  skill_md_hash TEXT NOT NULL, script_hash TEXT,
  UNIQUE (pack_id, name)
) STRICT;

-- 挂载只追加，同一阶段最新一条生效
CREATE TABLE stage_mount (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('outline','cast','art','script','staging','storyboard')),
  skill_id INTEGER NOT NULL REFERENCES skill(id), mounted_at TEXT NOT NULL
) STRICT;

CREATE TABLE node_run (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL, skill_id INTEGER NOT NULL REFERENCES skill(id), model TEXT NOT NULL,
  input_id INTEGER REFERENCES project_input(id),
  status TEXT NOT NULL CHECK (status IN ('running','passed','needs_human','failed','resolved')),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  artifact_version_id INTEGER REFERENCES artifact_version(id),
  skipped_human_gates TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skipped_human_gates)),
  error TEXT, started_at TEXT NOT NULL, ended_at TEXT
) STRICT;

CREATE TABLE node_attempt (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES node_run(id),
  step TEXT NOT NULL,                 -- skeleton / episodes:1-6 / repair:validate-full …
  n INTEGER NOT NULL CHECK (n >= 1),
  system_prompt TEXT NOT NULL, user_prompt TEXT NOT NULL,
  output TEXT, violations TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(violations)),
  usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
  started_at TEXT NOT NULL, ended_at TEXT
) STRICT;
CREATE INDEX node_attempt_run ON node_attempt(run_id);
```
- 重启后发现 `status = 'running'` 的 run：标为 `failed`（error「进程中断」）。文本节点没有付费外部任务 ID 需要续查，重跑即可（与 Phase 5 的可靠任务区分开）。
- 运行目录 `runs/<runId>/`：`in/<stage>.json`（上游）、`work/`（seed、批次中间件）、`out/<stage>.json`（最后一版）、`violations.txt`。脚本只读写这个目录。

### 6. 人工接管
用尽尝试 → `needs_human`，留下最后一版与违规；`cli import <dir> <stage> <file> --run <id>` 导入成功后把 run 标为 `resolved` 并关联产物版本。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `packs/novel.pack.json` | CREATE | 第一套包的清单 |
| `src/db/schema-v3.ts`、`src/db/migrations.ts` | CREATE / UPDATE | 迁移 v3 |
| `src/skills/frontmatter.ts` | CREATE | 读 SKILL.md 的 name / version、截取「边界」段 |
| `src/skills/manifest.ts` | CREATE | 清单类型与校验（不信任外部 JSON，逐字段校验） |
| `src/skills/script-runner.ts` | CREATE | execFile 跑 skill 脚本；探测 capabilities |
| `src/repo/skills.ts` | CREATE | 注册包、挂载、查当前挂载 |
| `src/repo/inputs.ts` | CREATE | project_input 读写 |
| `src/repo/runs.ts` | CREATE | node_run / node_attempt 读写；中断 run 收尾 |
| `src/repo/artifacts.ts` | UPDATE | 新增 `latestArtifactDoc(db, stage)` |
| `src/model/text-model.ts` | CREATE | 接口 |
| `src/model/command-model.ts` | CREATE | 命令行模型 |
| `src/executor/json-output.ts` | CREATE | 从模型输出抽 JSON |
| `src/executor/prompt.ts` | CREATE | 提示词装配 |
| `src/executor/recipes.ts` | CREATE | novel-outline / novel-script / single-pass 配方 |
| `src/executor/run-node.ts` | CREATE | 执行器主循环 |
| `src/import/import-artifact.ts` | UPDATE | `ImportOptions.runId`：导入成功后结案 run |
| `src/project.ts` | UPDATE | 新增 `RUNS_DIR` |
| `src/cli.ts` | UPDATE | `pack register` / `mount` / `input` / `run` / `runs` / `import --run` |
| `test/support/scripted-model.ts` | CREATE | 测试用模型 |
| `test/fixtures/skills/…` | CREATE | 上游 novel-outline、novel-script 的副本（SKILL.md、references、scripts）+ 一个只有提示词的假 skill；`test/fixtures/skills/UPSTREAM.md` 写明来源提交 |
| `test/skills.test.ts`、`test/executor.test.ts`、`test/runs.test.ts`、`test/cli.test.ts` | CREATE / UPDATE | 见测试策略 |

## NOT Building
- 正式的供应商文本适配器、预设、费用估算、凭据（Phase 3）
- novel-characters / art / staging / storyboard 的专用多遍配方（Phase 4，先走 single-pass）
- 一键串联多个阶段、全貌界面、打回重跑与「需复核」联动（Phase 4）
- 「用户拍板」暂停点（Phase 4，可选）
- 图片节点执行（Phase 5）
- skill 包的远程安装、更新检查（设计稿里的「有新版本」提示留到 UI 阶段）

---

## Step-by-Step Tasks

### Task 1: 迁移 v3 与 project_input
- **ACTION**: 新建 `src/db/schema-v3.ts`，按「关键设计 5」建表；`MIGRATIONS` 追加；`src/repo/inputs.ts` 提供 `addInput(db, {kind, text, params})` / `currentInput(db)`。
- **MIRROR**: MIGRATION、NAMING_CONVENTION
- **GOTCHA**: params 校验：episodes 1–200 整数、seconds 10–600、genre 非空；不合法抛 Error 点名字段。
- **VALIDATE**: `test/migrations.test.ts` 新增「v2 库升到 v3」；inputs 单测。

### Task 2: frontmatter 与清单校验
- **ACTION**: `parseFrontmatter(md)` 只解析顶层 `name:` / `version:` 标量行和 `description: |` 块；`boundarySection(md)` 截取以「**边界」开头的段落；`parseManifest(json)` 逐字段校验（name、skills[].name/stage/script/recipe），未知 recipe、未知 stage、路径含 `..` 或绝对路径都拒绝。
- **GOTCHA**: 清单来自用户文件，不信任：`script` 必须是 skill 目录内的相对路径（`resolve(dir, script)` 后仍以 `dir + sep` 开头）。
- **VALIDATE**: 用上游真实 SKILL.md 副本断言 name/version；坏清单逐条报错。

### Task 3: 脚本执行与能力探测
- **ACTION**: `runSkillScript(skill, args, {cwd, timeoutMs=60_000})` → `{code, stdout, stderr}`；`probeCapabilities(skill)` 无参运行读 USAGE，匹配行首 `seed `、`ids `、`validate `。
- **IMPLEMENT**: `execFile(process.execPath, [scriptPath, ...args], { cwd, timeout, maxBuffer: 32 MiB, encoding: 'utf8' })` 包成 Promise；非零退出不 reject（validate 不过是正常结果），超时 / spawn 失败才 reject 并带上命令和 stderr 尾部。
- **GOTCHA**: 不经过 shell；`args` 里的路径都在运行目录内。
- **VALIDATE**: 对副本 skill 跑 `validate` 坏样例拿到 exit 1 与违规行；超时用一个 `while(true)` 的假脚本测 kill。

### Task 4: 包注册与挂载
- **ACTION**: `registerPack(db, manifestPath, root)`：读清单 → 每个 skill 读 SKILL.md、算哈希、探测能力、检查 `requires.major` → 一个事务写 skill_pack + skill；返回注册结果与逐项问题（缺目录的 skill 记问题但不阻断其他 skill）。注册后对清单中有 stage 的 skill **默认挂载**（该阶段尚未挂载时）。`mountSkill(db, stage, skillName)`、`currentMount(db, stage)`。
- **GOTCHA**: 能力探测是异步的，先探测完再进同步事务写库。
- **VALIDATE**: 注册副本包 → 6 个阶段都有挂载；2.x 版本的 novel-script 拒绝；换挂载后 `currentMount` 变化。

### Task 5: 模型接口与命令行模型
- **ACTION**: `src/model/text-model.ts`（接口，见设计 4）；`CommandTextModel`：spawn 命令、stdin 写入 `system + '\n\n' + user`、收集 stdout，非零退出 reject 带 stderr；支持 `AbortSignal`。
- **VALIDATE**: 用 `node -e "process.stdin.pipe(process.stdout)"` 当模型，断言回显。

### Task 6: 输出解析与提示词装配
- **ACTION**: `extractJson(text)` → `{ ok: true, value } | { ok: false, violation }`；`buildPrompt({ skill, step, input, upstream, skeleton, range, violations })` 按设计 3 拼接，返回 `{ system, user }`。
- **GOTCHA**: 上游 JSON 只放配方声明需要的阶段，避免把整库塞进提示词；违规清单原文照抄，不改写。
- **VALIDATE**: 快照式断言关键段落存在；坏 JSON、无代码块、多个代码块（取第一个）三种情况。

### Task 7: 配方
- **ACTION**: `recipes.ts` 导出 `RECIPES: Record<string, Recipe>`，实现 novel-outline、novel-script、single-pass（设计 2）。批次划分函数 `batches(n, size)`；合并函数按 `ep` 排序覆盖同 ep。
- **GOTCHA**: 大纲的集数来自 project_input.params.episodes；剧本的集数来自上游大纲 `episodes.length`。single-pass 遇到 skill 没有 seed / ids / validate 就跳过对应步骤，但 `platform-gate` 永远执行。
- **VALIDATE**: 纯函数单测：批次、合并、步骤序列。

### Task 8: 执行器主循环
- **ACTION**: `runNode(project, stage, { model, maxAttempts = 3, onProgress })`：
  1. 取当前挂载与输入、上游最新产物（缺上游直接报「先跑 / 导入 X」）；建 run 记录与 `runs/<id>/` 目录，上游写进 `in/`。
  2. 依配方执行；每次 `llm` 调用写一条 attempt（含完整提示词、输出、违规、用量）。
  3. validate / platform-gate 不过 → 修复循环，计数到 `maxAttempts` 为止（按每道门分别计数）。
  4. 全过 → `importArtifact(project, stage, doc, { skill: `${name}@${version}`, sourcePath: out 文件, runId })`；若导入抛 ImportError，问题清单当违规再进修复循环（与 platform-gate 同理，通常已被提前拦住）。
  5. 用尽 → `needs_human`，写 `out/` 与 `violations.txt`；模型或脚本抛异常 → `failed` 并记 error。
  - 启动时调用 `failInterruptedRuns(db)`。
- **GOTCHA**: 异步流程不包事务（见 TRANSACTION）；每一步写库都要独立成功。进度通过 `onProgress` 回调输出，不在库函数里写 stdout。
- **VALIDATE**: 见测试策略。

### Task 9: CLI
- **ACTION**: 新命令：
  - `pack register <dir> <manifest.json> --root <skillsRoot>`
  - `mount <dir> <stage> <skill-name>`
  - `input <dir> <file.txt> --episodes N --seconds S --genre G [--kind synopsis|novel]`
  - `run <dir> <stage> --model-cmd "<cmd>" [--max-attempts 3]`：进度写 stderr，结果 JSON 写 stdout；`needs_human` 时退出码 2
  - `runs <dir> [--id N]`：列出 run 与尝试摘要（不打印完整提示词，`--id` 时附提示词长度与违规）
  - `import ... --run <id>`
- **MIRROR**: CLI
- **VALIDATE**: `test/cli.test.ts` 新增冒烟：register → input → run（`--model-cmd` 指向测试里的回放脚本 `test/support/replay-model.mjs`，按序吐出预设输出）。

### Task 10: 测试夹具
- **ACTION**: 从 `crystaldust/shuohao-skills@main` 拷贝 novel-outline、novel-script 的 `SKILL.md`、`references/`（不含 test-fixtures）、`scripts/` 到 `test/fixtures/skills/`；写 `UPSTREAM.md` 记录来源提交与拷贝命令；另建 `test/fixtures/skills/prompt-only/SKILL.md`（无脚本）。
- **GOTCHA**: 副本只用于测试，平台运行时用注册的真实目录；上游更新后按 UPSTREAM.md 重新拷贝。
- **VALIDATE**: 副本的 `validate` 能跑通 duko 夹具（exit 0）。

### Task 11: 文档与 PRD
- **ACTION**: 新增 `docs/node-protocol.md`：清单格式、配方、执行与重试语义、run 目录结构、人工接管流程；PRD Phase 2 标 complete（由 /prp-implement 收尾时做）。

---

## Testing Strategy

### Unit Tests
| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| frontmatter 读版本 | 上游 SKILL.md 副本 | name=novel-outline, version=3.0.0 | |
| 清单拒绝越界路径 | `script: "../x.mjs"` | 问题「脚本路径必须在 skill 目录内」 | ✓ |
| 2.x skill 拒绝注册 | version 2.0.0 的 novel-script | 问题提示 pull 上游 | ✓ |
| 能力探测 | 副本脚本 | outline: ids+validate，无 seed；script: seed+ids+validate | |
| extractJson | 代码块 / 裸 JSON / 坏 JSON | ok / ok / 违规 | ✓ |
| 批次 | n=6,size=10 / n=25,size=10 | [1-6] / [1-10,11-20,21-25] | ✓ |
| 合并 | 两批同 ep | 后者覆盖、按 ep 排序 | ✓ |

### Integration Tests（ScriptedTextModel + 副本 skill）
| Test | 剧本 | 期望 |
|---|---|---|
| 大纲一次通过 | 骨架 = duko 大纲去掉 episodes/ids；分集 = duko episodes 去掉 id | run passed，产物入库为 outline v1，集都带新 id，4 道门全过，2 条 attempt |
| 骨架违规后修复 | 第一版骨架缺 beats | 第 2 次请求的提示词包含 validate 违规原文；最终 passed |
| 坏 JSON 重试 | 第一版输出是散文 | 违规「输出不是合法 JSON」，第二版通过 |
| 用尽转人工 | 三次都缺 hook | needs_human；`runs/<id>/out/outline.json` 与 violations.txt 存在；库里没有 outline 产物 |
| 人工结案 | 上例 + 手工修好的文件 `import --run` | run resolved，关联 artifact_version |
| 剧本需要上游 | 空项目跑 script | 抛错「先跑或导入 outline」，不建 run |
| 剧本一次通过 | 先导入 duko 大纲；模型按批返回 duko 剧本对应集（去掉场次 / 节拍 id） | passed；场次 id 由 ids 补上；集 id 与大纲一致 |
| 平台门拦截 | single-pass 的假 skill 输出缺 `episodes` | 投影问题作为违规进入修复 |
| 中断恢复 | 预置 status=running 的 run 后调用 runNode | 旧 run 变 failed（进程中断） |
| 进度回调 | 任意 | onProgress 收到 step 开始 / 结束事件 |

### Edge Cases Checklist
- [x] 空输入（没有 project_input 就跑 outline）→ 报错提示先 `input`
- [x] 模型命令不存在 / 非零退出 → run failed，error 带 stderr 尾部
- [x] skill 脚本超时 → run failed，点名命令
- [x] 上游产物缺失 → 不建 run
- [x] 并发：同一项目同一阶段已有 running 的 run → 拒绝再开（提示等它结束）
- [ ] 网络失败——由 Phase 3 的供应商适配器处理

---

## Validation Commands

### Static Analysis
```bash
pnpm typecheck
```
EXPECT: Zero type errors

### Unit + Integration
```bash
node --test test/skills.test.ts test/executor.test.ts test/runs.test.ts
```

### Full Test Suite + Coverage
```bash
pnpm test && pnpm coverage
```
EXPECT: 全部通过；行 ≥ 80%、分支 ≥ 70%、函数 ≥ 80%

### Manual Validation（真实模型，Phase 2 的 success signal）
- [ ] `cli init /tmp/duko --name 渡口` → `pack register /tmp/duko packs/novel.pack.json --root <fork 的 skills 目录>`
- [ ] `cli input /tmp/duko <渡口梗概.txt> --episodes 6 --seconds 60 --genre 悬疑`
- [ ] `cli run /tmp/duko outline --model-cmd "claude -p"` → passed，`checkup` 15/15
- [ ] `cli run /tmp/duko script --model-cmd "claude -p"` → passed，`checkup` 全过
- [ ] `cli runs /tmp/duko` 能看到每次尝试；`stale` 为空
- [ ] Phase 3 完成后用 DeepSeek 适配器再跑一次同样流程

---

## Acceptance Criteria
- [ ] 7 个 novel skill 注册成一套包，6 个文本阶段各挂一个
- [ ] outline、script 用平台执行器跑出通过全部质量门的产物并自动入库（脚本化模型的集成测试 + 一次真实模型的手工验证）
- [ ] 违规带原文重试；超过上限转人工，人工修好后可结案
- [ ] 每次模型调用的提示词、输出、违规、用量都可追溯
- [ ] 类型检查、全部测试、覆盖率门槛通过

## Completion Checklist
- [ ] 代码沿用仓储 / 迁移 / CLI / 测试的既有模式
- [ ] 外部输入（清单、SKILL.md、模型输出、脚本输出）全部校验
- [ ] 子进程不经过 shell，路径限制在 skill 目录与 run 目录内
- [ ] 不在库函数里写 stdout
- [ ] 文档 `docs/node-protocol.md`

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SKILL.md 面向交互 agent，拆成单遍提示词后质量下降 | M | M | 每遍只给对应 pass 文件 + schema；修复循环兜底；真实模型手工验证后再调提示词 |
| 大纲一次输出过长被截断 | M | M | 骨架与分集分开、分集按 ≤10 集分批 |
| 命令行模型（`claude -p`）输出夹带解释文字 | H | L | 只取第一个 json 代码块；系统提示要求只输出代码块 |
| 上游 skill 的 CLI 改了参数 | L | M | 能力探测 + 副本测试；注册时记脚本哈希 |
| 测试夹具副本与上游漂移 | M | L | UPSTREAM.md 记录来源提交，更新时一起改 |

## Notes
- Phase 3 的 `TextModel` 适配器只要实现本计划的接口即可接入执行器；`--model-cmd` 继续保留，作为「自定义命令」适配器。
- 「用户拍板」类人工确认在一键模式下跳过，并记在 run 的 `skipped_human_gates`，让全貌视图能显示「这一步没有经过人工确认」。

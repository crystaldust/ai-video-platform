# Plan: 角色参考图提示词改由 character-refs 生成（backlog #29），关键帧加写实画风层

## Summary

角色阶段写完 novel-characters 的角色卡后，再给每个要出图的角色多问一遍文本模型，把角色卡拆成 character-refs 的分层字段（intake）。拆出的字段用 character-refs 的 `intake-check` 校验，然后用 `new --look 写实` 建资产，用 `prompt` 逐个视图取提示词。字段和 5 个视图的提示词一起存进角色卡。

付费生成计划不再自己拼角色提示词，只读角色卡里存好的提示词。关键帧加上同一套写实画风句和反向词。图片默认分辨率改成 2k。

character-refs **不用改**：它已有 `intake-check`、`new`、`prompt` 三个命令，平台直接调用。

## User Story

作为用这个平台做短剧的人，我想让角色图和关键帧用 character-refs 实测调好的提示词和写实画风去出，这样出来的人物姿势对、视图对，不像廉价的 AI 图，也不用为同一个角色反复花钱重出。

## Problem → Solution

**现在**：`src/generate/prompts.ts` 拿 novel-characters 的整版设定图提示词（`image.prompt`，自带半身、灰褐背景、浅景深），后面接一句取景。冒烟测试里出现了这些问题：
- 取景放在最后，派生视图把长描述整段重复；
- 负面提示词和描述互相冲突；
- 没有画风层；
- 分辨率是 1k。

**改成**：
- 提示词由 character-refs 的 `buildPrompt` 生成，取景放第一句，派生视图只带一句简短的一致性说明，加写实画风层和反向词；
- 关键帧加写实画风句和反向词；
- 分辨率 2k，价格表里 qwen-image-3.0 的 2k 和 1k 同价。

## Metadata

- **Complexity**: Large（跨执行器、角色配方、生成计划、测试夹具，不改库结构）
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`（Phase 5 的修复）
- **PRD Phase**: Phase 5a 冒烟后的修复；PR #16 已合并，本计划在新分支 `feat/character-refs-prompts` 上另提 PR
- **Estimated Files**: 源码 5 个、测试 4–5 个、夹具 2 组、文档 3 个

## 已定（GATE 1 之前与用户确认）

1. **画风**：统一用写实照片，即 character-refs 的 `realistic-photo` 预设。角色图和关键帧用同一套。本计划不做按项目选画风。
2. **在哪一步拆字段**：在角色阶段多问一遍。拆出的字段和提示词跟角色卡一起存，可以在全貌页审阅、打回。已有项目要重跑一次角色阶段（DeepSeek，每个角色几分钱，跑之前征得同意）。
3. **不改 skill**：shuohao-skills 只读（`/Users/lance/Development/ai-video/shuohao-skills-stable-ids`）。

---

## UX Design

内部改动，界面没有新东西：
- 角色阶段多出几步模型调用，运行记录里能看到 `refs:C01` 这样的步骤；
- 生成计划在缺提示词时报错，提示「重跑角色阶段」。

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 角色阶段运行 | `card:*` 加 `summary` | 多出 `refs:*`（每个出图角色一步，不过校验再加一次修复） | DeepSeek，费用很小 |
| `cli generate` / 计划 | 用 `image.prompt` 拼 | 读 `characterRefs.views`；缺了就报「角色卡「X」没有出图提示词：先重跑角色阶段」 | 不再静默用旧提示词 |
| 角色图 / 关键帧尺寸 | budget 预设 1k | budget 预设 2k | 同价 |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/executor/stage-recipes.ts` | 1–90 | 角色配方 `novelCharacters`，要在这里加一遍 |
| P0 | `src/executor/recipe-kit.ts` | 54–145, 214–230 | `RecipeContext`、`AskParts`、`Check`、`validateCheck` |
| P0 | `src/executor/run-node.ts` | 100–110, 290–352 | `parseViolations`、`context()`（`readFile`、`runMounted` 的写法） |
| P0 | `src/generate/prompts.ts` | 全部 | 要删的常量和保留的 `VIEW_ORDER`、`pickRefs`、`sizeFor` |
| P0 | `src/generate/planner.ts` | 78–152 | `characterDrafts`、`keyframeDrafts` |
| P0 | character-refs `scripts/core.mjs` | 25–35, 124–250, 255–310, 337–372 | 视图表、`buildPrompt`、`intakeProblems`、`assetFromIntake` |
| P0 | character-refs `scripts/character-refs.mjs` | 41–73, 392–430 | `INTAKE_TEMPLATE`，以及 `intake-check`、`new`、`prompt` 三个命令 |
| P0 | character-refs `references/intake.md` | 全部 | 拆字段的规则，直接作为这一遍的任务说明 |
| P1 | `src/repo/skills.ts` | 140–200 | `toSkillRow`、`currentMount`；要加按名查同包 skill 的函数 |
| P1 | `src/skills/script-runner.ts` | 全部 | `runScript`、`describeFailure` |
| P1 | `test/stage-recipes.test.ts` | 1–45 | 角色配方测试的写法 |
| P1 | `test/support/duko-model.ts`、`test/support/novel-pack.ts` | 全部 | 假模型怎么按步骤作答、怎么注册测试包 |
| P1 | `test/fixtures/skills/UPSTREAM.md` | 全部 | 测试用的 skill 副本从哪拷来 |
| P2 | `test/generate-prompts.test.ts`、`test/generate-planner.test.ts` | 全部 | 要改的断言 |
| P2 | `presets/budget.json` | 7–8 | 图片 size |

## External Documentation

不需要外部调研。百炼参数已在 Phase 5a 核对过：`negative_prompt` 是 parameters 里的字段，2k 档尺寸在 `SIZES` 里。character-refs 的提示词规则都写在它自己的 `references/prompting.md` 里。

---

## Patterns to Mirror

### 跑另一个 skill 的脚本（照 runMounted）
```ts
// SOURCE: src/executor/run-node.ts:344-350
runMounted: async (stage, args) => {
  const mounted = currentMount(this.project.db, stage);
  if (!mounted?.script) throw new Error(`阶段 ${stage} 挂载的 skill 没有脚本，不能运行 ${args[0]}`);
  const r = await runScript(join(mounted.dir, mounted.script), args, { cwd: this.dir });
  if (r.code !== 0) throw new Error(describeFailure(`${mounted.name} ${args[0]}`, r));
  return r.stdout;
},
```

### 每个角色问一遍模型（照角色卡）
```ts
// SOURCE: src/executor/stage-recipes.ts:64-75
const card = await ctx.ask(`card:${String(c['id'] ?? c['name'])}`, {
  task, schema, source,
  sections: [{ title: '同批其他角色（长相、声线不要撞车）', body: ... }],
  base: baseCards.get(c['name']),
  draft: c,
  draftLabel: '这个角色的骨架（seed 预填：名单、分档、弧光由大纲定，不要推翻）',
  outputSpec: '只输出这一个角色的完整角色卡（一个 JSON 对象），name 与骨架一致，seedNote 不要输出。',
});
```

### 违规解析
```ts
// SOURCE: src/executor/run-node.ts:102-109
export function parseViolations(code: number, stdout: string, stderr: string): string[] { ... }
```
character-refs 的 `intake-check` 不通过时，往 stderr 打「✗ N 处问题：」，下面每行一条，退出码 1。`parseViolations` 能直接解析这个格式。

### 报错风格
```ts
// SOURCE: src/generate/planner.ts:88
if (!card) throw new Error(`角色卡里没有「${name}」（${id}）：先跑或导入角色阶段`);
```

### 测试结构
```ts
// SOURCE: test/stage-recipes.test.ts:21-33
const { project, cleanup } = tempProject();
await setupNovel(project);
importAll(project, ['outline']);
const model = dukoModel();
const out = await runNode(project, 'cast', { model });
assert.equal(out.status, 'passed', `${out.message}\n${out.violations?.join('\n')}`);
assert.deepEqual(steps(project, out.runId), ['card:C01', ...]);
```

---

## 角色卡里新增的字段

在 novel-characters 的角色卡上加一个键，novel-characters 的 validate 不管多出来的键（Task 3 里要验证）：

```jsonc
"characterRefs": {
  "skill": "character-refs@2.1.0",           // 生成时的 skill 版本，排查用
  "look": "realistic-photo",
  "intake": { /* 通过 intake-check 的整份 intake，text 字段是给人看的中文 */ },
  "views": {
    "front-full": { "prompt": "…", "negative": "…", "ratio": "2:3", "refs": [] },
    "face-front": { "prompt": "…", "negative": "…", "ratio": "4:5", "refs": ["front-full"] },
    "side-full":  { … }, "back-full": { … }, "face-45": { … }
  }
}
```

- 只有大纲里分档不是 `functional` 的角色才有这个键，和 `characterDrafts` 的筛选一致。
- 5 个视图和 `VIEW_ORDER` 一致。face-45 在 skill 里是第 4 档，但平台的估算一直按 5 张算，这次不改口径。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/repo/skills.ts` | UPDATE | 加 `findSkill(db, packId, name)`：在同一个包里按名字找 skill |
| `src/executor/recipe-kit.ts` | UPDATE | `RecipeContext` 加 `companion(name)`，返回 `{ readFile(rel), run(args): Promise<ScriptResult> } \| null` |
| `src/executor/run-node.ts` | UPDATE | 实现 `companion`：同包找 skill，用 `runScript`，cwd 是运行目录 |
| `src/executor/character-refs.ts` | CREATE | 角色卡 → intake → 校验与修复 → `new` → `prompt` × 5 → `characterRefs`。从配方里拆出来，免得 stage-recipes 超过 400 行 |
| `src/executor/stage-recipes.ts` | UPDATE | 角色配方在 `cards` 写完、`summary` 之前，给每张出图角色卡挂 `characterRefs` |
| `src/generate/prompts.ts` | UPDATE | 删 `CHARACTER_VIEWS`、`characterViewPrompt`；加关键帧写实画风常量和 `keyframeNegative`；`keyframePrompt` 末尾加画风句 |
| `src/generate/planner.ts` | UPDATE | 角色视图读 `characterRefs.views`；关键帧带 `negativePrompt` |
| `presets/budget.json` | UPDATE | 两个图片节点的 `size` 从 1k 改成 2k |
| `test/fixtures/skills/character-refs/` | CREATE | 拷 skill 副本：SKILL.md、references、scripts（不含 selftest） |
| `test/fixtures/skills/UPSTREAM.md` | UPDATE | 记 character-refs 的来源和拷贝命令 |
| `test/fixtures/duko/渡口-intake.json` | CREATE | 4 个出图角色的 intake，假模型的答案 |
| `test/fixtures/duko/渡口-cast.json` | UPDATE | 给 4 个出图角色补 `characterRefs`，用拷来的 skill 脚本按上面的 intake 生成，不手写 |
| `test/support/duko-model.ts` | UPDATE | `refs:*` 步骤按 `渡口-intake.json` 作答 |
| `test/support/novel-pack.ts` | UPDATE | 注释改掉（副本里已经有 character-refs） |
| `test/stage-recipes.test.ts` | UPDATE | 角色配方的新断言 |
| `test/character-refs-recipe.test.ts` | CREATE | intake 修复、skill 没注册、`new`/`prompt` 出错等分支 |
| `test/generate-prompts.test.ts` | UPDATE | 删旧断言，加关键帧画风断言 |
| `test/generate-planner.test.ts` | UPDATE | 角色视图提示词来自 `characterRefs`；缺了就报错；关键帧带 negative |
| `docs/generation.md` | UPDATE | 「计划什么」表里提示词的来源、画风、2k |
| `docs/models-and-pricing.md` | UPDATE | budget 预设的图片改成 2K |
| `.claude/PRPs/backlog.md` | UPDATE | #29 标完成，写明「不用改 skill，直接调已有命令」 |

## NOT Building

- 按项目选画风（只用写实）；
- 界面上单独展示 intake 确认表（全貌页审阅角色卡时能看到原始 JSON，专门的界面放到 5b）；
- character-refs 的第 3 档细节图（平台的节点不包含它）；
- 场景图、道具图（backlog #28）；
- 修改 shuohao-skills；
- 冒烟清单上的其它条目（401/402 停止提交、`problems` 汇总、确认单估算快照等），那些另起修复计划；
- 用模型重写关键帧的 `frame` 正文（时代感不对是分镜文本的问题）。

---

## Step-by-Step Tasks

### Task 1：按名字找同包 skill，执行器加 `companion`

- **ACTION**：在 `src/repo/skills.ts` 加 `findSkill`；在 `RecipeContext` 加 `companion`，在 `run-node.ts` 实现。
- **IMPLEMENT**：
  - `findSkill(db, packId, name): SkillRow | null`，SQL 是 `SELECT * FROM skill WHERE pack_id = ? AND name = ?`。
  - `companion(name)`：`findSkill(db, ctx.skill.packId, name)`，找不到就返回 null。
  - `readFile(rel)` 照 `context().readFile` 的写法，在 skill 目录里读，文件不存在返回空串。
  - `run(args)` 调 `runScript(join(dir, script), args, { cwd: this.dir })`，原样返回 `ScriptResult`，不因非零退出码抛错，由调用方用 `parseViolations` 或 `describeFailure` 处理。
  - 没有 script 的 skill，`run` 直接抛错。
- **MIRROR**：`runMounted`（run-node.ts:344）。
- **IMPORTS**：`findSkill` from `../repo/skills.ts`；`ScriptResult` 类型 from `../skills/script-runner.ts`。
- **GOTCHA**：
  - 必须在**同一个包**里找。项目可能注册过好几个包（临时副本和 worktree），按名字取最新的一个可能取到别的版本。
  - `readFile` 的 rel 只能来自代码里的常量，不能来自文档内容。
- **VALIDATE**：`pnpm typecheck`。`stage-recipes.test` 的新用例里通过 companion 跑 `intake-template` 能拿到 JSON。

### Task 2：`src/executor/character-refs.ts`，从角色卡生成 characterRefs

- **ACTION**：新建模块，导出 `characterRefsFor(ctx, card, opts): Promise<Doc>`、`REFS_SKILL = 'character-refs'`、`REFS_LOOK = '写实'`、`REFS_VIEWS`（从 `src/generate/prompts.ts` 的 `VIEW_ORDER` 导入）。
- **IMPLEMENT**：
  1. `const refs = ctx.companion(REFS_SKILL)`，为 null 就抛错：「没有注册 character-refs：角色图提示词要由它生成（pack register 重新注册 novel 包）」。
  2. 任务说明 = `refs.readFile('references/intake.md')`，加上 `intake-template` 的 stdout（含 `_说明` 和样例结构）。这两样每次运行只取一次，由调用方传进来，免得每个角色读一遍。
  3. `ctx.ask(\`refs:${id}\`, { task, schema: 模板 JSON, sections: [{ title: '角色卡', body: JSON（persona、image、name） }], base: 旧卡的 characterRefs?.intake, outputSpec: '只输出这个角色的 intake（一个 JSON 对象）：name 照抄角色卡；lang 写 zh；outfit.details 写 4 个默认槽位或这个角色的特征；en 只写英文、不写人名和画风词；手里不拿东西（道具归美术），配饰可以挂在身上。' })`。
  4. 把结果写到 `ctx.writeWork(\`intake-${id}.json\`, doc)`，然后 `refs.run(['intake-check', path])`，用 `parseViolations` 解析。
     - 有违规就再问一次，step 名是 `refs:${id}:repair`，sections 里加一节 `{ title: '上一次的违规', body }`，draft 是上一次的输出。
     - 最多 `MAX_INTAKE_TRIES = 3` 次，还不过就抛错，带上违规。
  5. `refs.run(['new', path, '--out', join(work, \`refs-${id}\`), '--look', REFS_LOOK])`，非零退出就 `describeFailure` 抛错。
     - asset 路径：读 `refs-${id}` 下唯一的子目录里的 `asset.json`，子目录名是 skill 用 safeName 改写过的角色名，所以不要自己拼。
  6. 对 `REFS_VIEWS` 的每个视图，跑 `refs.run(['prompt', assetPath, view])`，`JSON.parse` stdout，得到 `{ view, text, negative, ratio, refs }`。
  7. 返回 `{ skill: \`${REFS_SKILL}@${版本}\`, look: asset.outfits.default.look.id, intake, views: { [view]: { prompt: text, negative, ratio, refs } } }`。版本取 companion 的 SkillRow.version，所以 companion 还要带 `version`。
- **MIRROR**：角色卡的 `ctx.ask`（stage-recipes.ts:64）。违规用 `parseViolations`，先在 run-node.ts 导出（已导出）。
- **IMPORTS**：`join` from `node:path`；`readdirSync`、`readFileSync` from `node:fs`；`parseViolations` from `./run-node.ts`（如果有循环依赖，就把 `parseViolations` 挪到 `recipe-kit.ts` 再导出）；`describeFailure` from `../skills/script-runner.ts`；`VIEW_ORDER` from `../generate/prompts.ts`。
- **GOTCHA**：
  - `new` 发现目标已存在会报错，所以每个角色用自己的输出目录。运行目录每次是新的，重跑不会撞。
  - `prompt` 的 stdout 是 `JSON.stringify(…, null, 2)`，整段 parse，不要逐行解析。
  - intake 的 `name` 必须和角色卡一致。`intakeProblems` 会查 en 里有没有角色名；中文名不会出现在英文里，但模型可能写拼音，这种情况靠修复轮处理。
  - 不要把 `image.prompt` 当成素材整段塞给模型照抄，它带景别、背景和光。只把它当外形参考，persona.appearance 是主来源。outputSpec 和 sections 的标题都要写明这一点。
- **VALIDATE**：新测试 `test/character-refs-recipe.test.ts` 覆盖：
  - 一次过；
  - 第一次违规、第二次过（检查 step 名和违规小节）；
  - 3 次都不过就抛错；
  - 没注册 character-refs 就报错；
  - 生成的 `views['face-front'].prompt` 以 `Zoom in to an extreme close-up` 开头，`views['front-full'].prompt` 含 `A real photograph, not a render`。

### Task 3：角色配方挂上 characterRefs

- **ACTION**：在 `novelCharacters.run` 里，所有 `cards` 写完之后、`summary` 之前，给出图角色的卡加上 `characterRefs`。
- **IMPLEMENT**：
  - 出图角色 = `ctx.upstream.outline.characters` 里 `tier !== 'functional'` 的那些 id。outline 是角色阶段的硬依赖，一定在。
  - 按顺序逐个调 `characterRefsFor`，不并发，和 `card:*` 一致，运行记录也好读。
  - `base` 取 `baseCards.get(name)?.characterRefs?.intake`。
  - 结果并进卡：`{ ...card, characterRefs }`，不修改原对象。
  - `ctx.gate`（novel-characters validate）照旧对整份文档跑。修复轮让模型交回整份 cast.json 时，可能把 `characterRefs` 弄丢或改坏，所以 gate 的 `post` 要把 `characterRefs` 按角色 name 原样补回去。修复只管 novel-characters 的违规，不该动 characterRefs。
- **MIRROR**：`cardFrom` / `omit` 的不可变写法（stage-recipes.ts:47）。
- **GOTCHA**：
  - 先验证 novel-characters 的 validate 不会拒绝多出来的键：给 `渡口-cast.json` 加一个 `characterRefs` 跑 validate，在测试里断言通过。
  - 修复 prompt 里的整份 cast 会带上 characterRefs，篇幅变大。可以在 repair 的 draft 里先把 characterRefs 去掉，`post` 再补回去，修复的输入输出都会小很多。推荐这样做。
  - 平台门 `finalGate` 的投影会把卡片写进角色的 entity_version。卡片变大不影响功能，只会让内容哈希变化，角色版本加一。
- **VALIDATE**：`test/stage-recipes.test.ts` 的角色用例改成：
  - steps 是 `card:C01…C05`、`refs:C01…C04`、`summary`（C05 是 functional）；
  - 入库文档里 C01–C04 有 `characterRefs.views` 的 5 个视图，C05 没有；
  - 「validate 不过时整份修复」那条用例，修完后 characterRefs 还在。

### Task 4：生成计划改读 characterRefs，关键帧加画风

- **ACTION**：改 `prompts.ts` 和 `planner.ts`。
- **IMPLEMENT**：
  - `prompts.ts`：
    - 删 `CHARACTER_VIEWS`、`characterViewPrompt`、`SAME`、`BASE_NEG`、`FACE_NEG`、`ViewSpec`；保留 `VIEW_ORDER`、`ANCHOR_VIEW`、`Ratio`、`pickRefs`、`sizeFor`、`FRAME_CLOSING`。
    - 新增 `KEYFRAME_STYLE`：写实剧照，不是渲染图，色彩和白平衡真实，皮肤有自然纹理，衣料有自然褶皱，轻微胶片颗粒。不写 photorealistic，不写镜头焦距，景别由 frame 决定。
    - 新增 `KEYFRAME_NEGATIVE`：character-refs 写实预设的 neg（逐字抄过来，注明来源是 `looks.mjs` 的 REALISTIC）加上 `text, watermark, border, deformed hands, extra fingers, extra limbs`。
    - `keyframePrompt` 改成：参考说明 + frame + `KEYFRAME_STYLE` + `FRAME_CLOSING`。
  - `planner.ts` 的 `characterDrafts`：
    - `const refs = isDoc(card['characterRefs']) ? card['characterRefs'] : null`，为 null 就抛错：`角色卡「${name}」（${id}）没有出图提示词：先重跑角色阶段（角色图提示词由 character-refs 生成）`。
    - 每个视图取 `views[view]`，缺了也抛错。
    - `size = sizeFor(v.ratio, 尺寸档)`，`ratio` 用 `isRatio` 守卫一下。
    - `deps` 按 `v.refs` 里有没有 `ANCHOR_VIEW` 决定，不再查常量。
    - `plannedInput` 加 `negativePrompt: v.negative`。
  - `keyframeDrafts`：`plannedInput` 加 `negativePrompt: KEYFRAME_NEGATIVE`。runner 的 `field(t, 'negativePrompt')` 已经是通用写法，不用改。
  - 尺寸档：`c.params['size'] === '1k' ? '1k' : '2k'`。默认改成 2k，只有显式选 1k 才用 1k。
- **MIRROR**：planner 现有的抛错与 `text()` / `list()` 小工具。
- **GOTCHA**：
  - `content_fingerprint` 由 plannedInput 算。提示词变了，指纹就变，已经入库的旧任务不会被当成同一个任务，这是对的。
  - 同一张确认单重复计划时只建一次任务（幂等）。冒烟副本里的确认单 3 已经建过任务，重跑计划不会更新旧任务的提示词，要出新图得新开一张确认单。这一点要写进文档和最后的汇报。
- **VALIDATE**：
  - `test/generate-planner.test.ts`：
    - 角色视图的 prompt 等于夹具里 `characterRefs.views[view].prompt`；
    - 删掉某个角色的 characterRefs 后，计划报「先重跑角色阶段」；
    - face-front 的 deps 只有锚点，front-full 没有 deps；
    - 关键帧的 plannedInput 有 negativePrompt；
    - 默认 size 是 2k 档（`1344*2016`，9:16 是 `1152*2048`）。
  - `test/generate-prompts.test.ts`：关键帧提示词含 `KEYFRAME_STYLE`，并以 `FRAME_CLOSING` 结尾。

### Task 5：测试夹具

- **ACTION**：拷 skill 副本，写 intake 夹具，生成 cast 夹具里的 characterRefs，接上假模型。
- **IMPLEMENT**：
  1. 照 UPSTREAM.md 的拷法，拷 `character-refs` 的 SKILL.md、`references/*.md`、`scripts/*.mjs`，不拷 selftest，来源是 `shuohao-skills-stable-ids`。UPSTREAM.md 记下 character-refs 2.1.0 和来源提交号（用 `git -C <worktree> rev-parse HEAD` 查）。只读上游，不写。
  2. 写 `test/fixtures/duko/渡口-intake.json`，形如 `{ "沈知微": {...}, "陆行远": {...}, "老周": {...}, "胡二爷": {...} }`。按 `渡口-cast.json` 各卡的 persona.appearance 手工拆，每份都要过 `intake-check`。
  3. 在 scratchpad 写一次性脚本，对每份 intake 跑 `new --look 写实` 和 5 次 `prompt`，组成 characterRefs 写回 `渡口-cast.json`，键顺序放在 `voice` 后面。脚本不进仓库。
  4. `test/support/duko-model.ts`：user 里出现 `只输出这个角色的 intake` 时，按角色卡小节里的 name 返回对应的 intake。
  5. `novel-pack.ts` 的注释改成「副本里有 character-refs，stage 为 null，只注册不挂载」。
- **GOTCHA**：
  - `test/node-protocol.test.ts` 可能断言过「副本里没有 character-refs」，注册时会记问题。要一起改。
  - 夹具 cast 变了会影响 `projections.test.ts`、`entities.test.ts` 等按卡片内容断言的测试。跑全量测试，看哪些断言依赖卡片键数或哈希，按新内容更新预期（是夹具变了，不是代码错了）。
- **VALIDATE**：`pnpm test` 全绿。

### Task 6：预设、文档、backlog

- **ACTION**：`presets/budget.json` 的两个图片节点改成 `"size": "2k"`；更新文档。
- **IMPLEMENT**：
  - `docs/generation.md` 的「计划什么」：
    - 角色那一行的提示词来源改成「角色阶段由 character-refs 生成（写实画风），存在角色卡的 `characterRefs`」；
    - 关键帧那一行加「写实画风句与反向词」；
    - 加一句「改提示词要重跑角色阶段，再开新的确认单」。
  - `docs/models-and-pricing.md`：budget 预设的图片改成 2K，注明「国际站 2k 与 1k 同价」。
  - backlog #29：状态改成已完成（新 PR），说明「character-refs 已有 intake-check / new / prompt，平台直接调用，没改 skill」。
- **VALIDATE**：`pnpm typecheck && pnpm test`。`grep -rn "characterViewPrompt\|CHARACTER_VIEWS" src test` 没有结果。

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| 角色配方挂 characterRefs | 渡口大纲 + 假模型 | 出图角色有 5 个视图，functional 没有；steps 含 `refs:*` | |
| intake 修复 | 第一次答案带画风词 `anime` | 第二次 step 是 `refs:C01:repair`，违规小节含「画风词」 | ✓ |
| intake 一直不过 | 3 次都带中文 en | 抛错，信息含违规 | ✓ |
| 没注册 character-refs | 用删掉它的 manifest 注册 | 角色阶段失败，信息说要注册 | ✓ |
| novel-characters 修复后 characterRefs 还在 | validate 第一次不过 | 修完 characterRefs 原样在 | ✓ |
| 计划读 characterRefs | 夹具 | 提示词逐字相同，带 negative | |
| 缺 characterRefs | 删掉 C01 的 | 报「先重跑角色阶段」 | ✓ |
| 关键帧画风 | 任意 frame | 含 KEYFRAME_STYLE，带 negative | |
| 尺寸默认 2k | 预设没写 size 或写 2k | 2k 尺寸 | ✓ |

### Edge Cases Checklist

- [x] 空 / 缺：characterRefs 缺失或缺某个视图
- [x] 非法：intake 不合格，最多修 3 次
- [x] skill 没注册
- [x] 多个包：只在同一个包里找 character-refs
- [ ] 网络：不涉及（文本模型的重试由现有 `ask` 处理）

---

## Validation Commands

```bash
pnpm typecheck                 # 0 错
pnpm test                      # 全绿
pnpm coverage                  # 行 ≥80、分支 ≥70、函数 ≥80
pnpm web:typecheck && pnpm web:build   # 不动前端，确认不回归
grep -rn "characterViewPrompt\|CHARACTER_VIEWS" src test   # 无结果
```

### 手动验证（花钱，要单独征得同意）

1. **在冒烟副本上重跑角色阶段**（DeepSeek，约几毛钱）：确认 8 个角色的 characterRefs 生成成功，然后看两三个角色的 intake 中文 `text`。
2. **看提示词，免费**：用 `generate --plan-only`。如果它还不存在，就从库里读新建任务的 planned_input，确认取景在第一句、有写实画风句、尺寸是 2k。
3. **小额试跑**（约 ¥1，再问一次）：新开一张确认单，只勾 1 个角色的锚点和 1 张带手的关键帧，看图。

## Acceptance Criteria

- [ ] 所有任务完成
- [ ] 类型检查、测试、覆盖率全部通过
- [ ] 角色图提示词只来自 character-refs，平台里不再有角色视图的提示词常量
- [ ] 关键帧带写实画风句与反向词
- [ ] 默认 2k
- [ ] shuohao-skills 没有改动（`git -C <worktree> status` 干净）

## Completion Checklist

- [ ] 照 runMounted、角色卡 ask 的写法
- [ ] 报错是中文，并且说明下一步怎么做
- [ ] 不可变写法：卡片用展开合并
- [ ] 新模块不超过 200 行，stage-recipes.ts 不超过 450 行
- [ ] 没有凭据进代码、夹具、库

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| novel-characters validate 拒绝多出来的键 | 低 | 高 | Task 3 先验证；真被拒，就改存到卡片外的顶层 `characterRefs: { [name]: … }` |
| DeepSeek 拆的 intake 质量一般（漏服装、写成插画词） | 中 | 中 | intake-check 拦画风词和人名；outputSpec 写明规则；冒烟时人看 `text` |
| 2k 参考图超过百炼单张 10 MB | 中 | 中 | 已知缺口「参考图大小没有提前校验」，在 401/402 那份修复计划里一起做；冒烟时注意看 |
| 国内区 2k 价格和国际区不一样 | 中 | 低 | 国内价格表是待修清单第 6 条；先按国际价估 |
| 写实画风的关键帧和角色锚点（白底）放在一起，Qwen 把白底带进场景 | 中 | 中 | 关键帧提示词开头已经说明「参考图是角色设定图」；冒烟时看，不行再改参考说明 |
| 夹具变化引起大面积断言更新 | 中 | 低 | 只更新依赖卡片内容的预期，不改代码 |

## Notes

- **备选方案**：在平台里 `import` character-refs 的 `core.mjs`，直接调 `buildPrompt`。这样可以省掉子进程和工作目录。没有采用，因为平台对 skill 一律走子进程（`runScript`），不把 skill 代码加载进自己的进程。
- **冒烟副本要做的事**：确认单 3 已经建过的任务用的是旧提示词。验证新提示词要重跑角色阶段，再生成新的确认单。旧的 62 张图留着，方便对比。

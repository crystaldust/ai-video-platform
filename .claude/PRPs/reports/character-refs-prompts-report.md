# Implementation Report: 角色参考图提示词改由 character-refs 生成（backlog #29），关键帧加写实画风层

## Summary

角色阶段在角色卡过了 novel-characters 的校验之后，给每个出图角色（大纲分档不是 functional）多问一遍文本模型，把角色卡拆成 character-refs 的分层字段（intake）。然后：

- 用 character-refs 的 `intake-check` 校验，不过就带违规重问，最多 3 次；
- `new --look 写实` 建资产，`prompt` 逐个取 5 个视图的提示词、反向词、比例和参考关系；
- 整份存进角色卡的新字段 `characterRefs`。

付费生成计划只读这些提示词，平台里自拼的角色提示词常量（方案 A）全部删掉。角色卡没有 `characterRefs` 时，计划报「先重跑角色阶段」。关键帧加了写实画风句与反向词（照抄 character-refs 写实预设的 neg）。budget 预设的图片从 1k 改成 2k（qwen-image-3.0 两档同价）。

character-refs 没改：它本来就有 `intake-template`、`intake-check`、`new`、`prompt`，平台通过新的 `RecipeContext.companion(name)` 在同一个包里调用。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large |
| Files Changed | 源码 5、测试 4–5、夹具 2 组、文档 3 | 源码 7（新增 1）、测试 6（新增 1）、夹具 3 组（新增 2）、文档 4、预设 1、backlog 1 |
| 测试 | — | 335 → 341 条，全部通过 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 同包 skill 查找与 `companion` | 完成 | 偏差 1 |
| 2 | `src/executor/character-refs.ts` | 完成 | 偏差 2、3 |
| 3 | 角色配方挂 characterRefs | 完成 | 偏差 4（审查后改了顺序） |
| 4 | 计划读 characterRefs，关键帧画风 | 完成 | |
| 5 | 测试夹具 | 完成 | |
| 6 | 预设、文档、backlog | 完成 | 偏差 5 |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | 通过 | 根目录 `tsc`、web typecheck 都是 0 错 |
| Unit Tests | 通过 | 341 条 |
| Coverage | 通过 | 行 98.2% / 分支 85.6% / 函数 95.5%；新模块行覆盖 100% |
| Build | 通过 | `web:build` |
| Integration（真实模型） | 未做 | 要花钱，等用户同意后在冒烟副本上重跑角色阶段 |
| 旧常量清理 | 通过 | `grep characterViewPrompt\|CHARACTER_VIEWS src test` 无结果 |
| shuohao-skills | 未改 | worktree `git status` 干净 |

## Deviations from Plan

1. **`parseViolations` 挪到 `recipe-kit.ts`**，run-node.ts 照旧导出。原因：新模块要用它，从 run-node 引会形成循环引用。
2. **intake 的细节只用 4 个默认槽位**（hair / neck / sleeve / feet）。原因：平台规则写着「不要输出任何 id 字段」，和自定义槽位要写 `id` 冲突；平台也不出细节图。
3. **任务说明里不用【】括标题**，改用「」。原因：提示词按【标题】分节，说明里出现「【角色卡】」会让按标题找节的地方（测试的假模型）找错。
4. **生成顺序改成「先过门、再生成 characterRefs」**。原计划是在 summary 之前生成、过门时剥掉、修完再补回。代码审查指出：校验修复如果改了外形描述，补回去的提示词还是按修复前的卡拼的。现在按过了门的卡片生成，门转人工时也不会白花这几遍。平台门复用同一个 post，那时 post 已经换成补回函数。补回时先按角色名找，名字对不上再按角色码找。
5. **`docs/node-protocol.md` 也改了**：说明 stage 为 null 的 skill 由配方在同包里调用。计划里没列。
6. **模型交回的卡片里的 `characterRefs` 一律丢掉**（`cardFrom`），只认 character-refs 生成的那份。这是实现时自己发现的问题：夹具卡片带上 characterRefs 后，模型交回的卡片会把它原样带进来。

## 审查

code-reviewer 和 security-reviewer 都没有 CRITICAL / HIGH。

| 来源 | 级别 | 问题 | 处理 |
|---|---|---|---|
| 代码 | MEDIUM | 校验修复改了外形后，characterRefs 是按旧卡生成的 | 改成过门后再生成（偏差 4） |
| 代码 | MEDIUM | 平台门修复改了角色名，characterRefs 补不回去 | 按名字找不到再按角色码找 |
| 代码 | LOW | `intake-check` 脚本自己崩了，堆栈被当成违规去问模型 | stderr 没有「✗」就直接报错 |
| 代码 | LOW | 不支持的画幅报成「缺视图，先重跑角色阶段」 | 单独报画幅问题 |
| 代码 | LOW | `companion.run` 同步抛错 | 改成 async |
| 代码 / 安全 | LOW | 角色码退回角色名时拼进文件名，可能带路径字符 | 只留字母、数字、`_`、`-` |
| 安全 | MEDIUM | 同一运行里配方重试时 `new` 撞已存在的目录 | 核实不会发生：`recipe.run` 每次运行只调一次（重试只在单次模型调用和修复轮），没改 |
| 安全 | LOW | 角色名是 `.` / `..` 时 skill 的 `new` 写到上一层 | 只会让这次运行失败，不出运行目录；skill 是上游的，没改 |
| 安全 | LOW | 原文经模型进出图提示词，没有长度上限 | 张数、尺寸固定，确认单先报价；百炼超长自动截断。没加上限 |

## Issues Encountered

- **百炼的长度上限**：反向词不超过 500 字符，超出自动截断（[百炼 Qwen-Image API](https://help.aliyun.com/zh/model-studio/qwen-image-api)）。character-refs 的正脸大头照反向词 514 字符，末尾十几个字符会被截掉；关键帧反向词 313 字符。正向提示词 1100–1900 字符，约 400 token，在上限内。已写进 `docs/generation.md`。
- 测试里两处断言原来按旧提示词的样子找图（「slender nineteen-year-old」），改成按夹具里 characterRefs 的原文找。

## Known Gaps

- **没有专门测「平台门修复后 characterRefs 还在」**。这条路径复用 skill 门的 post，代码审查追过；构造一个平台门违规的夹具成本高，这次没写。
- **没有测 `new` / `prompt` 脚本出错**：这两处都是 `describeFailure` 直接抛错。
- **冒烟副本要做的事**：确认单 3 已经建过的任务用的是旧提示词，不会被替换。验证新提示词要先在副本上重跑角色阶段（DeepSeek，花钱，先问），再开新的确认单小额试跑（约 ¥1，再问）。

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `test/character-refs-recipe.test.ts`（新） | 4 | intake 修复（step 名、违规小节、上一次的 intake）、3 次不过、没注册 character-refs、打回时旧 intake 当底稿 |
| `test/stage-recipes.test.ts` | 改 2 | 步骤顺序、5 个视图的提示词形状、功能角色没有、修复后按修好的卡生成、修复的输入不带 characterRefs |
| `test/generate-planner.test.ts` | +2、改 1 | 逐字取 characterRefs、缺 characterRefs / 缺视图报错、2k 默认、显式 1k、关键帧带画风与反向词 |
| `test/generate-prompts.test.ts` | 重写 2 | 视图顺序、关键帧画风句、反向词照抄写实预设且不超过 500 字符 |
| `test/generate-runner.test.ts` | 改 1 | 锚点先于派生视图（按夹具提示词找） |

## 冒烟（2026-11-03，`~/ShortDrama-smoke/自由北美-冒烟`）

- **角色阶段**（运行 20，DeepSeek）：8 个出图角色都有完整的 characterRefs。
- **分镜**（运行 21）：20 集通过，开出确认单 #3。
- **出图**（确认单 #3，只勾角色参考图，上限 ¥1，qwen-image-3.0）：
  - C01–C04 的正面全身锚点各出 1 张，1344×2016，每张 ¥0.213，共 ¥0.852，到上限后停下。
  - 4 张都是正面全身、白底、写实照片质感，服装和配件基本对得上提示词，比上一轮平台自拼提示词的效果好。
  - 派生视图（要挂锚点做参考图）这次没跑到。
- **提示词长度**：正面全身实际发出去 2400–2700 字符，约 600 token；qwen-image-3.0 按 800 token 算，还在上限内。上面「1100–1900 字符」是按夹具估的，偏低。
- 冒烟里发现的问题都不是这次改动引入的，记进 backlog #31。

## Next Steps

- [ ] GATE 2：用户确认后提交、开 PR
- [ ] 跑一次全部角色的图，看派生视图挂参考图的效果
- [ ] backlog #31 修复清单另起计划

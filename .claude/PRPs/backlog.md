# 待完成

还没排进计划的需求、改进和各阶段记下的遗留项。排进计划时用 `/ecc:prp-plan` 生成计划文件，并在这里标出计划链接；做完后移到文末「已完成」。

PRD 里已经排好的阶段（Phase 5–8）不在这里，见 `prds/ai-short-drama-platform.prd.md`。

## 总表

| # | 需求 | 类别 | 来源 | 状态 | 计划 |
|---|---|---|---|---|---|
| 1 | 小说原文通过文件上传导入 | 功能 | 用户 2026-10-29 | 待规划 | — |
| 2 | 长原文的分卷 / 分块处理（大纲、角色卡） | 功能 | 随 #1 | 待规划 | — |
| 3 | 骨架拍板暂停点（`go --pause-after outline`） | 功能 | 4a 计划 NOT Building | 待规划 | — |
| 4 | 编排运行中暂停 / 取消 | 功能 | 4b 设计稿 | 待规划 | — |
| 5 | 汇总里提示「没落实的打回」 | 功能 | 4a 评审 LOW | 部分完成：全貌已做；`go` 命令行汇总待规划 | [PR #15](https://github.com/crystaldust/ai-video-platform/pull/15) |
| 6 | 新建 / 另存预设 | 界面 | 4b 设计稿 | 待规划 | — |
| 7 | 页面上设置凭据 | 界面 | 4b 设计稿 | 待规划 | — |
| 8 | Skill 新版本提示与一键更新 | 界面 | 4b 设计稿 | 待规划 | — |
| 9 | 运行中「预计还要多久」 | 界面 | 4b 设计稿 | 待规划 | — |
| 10 | 剧本单元格显示时长 | 界面 | 4b 偏差 | 待规划 | — |
| 11 | 页面组件拆小（超过 50 行的组件） | 工程 | 4b 评审 MEDIUM | 待规划 | — |
| 12 | 设计稿按真实模型与价格更新 | 界面 | Phase 3 / 4b | 待规划 | — |
| 13 | 本地服务令牌改为不向任意本机进程暴露 | 安全 | 4b 评审 MEDIUM | 待规划 | — |
| 14 | 站位单集重跑并回时按场次 id 认场次 | 后端 | 4a 评审 LOW | 待规划 | — |
| 15 | 打回没开起来时不留孤儿意见记录 | 后端 | 4a 评审 LOW | 待规划 | — |
| 16 | 同层并发时看不到彼此的可选上游 | 后端 | 4a 评审 MEDIUM | 待规划 | — |
| 17 | 站位认图结果的退役 | 数据 | Phase 1 已知限制 | 待规划 | — |
| 18 | 过期查询在大项目下的性能 | 数据 | Phase 1 评审 M7 | 待规划 | — |
| 19 | 文本用量估算用实测数据校准 | 估算 | Phase 3 已知缺口 | 待规划 | — |
| 20 | DeepSeek 官方单价与上下文 / 输出上限核对 | 估算 | Phase 3 已知缺口 | 待规划 | — |
| 21 | 补 LICENSE 文件 | 工程 | README | 待规划 | — |
| 22 | 固定常用的 skills 目录 | 工程 | 2026-10-29 讨论 | 暂缓 | — |
| 23 | 站位修复轮按集拆开；单集修复截断时按场拆 | 后端 | 分镜截断修复 | 待规划 | — |
| 24 | 重跑时可选「不沿用、从头写」 | 界面 | 断点续跑审查 M2 | 已完成 | [PR #15](https://github.com/crystaldust/ai-video-platform/pull/15) |
| 25 | 质量门缓存键带上 skill 内容哈希 | 后端 | 2026-10-31 单句上限排查 | 待规划 | — |
| 26 | `web:dev` 下也能操作（令牌与同源） | 工程 | 2026-10-31 讨论 | 暂缓 | — |
| 27 | 平台测试夹具里的 skill 拷贝同步到 3.0.1 | 工程 | shuohao-skills fork PR #2 | 待 PR #2 合并 | — |

---

## 功能

### 1. 小说原文通过文件上传导入

**需求**：第一步可以从故事梗概或小说原文生成后续文本。用小说原文时要提供文件上传接口——小说原文字数很多，直接贴在文本框里不合适。

**现状**
- 新建项目页「小说正文」页签和「梗概」一样是文本框。
- 服务的请求体上限是 1 MB（`src/server/http.ts` 的 `MAX_BODY_BYTES`）；命令行 `input <dir> <file.txt>` 读的是文件，没有这个问题。
- 原文整段存在项目库的 `project_input.text` 里。

**规划时要定的事**
- **上传接口**：单独的上传接口和大小上限；一次传完还是分块传。
- **文件编码**：中文小说 txt 常见 GBK / GB18030，不只是 UTF-8。要识别编码、统一转成 UTF-8，识别不出来时让人确认，免得导入乱码。
- **原文存放**：继续整段存库，还是落成项目目录里的文件，库里只记路径与哈希。角色卡的引文要逐字对照原文，存哪都要能取回全文。
- **长原文**：见 #2。这次只做上传，还是连 #2 一起做，规划时定。
- **页面**：「小说正文」页签改成选择或拖入文件，显示文件名、字数、识别出的编码；按字数给出文本阶段的费用预估，超过上下文上限时提示。
- **测试**：GBK 与 UTF-8 样例、超大文件被拒、上传后跑通大纲。

**涉及**：`web/src/pages/NewProjectPage.tsx`、`src/server/routes/projects.ts`、`src/server/http.ts`、`src/repo/inputs.ts`。

### 2. 长原文的分卷 / 分块处理

执行器目前把原文整段放进提示词，大纲、角色卡两个阶段都会用到；原文一长就会撞上模型的上下文与费用上限。上游 skill 已经有对应的做法，平台的配方还没接上：
- novel-outline 有长篇按卷处理（`references/volume-pass.md`），平台的大纲配方只走「骨架 → 分集」。
- novel-characters 有分块扫描与归并（`chunk` / `merge` 命令），平台的角色卡配方是每个角色一遍、每遍都带整段原文。

**涉及**：`src/executor/recipes.ts`（大纲）、`src/executor/stage-recipes.ts`（角色卡）、`src/estimate/usage.ts`（按原文字数估算）。

### 3. 骨架拍板暂停点

novel-outline 的 Step 3 要用户拍板快版骨架（砍了哪条线、合了哪些人、大爆点落在第几集）。一键模式现在跳过它，只在运行记录里记下「跳过的人工拍板」。要做成可选的暂停点：`go --pause-after outline`，界面上看骨架、改或确认后继续。来源：`plans/completed/orchestration-rerun.plan.md`「NOT Building」。

### 4. 编排运行中暂停 / 取消

设计稿「运行中」有「暂停」按钮，现在灰显。编排器不支持中途停：要在阶段之间（或模型调用之间）检查取消标记，已经在跑的模型调用怎么处理（等它结束还是中止），被取消的运行如何收尾。来源：`reports/overview-web-ui-report.md` 偏差 9。

### 5. 汇总里提示「没落实的打回」

打回的运行转人工或失败后，产物没变、也没有需复核的格子，`go` 不会自动补跑，汇总会显示「done」。应在全貌的待处理里列出「有意见还没落实的打回」。来源：`reports/orchestration-rerun-report.md`。

**全貌部分已完成（PR #15）**，见文末「已完成」。**还剩**：命令行 `go` 的汇总也提示没落实的打回（可直接用 `src/repo/revisions.ts` 的 `unfulfilledRevisions`）。

---

## 界面

### 6. 新建 / 另存预设

设计稿「模型与预设」有「另存为新预设」「新建预设」。现在只能用内置的两套和用户目录里手写的预设。

### 7. 页面上设置凭据

模型页只读（是否配置、末 4 位），凭据要用命令行 `cred set` 从标准输入设置。页面上设置要注意：key 只经过本机服务，不进日志，不回显。

### 8. Skill 新版本提示与一键更新

设计稿「Skill 包」页有「有新版本 · 更新」。注册时记了 SKILL.md 与脚本的哈希，可以比对磁盘上的当前内容；换版本后下游标需复核。

### 9. 运行中「预计还要多久」

设计稿「运行记录」右上角的进度条。可以用估算的用量和最近几次运行的实际耗时推算。

### 10. 剧本单元格显示时长

全貌分集表的剧本列现在显示「几场 · 几句」：剧本时长由 novel-script 内部按语速折算，命令行没有输出。需要上游 skill 加一个输出统计的命令（在 fork 里做），平台读它，而不是另写一套折算。

### 11. 页面组件拆小

几个页面组件超过 50 行（以界面结构为主）：`EpisodePage`（约 150 行）、`NewProjectPage`、`OverviewPage`、`ModelsPage`、`SkillsPage`（约 130–140 行）。拆成子组件，不改行为。来源：Phase 4b 的 `/ecc:code-review`。

### 12. 设计稿按真实模型与价格更新

`designs/ai-short-video-platform.pen` 里的模型名（如 deepseek-chat、gpt-image-2）和价格是示意，和注册表、价格表不一致；视频按秒计费的示例偏低。按 `src/model/registry.ts` 与 `prices/builtin.json` 更新，并补「运行中」以外的空状态、错误状态画板。

---

## 后端与数据

### 13. 本地服务令牌改为不向任意本机进程暴露

令牌注入在 `index.html` 里，能访问本机 127.0.0.1 的任何进程（包括多用户机器上的其他用户）都能读到，进而注册 skill 包、执行其中的脚本。现在按「个人电脑、单用户」设计，已写进 `docs/web-ui.md`。改法：启动时把令牌打印在终端、通过一次性链接换成 HttpOnly cookie；或把 `/packs` 的路径限制在 skills 根目录内。来源：`reports/overview-web-ui-report.md`。

### 14. 站位单集重跑并回时按场次 id 认场次

`src/executor/scoped.ts` 合并站位时按集号（`ep`）替换场次。集号整体移位、但那几场本身没标需复核时，有极小概率删错场次。改为按剧本里这一集的场次 id 集合来替换。来源：4a 评审 LOW。

### 15. 打回没开起来时不留孤儿意见记录

`reject` 先写 `revision_request` 再开运行；阶段正忙等原因导致运行没开起来时，会留下一条没有运行对应的意见。改为同一事务里写，或运行开起来后再写。来源：4a 评审 LOW。

### 16. 同层并发时看不到彼此的可选上游

分层只看硬依赖：首次 `go` 时剧本拿不到同层的美术、美术拿不到同层的角色卡，它们的 validate 也少对账这一项。这是为并发做的取舍。可选改法：同层结束后对用到可选上游的阶段补一次对账（只报告），或把可选上游也纳入分层。来源：4a 评审 MEDIUM。

### 17. 站位认图结果的退役

站位里地点的认图结果跨集共用，导入时不退役：一个地点从所有站位里消失后，它的 staging 侧面仍然有效。来源：`reports/project-data-layer-report.md` 已知限制。

### 23. 站位修复轮按集拆开；单集修复截断时按场拆

分镜截断修复已经做了：写分镜时上游按集、按场裁剪，单集写不下按场拆；validate 的修复轮按集修（`RepairSplit`，违规按 `E02-01` 标签和段、场次 id 落到集上），只交回那一集再并回。还剩两处：
- **站位**的修复轮仍是「输出修正后的整份 staging.json」并带整份 art，长项目同样会撞上输出上限。可照分镜给站位一个 `RepairSplit`（站位按场次带 `ep`）。
- **单集修复本身截断**时没有按场再拆的兜底，直接转人工（步骤名 `repair:validate:epN`）。真实验证里单集修复约 12k 输出，离上限还远。

**涉及**：`src/executor/stage-recipes.ts`（站位的 repair、`storyboardSplit`）、`src/executor/run-node.ts`（`repairRound`）。

### 25. 质量门缓存键带上 skill 内容哈希

全貌的质量门结果按「阶段、挂载的 skill id、各阶段产物版本」缓存在内存里（`src/server/views/checkup.ts` 的 `versionsKey`）。skill 改了门（例如单句台词上限 35→22）但重新加载时版本号没变、还是同一条 skill 记录，缓存就不失效，全貌上的质量门和「按当前质量门不过」的待处理项还是旧规则算的，要重启服务才对。键里应带上 skill 记录的 `skillMdHash`、`scriptHash`。

**涉及**：`src/server/views/checkup.ts`。

---

### 18. 过期查询在大项目下的性能

`findStaleRefs` 每次全量现算，需复核矩阵和全貌页都依赖它。原定「60 集规模到 Phase 4 实测后再定」，还没有实测。来源：Phase 1 评审 M7。

---

## 估算与价格

### 19. 文本用量估算用实测数据校准

`src/estimate/usage.ts` 里只有大纲、剧本的每集用量是实测折算，角色、美术、站位、分镜按剧本比例粗估。4a、4b 已经有两次真实模型跑完六个阶段的记录（`node_attempt.usage`），可以据此校准。

### 20. DeepSeek 官方单价与上下文 / 输出上限核对

DeepSeek Flash 的价格来自第三方（标「未核对官方」），V4 Pro 暂无价格；注册表的上下文、输出上限是 128k / 32k 的假设值。用官方价目页或实际账单核对。来源：`reports/model-adapters-presets-cost-report.md`。

---

## 工程

### 21. 补 LICENSE 文件

`package.json` 与 README 写的是 Apache-2.0，仓库里还没有 `LICENSE` 文件。

### 26. `web:dev` 下也能操作（暂缓）

`pnpm web:dev`（Vite 开发服务器）把 `/api` 代理到本地服务，但页面里没有令牌（令牌只由服务托管的 index.html 注入），请求来源也和服务不同源，打回、重跑这类变更请求都会被拒（403），只能看不能操作。2026-10-31 讨论过的做法：服务加 `GET /api/dev/token`（本机、无外站 Origin 才给）；Vite 插件取令牌注入 index.html；代理转发时去掉 Origin。涉及安全检查，用户说先不做。

**涉及**：`src/server/server.ts`、`web/vite.config.ts`。

### 27. 平台测试夹具里的 skill 拷贝同步到 3.0.1

`test/fixtures/skills/` 是平台测试用的 skill 拷贝，novel-script 还是 3.0.0（单句上限 35 字）。fork 的 PR #2（crystaldust/shuohao-skills，35→22 字，novel-script 3.0.1）合并后，整份重新拷贝，跑平台测试确认不受影响（渡口样例的台词句数变了）。

### 22. 固定常用的 skills 目录（暂缓）

前几次真实模型验证注册的是会话临时目录里的导出副本，那些项目在库里记的是绝对路径，临时目录清掉后要重新 `pack register`。能用的长期目录是 worktree `shuohao-skills-stable-ids/skills`（3.0.0）；用户在用的 `shuohao-skills` 主干还是 2.x。用户说先不处理。

---

## 已完成

### 24. 重跑时可选「不沿用、从头写」（[PR #15](https://github.com/crystaldust/ai-video-platform/pull/15)）

`RunNodeOptions.fresh` 跳过续跑；`POST /go` 的 `fresh`（只能配合 `only`）、命令行 `go --only <stage> --fresh` 与 `run <dir> <stage> --fresh`；全貌详情面板「重跑」下的勾选项，勾上先确认。

### 5（全貌部分）. 全貌列出没落实的打回（[PR #15](https://github.com/crystaldust/ai-video-platform/pull/15)）

迁移 v6 给 `revision_request` 加 `dismissed_at`；`unfulfilledRevisions` 认出没落实的打回，附在对应的未通过项上或单独列出；详情里可「带同样意见再打回」或「放弃这条意见」（`POST /api/p/:id/revisions/:rid/dismiss`）。命令行汇总那部分仍在上面 #5。

# 开源 AI 短剧制作平台（暂名）

## Problem Statement

会自己部署 ComfyUI 一类工具的开发者型 AI 短剧作者，目前要和 AI agent 逐阶段地文字来回迭代（大纲 → 角色 → 剧本 → 分镜 → 生成 → 剪辑），始终看不到整部作品的全貌；模型和 skill 绑死在对话里，无法按成本或质量自由组合；生成"成功"的素材常常并不可用，返工时也说不清会波及哪些镜头。代价是：大量时间花在对话和人工搬运上，不合格素材流入剪辑，返工时容易整段重做、重复付费。

## Evidence

- EP001 旧版 082：API 返回成功，但画面里多了一个贝内特，最终靠人工发现——"任务成功"与"素材合格"必须分开记录。（来源：`docs/original_idea.md` 第三、七节）
- 首尾帧任务被供应商审核拒绝，成功版本实际只用了单首帧约束——计划输入与实际输入不一致，而当时没有结构化记录。
- 081 不用重做，只替换 082 就更新了合剪——局部返工有直接价值。
- 现有 novel-* skill 链中，`novel-storyboard` 不读 `staging.json`，走位句需要手工搬运（来源：`~/.claude/skills/novel-staging/SKILL.md`）——阶段之间的衔接靠人。
- 用户自述："现在需要大量的人和 agent 交互（文本沟通）……想先把整个流水线框架搭起来，有一个全貌，而不是一步一步地跟 AI agent 去迭代。"
- 对话轮次、耗时、返工成本暂无量化基线——**假设，需要在首次端到端运行时测量**。

## Proposed Solution

做一个本地运行（Web，后续可打包成桌面应用）的开源平台。输入梗概或小说后，**一键跑完全部文本阶段，生成整部作品的工程全貌**；遇到付费的图片和视频阶段先停下，给出费用估算，等人确认后再生成。每个节点的模型可以单独配置，并提供"小成本验证"和"生产级"两套预设；每个阶段可以从多套 skill 包里选一套挂载。所有对象（剧集、场景、角色、资产版本、镜头、生成任务、候选素材、审阅意见、剪辑片段）都有稳定 ID 和明确的引用关系，存入 SQLite，从而支持"成功 / 合格 / 选用"三态记录、影响追踪和镜头级局部重做。

选这个方案而不是现成产品，原因是：现有开源项目（Huobao Drama、ArcReel 等）多是模型写死的一键流水线，缺少审阅、版本和影响追踪；商用平台（LTX Studio、有戏AI、造剧等）闭源，模型和 skill 都不能配置。平台直接复用已有 novel-* skill 链"提示词 + 确定性 seed/validate"的结构，作为节点协议的原型。

## Key Hypothesis

我们相信"输入即生成全流程骨架 + 全貌视图 + 节点级模型和 skill 可配置"，能把 AI 短剧作者和 agent 之间的文字来回迭代，变成在全貌上的定点审阅和局部重做。
验证标准：作者用平台从一个梗概做到一集 30–60 秒成片，人工投入集中在审阅、选择和定点修订上，不需要靠对话推进阶段；并且能跑通 082 局部返工的验收案例。

## What We're NOT Building

- 多人实时协作 —— 第一版只服务一个作者本人
- 账号体系、付费和 SaaS 托管 —— 本地优先，凭据只保存在本机
- 模型训练或微调（如 LoRA 训练） —— 平台只编排推理
- 内置模型推理引擎 —— 只调用供应商 API 或本地 ComfyUI 等外部服务
- 电影级后期、调色、复杂混音 —— 导出到外部剪辑软件处理
- 同一阶段多套 skill 并行跑再择优 —— 每阶段只选一套，避免成本成倍增加
- 面向非技术用户的打磨体验 —— 等后续 UX/UI 迭代再做
- 只想"一句话出成片"、不审阅的用户场景 —— 和核心价值（审阅与局部重做）冲突

## Success Metrics

| Metric | Target | How Measured |
|--------|--------|--------------|
| 端到端跑通 | 1 集 30–60 秒成片，从梗概开始 | 验收运行记录 |
| 推进方式 | 文本阶段从输入到全貌**零对话推进**，人只在全貌上审阅、打回、重跑 | 运行日志：人工操作只出现在审阅和确认节点 |
| 局部返工（082 案例） | 修订 082 时，081 及其他镜头重新生成 0 次；成片自动引用新版 082 | 生成任务表、剪辑版本记录 |
| 可追溯性 | 100% 的入选素材能查到计划输入、实际输入、模型、参数、skill 版本、成本 | 随机抽查和数据完整性检查 |
| 重复付费 | 因断线或重启导致的重复付费生成 = 0 | 任务表：同一供应商任务 ID 不重复提交 |
| 费用估算偏差 | TBD —— 首次运行时记录"估算和实际"作为基线 | 预设估算值和实际账单对比 |
| 人工投入时长 | TBD —— 目前没有基线，首次端到端运行时测量 | 计时 |

## Open Questions

- [ ] 多数供应商不提供价格查询接口。拉取不到时怎么办：内置带更新日期的价格表兜底？由社区维护？界面上统一标注"仅供参考"。
- [ ] 第一版的模型组合：视频用 MiniMax H3 还是 Seedance？图片用 Qwen Image（ComfyUI）还是 GPT Image？文本默认用 DeepSeek？
- [ ] "全貌视图"具体包含什么：只有文本产物，还是加上低成本的分镜草图或动态预演？草图出图算不算付费确认点？
- [ ] skill 包协议怎么兼容非 Node 实现，以及没有 validate 脚本、只有提示词的 skill？
- [ ] 模型输出未通过质量门时的重试上限，以及最终失败后的人工接管方式。
- [ ] 配音和字幕阶段的供应商与 skill：现有 skill 链只有音色提示词，没有覆盖实际配音生成。
- [ ] 项目怎么导出和分享（排除凭据和私有素材）：SQLite 导出为什么格式？
- [ ] 开源许可证最终定为 Apache-2.0？（建议，待确认）

---

## Users & Context

**Primary User**
- **Who**: 具备自部署能力的开发者（能自己搭 ComfyUI、配置 API key、在本地跑 agent 和 skill），同时想做 AI 短剧。第一版锚定作者本人。
- **Current behavior**: 和 AI agent 逐阶段对话迭代，手动调用 novel-* skill，在阶段之间手工搬运产物，用 Markdown 和脚本管理素材、运行记录与剪辑单，靠人工逐帧检查发现连续性问题。
- **Trigger**: 手里有一个故事梗概或一部小说，想把它做成短剧。
- **Success state**: 一键得到整部作品的工程全貌，在全貌上审阅、修改、确认付费生成，最终得到可交付的成片；出问题时只重做有问题的镜头，并能说清楚原因和花费。

**Job to Be Done**
当我有一个故事梗概或一部小说时，我想一次性得到从大纲到分镜、再到镜头任务的完整工程全貌，这样我能在全貌上审阅、只修改有问题的部分，而不是和 agent 一轮一轮对话迭代。

**Non-Users**
- 需要多人实时协作的制作公司 —— 第一版没有协作和权限体系
- 只想要"一句话出成片"、不审阅的用户 —— 和平台的审阅与局部重做定位冲突
- 长片或电影级后期团队 —— 第一版只验证 30–60 秒单集，复杂后期交给外部软件
- 不具备部署能力的非技术创作者 —— 后续通过 UX/UI 迭代逐步覆盖，第一版不针对

---

## Solution Detail

### Core Capabilities (MoSCoW)

| Priority | Capability | Rationale |
|----------|------------|-----------|
| Must | 统一项目数据层（SQLite）：剧集、场景、角色、资产及其版本、镜头、生成任务、候选素材、审阅意见、剪辑片段，都有稳定 ID 和明确引用 | 局部返工、影响追踪、可追溯性的前提 |
| Must | 一键编排：输入梗概或小说，自动跑完文本阶段，在付费阶段之前停下来 | 核心假设——用"全貌"取代对话迭代 |
| Must | 全貌视图：按阶段展示所有产物和质量门结果，可以逐项打回重跑 | 核心假设的另一半 |
| Must | 节点协议：上游 JSON → seed → 模型按 skill 提示词填写 → validate → 不通过就带错误重试 → 产出 JSON，并记录 skill 版本 | 生产链靠明确的契约维持，而不是靠自然语言说明 |
| Must | skill 包挂载：每个阶段从已注册的 skill 包中选一套；第一套就是现有的 novel-* 链 | 可组合；复用已有资产 |
| Must | 节点级模型配置，内置"小成本验证"和"生产级"两套预设，可以按节点覆盖 | 用户明确要求；同一项目可以在成本和质量之间切换 |
| Must | 费用估算：每个节点和整个项目在生成前给出估算区间；价格尽量从供应商接口拉取，并标注"仅供参考"；生成后记录实际费用 | 付费确认点需要依据 |
| Must | 可靠任务执行：提交后立即保存供应商任务 ID，断线后续查，区分"重新查询"和"重新付费生成"，记录失败原因和实际参数 | 避免重复付费，保证可追溯 |
| Must | 一条完整的图片 + 视频生成链路（各一家供应商） | 端到端验收必需 |
| Must | 三态记录（执行成功 / 素材合格 / 被选用）+ 镜头级局部重做 + 影响追踪（上游资产变更后，把下游标记为需要复核；已选定的素材继续引用原来的具体版本） | 第一版的关键验收案例 |
| Must | 基础剪辑：镜序、入出点、字幕、声音轨，导出成片；剪辑引用素材的具体版本 | 端到端闭环 |
| Should | 时间点或帧级的审阅意见，关联到镜头，并给出可选的修订路径 | 原始构想中的返工交互；第一版可以先做到镜头级 |
| Should | 补上 staging → storyboard 的自动衔接 | 消除现有手工搬运 |
| Should | 临时配音先定时长，再生成视频 | 对白密集的场景避免返工 |
| Should | 导出到外部剪辑软件（如 EDL/FCPXML） | 复杂后期外移 |
| Could | 第二家视频供应商，验证插件接口 | 原始构想建议放在闭环之后 |
| Could | 自动质检辅助：黑帧、时长异常、疑似人物重复，并保留人工覆核 | 视觉模型可能误判，只作辅助 |
| Could | 动态预演片（分镜图 + 临时配音 + 简单剪辑） | 低成本检查节奏 |
| Won't | 可视化工作流节点编辑器（ComfyUI 式） | 先固定流水线，验证数据模型和节点协议；协议稳定后再做编辑器 |
| Won't | 同一阶段多套 skill 并行择优 | 成本成倍增加；已决定每阶段只选一套 |
| Won't | 多人协作、账号、SaaS | 见 NOT Building |

### MVP Scope

两步验证：

1. **全貌 MVP（先验证核心假设）**：输入梗概，一键跑完文本阶段（大纲 → 角色 → 美术 → 剧本 → 站位 → 分镜），在全貌视图中查看和打回重跑；可以切换预设，并看到后续图片和视频阶段的费用估算。
2. **闭环 MVP（第一版验收）**：在全貌之上确认付费生成，产出角色参考图、关键帧和视频片段，完成基础剪辑，得到一集 30–60 秒成片，并跑通 082 局部返工案例：保留 081，只修订和重新生成 082，成片自动更新，并能说明用了哪些输入、为什么换方案、花了多少钱。

数据结构从一开始就保留表达 N 集的能力，第一版只验收 1 集。

### User Flow

1. 新建项目，粘贴梗概或导入小说，选择预设（小成本验证或生产级）。
2. 点"生成全貌"，平台依次跑完文本阶段，每一步都过质量门（不通过就自动带错误重试）。
3. 在全貌视图里审阅大纲、角色、美术、剧本、站位、分镜，有问题就打回单项并附意见重跑，下游自动标为"需复核"。
4. 查看图片和视频阶段的费用估算（标注"仅供参考"），确认后开始付费生成。
5. 收取候选素材，逐镜头审阅，标记"合格"或"不合格"并选用。
6. 自动拼成剪辑，加字幕和声音，导出成片。
7. 发现 082 有问题时：提交意见 → 选修订方案 → 只重新生成 082 → 选用新版 → 剪辑自动更新，旧版本保留以便对比。

---

## Technical Approach

**Feasibility**: 中高（MEDIUM-HIGH）

**Architecture Notes**
- **技术栈：TypeScript + Node 后端，本地 Web 界面，后续可以用 Tauri 或 Electron 打包成桌面应用。**理由是现有 skill 脚本是零依赖的 Node `.mjs`，可以直接 import，少一层适配；非 Node 的 skill 通过命令行子进程接入。
- **存储：SQLite（已决定）。**素材文件存在项目目录下，数据库记录路径和内容哈希。
- **一个 skill 包 = `SKILL.md`（给模型的提示词）+ 可选的确定性脚本（seed / validate / render / export）+ 输入输出 schema + 版本号。**平台负责执行和保存状态，skill 提供创作方法，模型提供生成能力。
- **模型适配层：按能力分类（文本 / 图片 / 视频 / 语音），每个适配器声明能力**（支持的输入、时长、画幅、参考方式、是否带音频）。切换模型时对比能力差异；需要改变创作意图时，把差异展示给用户。
- **预设 = 一份"节点 → 模型"的映射配置，可以按节点覆盖。**费用估算器读取价格数据（优先从供应商接口拉取，拉不到就用内置的带日期价格表），结合节点的预估用量（token 数、图片张数、视频秒数）算出区间。
- **生成任务是持久化状态机**：已提交（保存供应商任务 ID）→ 轮询中 → 成功 / 失败 / 被拒，与"素材合格"和"被选用"分开存储。
- **版本模型**：资产和素材只追加、不覆盖；引用指向具体版本；上游出了新版本，只给下游打上"需复核"标记，不会静默传播。
- **凭据**只保存在本地（不进 SQLite 的可导出部分），分享或导出项目时排除凭据和私有素材。
- **复用现有资产**：novel-outline / novel-characters / character-refs / novel-art / novel-script / novel-staging / novel-storyboard 的 JSON 结构作为项目对象的初版数据结构；`character-refs` 的出图适配器（Qwen/ComfyUI、GPT Image、自定义命令）和"过期传导"逻辑可以作为参考。
- **ComfyUI 是 GPL-3.0**，平台只通过它的 HTTP API 调用，不复制它的代码。

**Technical Risks**

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| 一键全流程意外烧钱 | H | 付费阶段默认设硬性确认点，确认前先展示估算；文本阶段可以设置 token 上限 |
| 模型输出不符合 schema 或质量门 | H | validate 不通过就带具体错误重试，设上限 N 次，之后转人工；记录每次尝试 |
| 供应商不提供价格接口，或价格变动 | H | 内置带更新日期的价格表兜底，界面统一标注"仅供参考"，生成后记录实际费用作为校准 |
| 各家异步任务、审核拒绝、失败语义不一致 | M | 统一的任务状态机和适配器契约；把"被审核拒绝"建模为独立状态并记录原因 |
| 断线或重启后重复付费 | M | 先写库再请求（提交前持久化意图，拿到任务 ID 立即落库）；恢复时只做查询 |
| 现有 skill 之间有断点（staging → storyboard） | M | 在平台的节点衔接层补上自动映射 |
| 视觉连续性问题难以自动发现 | H | 第一版以人工审阅为准，自动检测只作辅助（Could） |
| 模型能力矩阵维护成本高 | M | 能力由适配器声明，随适配器版本走；第一版只接一条链路 |

---

## Implementation Phases

<!--
  STATUS: pending | in-progress | complete
  PARALLEL: phases that can run concurrently (e.g., "with 3" or "-")
  DEPENDS: phases that must complete first (e.g., "1, 2" or "-")
  PRP: link to generated plan file once created
-->

| # | Phase | Description | Status | Parallel | Depends | PRP Plan |
|---|-------|-------------|--------|----------|---------|----------|
| 1 | 项目数据层 | SQLite schema：项目/剧集/场景/角色/资产版本/镜头/任务/候选/审阅/剪辑，稳定 ID、引用、只追加的版本 | complete | - | - | [plan](../plans/completed/project-data-layer.plan.md) · [report](../reports/project-data-layer-report.md) |
| 2 | 节点协议与 skill 挂载 | skill 包规范与注册；seed → LLM → validate → 重试的执行器；接入 novel-* 链 | complete | with 3 | 1 | [plan](../plans/completed/node-protocol-skill-mount.plan.md) · [report](../reports/node-protocol-skill-mount-report.md) |
| 3 | 模型适配、预设与费用估算 | 文本/图片/视频适配器接口与能力声明；两套预设；价格拉取与兜底；估算器 | complete | with 2 | 1 | [plan](../plans/completed/model-adapters-presets-cost.plan.md) · [report](../reports/model-adapters-presets-cost-report.md) |
| 4 | 一键编排与全貌视图 | 文本阶段自动编排、付费确认点、全貌界面、单项打回重跑与"需复核"标记 | in-progress | - | 2, 3 | [4a 编排](../plans/completed/orchestration-rerun.plan.md)（complete，[报告](../reports/orchestration-rerun-report.md)） · [4b 界面](../plans/overview-web-ui.plan.md) |
| 5 | 图片/视频生成与可靠任务 | 一条图片和视频链路；任务状态机、断线续查、去重防重复付费、实际参数与成本记录 | pending | - | 3, 4 | [plan](../plans/image-video-generation.plan.md) |
| 6 | 审阅、三态与局部重做 | 镜头审阅、合格/选用标记、修订路径、影响追踪、版本对比 | pending | with 7 | 5 | [plan](../plans/review-tristate-redo.plan.md) |
| 7 | 基础剪辑与导出 | 镜序、入出点、字幕、声音轨；引用素材的具体版本；ffmpeg 导出成片 | pending | with 6 | 5 | [plan](../plans/edit-export.plan.md) |
| 8 | 端到端验收 | 梗概 → 30–60 秒成片；082 局部返工案例；度量基线采集 | pending | - | 6, 7 | [plan](../plans/e2e-acceptance.plan.md) |

### Phase Details

**Phase 1: 项目数据层**
- **Goal**: 让所有对象都能被稳定引用和版本化，为局部返工打好基础。
- **Scope**: SQLite schema 与迁移；仓储接口；从现有 skill JSON（outline/script/art/staging/storyboard）导入的映射；素材文件和哈希的管理。
- **Success signal**: 能完整导入一套现有的 novel-* 产物，并通过 ID 查询任意镜头的上游角色、场景和资产版本。

**Phase 2: 节点协议与 skill 挂载**
- **Goal**: 把 skill 变成有明确输入、输出、校验和版本的可执行节点。
- **Scope**: skill 包清单格式；执行器（seed、提示词装配、调用文本模型、validate、带错误重试、人工接管）；把 7 个 novel-* skill 注册成第一套包；每个阶段选一套。
- **Success signal**: 用平台执行器（而不是对话）从梗概跑出通过全部质量门的 outline.json 和 script.json。

**Phase 3: 模型适配、预设与费用估算**
- **Goal**: 每个节点的模型可以自由配置，并在生成前知道大概要花多少钱。
- **Scope**: 适配器接口和能力声明；至少一个文本供应商（如 DeepSeek）；"小成本验证"和"生产级"两套预设，可以按节点覆盖；价格拉取、带日期的兜底价格表、"仅供参考"提示；本地凭据管理。
- **Success signal**: 切换预设不用改代码；对同一个项目能给出两套预设的费用估算区间。

**Phase 4: 一键编排与全貌视图**
- **Goal**: 验证核心假设——输入后直接得到全貌。
- **Scope**: 按阶段依赖自动编排文本阶段；付费确认点；全貌界面（各阶段产物、质量门结果、状态）；单项打回附意见重跑；下游自动标记"需复核"；补上 staging → storyboard 的衔接。
- **Success signal**: 从梗概一键到分镜全貌，过程中不需要对话推进（这就是全貌 MVP）。

**Phase 5: 图片/视频生成与可靠任务**
- **Goal**: 付费生成可靠、不重复付费、可追溯。
- **Scope**: 一家图片供应商（角色参考图和关键帧）、一家视频供应商；任务状态机；先写库再请求；断线续查；区分"重新查询"和"重新生成"；记录计划输入和实际输入、失败或被拒原因、实际费用。
- **Success signal**: 生成过程中强制中断再重启，任务能恢复，没有重复提交。

**Phase 6: 审阅、三态与局部重做**
- **Goal**: 不合格的素材不再流入剪辑，返工只动必要的部分。
- **Scope**: 镜头级审阅（能做到时间点级更好）；执行成功、素材合格、被选用三态；修订路径；只重新生成指定镜头；版本对比；上游变更后的影响列表。
- **Success signal**: 把 082 标为不合格并重新生成，其他镜头的任务数不变，旧版本仍可查看。

**Phase 7: 基础剪辑与导出**
- **Goal**: 拿到可审阅的成片，并且成片随素材选用自动更新。
- **Scope**: 剪辑数据模型（镜序、入出点、字幕、声音轨，引用素材版本）；ffmpeg 渲染；交付核验（时长、规格、哈希）。
- **Success signal**: 改选 082 的版本后，重新导出的成片自动使用新版。

**Phase 8: 端到端验收**
- **Goal**: 验证第一版的关键案例，并采集度量基线。
- **Scope**: 从一个梗概完整做出一集 30–60 秒；执行 082 返工案例；记录人工投入时长、估算和实际费用的偏差。
- **Success signal**: Success Metrics 表中的前 5 项全部达标，后 2 项得到基线数据。

### Parallelism Notes

Phase 2（节点协议）和 Phase 3（模型适配与预设）都只依赖数据层，彼此独立，可以并行：前者关心"做什么、怎么校验"，后者关心"用谁来做、花多少钱"。Phase 6（审阅与重做）和 Phase 7（剪辑）都依赖 Phase 5 产出的真实素材，但互不依赖，可以并行，最后在 Phase 8 汇合，用 082 案例联调。

---

## Decisions Log

| Decision | Choice | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| 首要用户 | 具备自部署能力的开发者型作者（作者本人） | 非技术创作者；制作公司 | 先验证核心价值，UX 以后再迭代 |
| 产品形态 | 本地 Web，后续打包成桌面应用 | SaaS；纯 CLI | 本地优先，凭据和素材都留在本机 |
| 存储 | SQLite | JSON 文件夹（便于 git 管理） | 用户决定；关系查询和影响追踪更方便 |
| 同一阶段多套 skill | 选一套 | 并行跑多套再择优 | 控制成本和复杂度 |
| 价格来源 | 尽量从供应商接口拉取，标注"仅供参考" | 只用手工维护的价格表 | 用户决定；拉不到时用带日期的价格表兜底（待确认） |
| 预设 | "小成本验证"和"生产级"两套，可以按节点覆盖 | 只做逐节点配置 | 用户明确要求，降低配置门槛 |
| 付费确认 | 图片和视频阶段之前设硬性确认点 | 全自动跑完 | 一键全流程的烧钱风险高 |
| 技术栈 | TypeScript + Node（建议） | Python | 直接复用零依赖的 Node skill 脚本 |
| 节点编辑器 | 推迟到 v1 之后 | v1 就做 | 先稳定数据模型和节点协议 |
| 许可证 | Apache-2.0（建议，待确认） | MIT | 商业友好，并带专利授权条款 |

---

## Research Summary

**Market Context**
- **开源同类项目**：[Huobao Drama](https://www.sourcepulse.org/projects/22474259)（MIT 许可，Go + Vue，约 6k star，活跃度显示为不活跃）、[LocalMiniDrama](https://www.sourcepulse.org/projects/28710401)、[AI Shotlive](https://www.sourcepulse.org/projects/33658866)（首尾帧约束）、[LingGuo-Drama](https://www.sourcepulse.org/projects/27142148)（LoRA/ControlNet）、[FastMovieAI](https://gitee.com/tanbing/FastMovieAI)、[ArcReel](https://themenonlab.blog/blog/arcreel-story-to-video-multi-agent-pipeline)（多 agent 分阶段，后续镜头引用前面的设计）、[VideoMemory](https://github.com/EnVision-Research/VideoMemory)（视觉记忆库）。共同点是一键流水线、用户自己填 API key、模型大多写死；没有找到把"素材合格 / 选用"和影响追踪当作核心功能的项目。
- **国内商用平台**：有戏AI、造剧、灵绘AI、TagoMovie、SkyProduction 等（[汇总](https://ai-bot.cn/ai-comic-drama-creation-tools/)），都主打小说导入、资产库、角色一致性、智能分镜，宣传数字多为厂商自述，并且闭源、不能配置。
- **国外工作台**：[LTX Studio](https://ltx.studio/ltx-studio-alternatives) 的"分镜 + 生成 + 时间线"最完整，支持多个模型，但闭源，工作流不能编辑；Runway 擅长单个片段的质量；Higgsfield 擅长角色身份（[对比](https://longstories.ai/blog/higgsfield-alternatives)，多为厂商视角）。
- **差异化**：开源自部署 + 节点级模型和 skill 可配置 + 全貌优先 + 审阅三态与局部返工。

**Technical Context**
- 本仓库目前只有 `docs/original_idea.md`，没有代码。原始文档提到的 EP001 成片、剪辑单、运行记录、生产脚本都不在本仓库，需要另行提供，作为对象建模的样本。
- `~/.claude/skills/` 下已有完整的文本到分镜 skill 链（novel-outline / novel-characters / character-refs / novel-art / novel-script / novel-staging / novel-storyboard），每个都是"SKILL.md 提示词 + 零依赖 Node 脚本（seed/validate/render/export）"，通过 C01/S01 这类 ID 对账，并带有确定性质量门（例如 novel-storyboard 有 18 道）。
- `character-refs` 已经实现多个出图后端（Qwen/ComfyUI、GPT Image、自定义命令）和"重出后标出哪些图过期"；`novel-storyboard` 能导出 MiniMax H3 和 Seedance 的视频提示词。
- 已知断点：`novel-storyboard` 不读 `staging.json`；视频生成、任务记录和剪辑不在现有 skill 链中。
- 参考：ComfyUI 的[子图](https://docs.comfy.org/interface/features/subgraph)和[局部执行](https://docs.comfy.org/interface/features/partial-execution)，作为后续节点编辑器的设计参照。

---

*Generated: 2026-10-26 16:55*
*Status: DRAFT - needs validation*
*Note: 第六组问题的 1（MVP 定义）、2（v1 必备功能与节点编辑器延后）、4（不做清单）用户没有明确回复，按草拟方案写入，待确认。*

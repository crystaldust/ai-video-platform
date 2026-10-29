# Implementation Report: 全貌视图 Web 界面（PRD Phase 4b）

## Summary

平台的第一个界面，后端和前端都在这次做完。

**后端**：零运行时依赖的 `node:http` 本地服务（`src/server/`），提供 JSON API 和 SSE 进度推送。
- 只监听 127.0.0.1，校验 Host；变更类请求要令牌并校验同源；页面带 CSP。
- 一键跑、打回这类长任务在服务进程里后台执行。
- 所有数据都来自 Phase 2–4a 的仓储与编排函数，界面不另写业务逻辑。

**前端**：`web/` 下的 Vite + React 应用，按设计稿 `designs/ai-short-video-platform.pen` 实现 9 个页面：项目列表、新建项目、全貌、运行中、付费确认、单集详情、角色与美术、Skill 包、模型与预设。

**命令行**：新增 `serve` 命令。从新建项目、一键跑，到打回、复核、付费确认，全部在页面里完成，不需要对话推进。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | XL | XL |
| Files Changed | ~45 | 新建：后端 20 个、前端 32 个（另有 1 个依赖锁文件）、测试与支撑 2 个、文档 1 个；修改 13 个 |
| 测试 | API、安全、E2E | 新增 16 个服务端测试（本阶段后端测试共 211 个）、2 个 E2E；真实模型在页面上跑通一次 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 服务骨架与安全 | [done] Complete | Host 校验、令牌、同源、统一信封、错误分级、静态托管与令牌注入、安全头与 CSP |
| 2 | 只读 API | [done] Complete | 项目列表、全貌、单集、角色与美术、Skill 包、模型、付费确认单 |
| 3 | 变更 API 与 SSE | [done] Complete | go / reject（先同步校验再开后台任务）/ review / 付费确认 / 换预设与节点模型 / 换挂载 / 注册包 / 拉价格；事件总线；新增 `serve` 命令 |
| 4 | 前端工程与设计变量 | [done] Complete | 设计稿变量导出到 `web/design/tokens.json`，脚本生成 `tokens.css`；接口类型直接从服务端视图模块取 |
| 5–12 | 九个页面 | [done] Complete | 每页都用 Playwright 截图和设计稿对照；都有加载 / 空 / 错误三种状态 |
| 13 | E2E | [done] Complete | 新建 → 运行中 → 6 阶段通过 → 付费确认 → 打回第 1 集剧本 → 需复核 → 保持现状后消失；另一个用例逐页打开 |
| 14 | 文档 | [done] Complete | `docs/web-ui.md`：启动、安全模型、接口、开发、测试、还没做的 |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | [done] Pass | `pnpm typecheck`、`pnpm web:typecheck` 零错误（项目没有 lint） |
| Unit / Integration | [done] Pass | 211 个后端测试全部通过（服务端 13 个：安全、信封、各接口、SSE、后台任务、`serve` 命令、评审修复） |
| Coverage | [done] Pass | 行 98% 以上 / 分支 84% 以上 / 函数 95% 以上（门槛 80 / 70 / 80） |
| Build | [done] Pass | `pnpm web:build`：JS 约 117 KB gzip，在应用页 300 KB 预算内 |
| E2E | [done] Pass | `pnpm test:e2e`：2 个用例；带 CSP 跑，没有控制台错误 |
| Manual（真实模型） | [done] Pass | 见下 |

**真实模型验证。**
- 操作：`serve` 指向上游 skills，通过页面的接口新建《渡口》（小说正文，2 集 × 60 秒，竖屏），一键跑。
- 结果：六个阶段全部通过，每个阶段的质量门都是满分：大纲 15/15、美术 10/10、剧本 11/11、站位 9/9、分镜 18/18，角色卡 validate 通过。
- 用时、花费：用时 995 秒，文本花费 ¥2.93（$0.41）。
- 收尾：停在付费前，生成了付费确认单。
- 过程：分镜有一批撞上了输出上限，自动拆开后通过；运行中页面在这期间正常显示进度。

## Files Changed

| 区域 | 文件 |
|---|---|
| 服务 | `src/server/{server,app,http,jobs,events,route,routes}.ts`、`src/server/routes/{projects,views,actions}.ts`、`src/server/views/{common,checkup,overview,projects,episode,cast,skills,models,gates}.ts`、`src/cli-serve.ts` |
| 后端改动 | `src/cli.ts`（serve）、`src/estimate/{usage,estimate}.ts`（按集拆开）、`src/repo/paid-gates.ts`（`decidePaidGate`）、`src/repo/skills.ts`（`listPacks`）、`src/repo/inputs.ts`（画幅）、`src/executor/stage-recipes.ts`（分镜 seed 带画幅）、`src/orchestrate/revisions.ts`（`checkReject`）、`src/skills/script-runner.ts`（能力里加 checkup） |
| 前端 | `web/{package.json,tsconfig.json,vite.config.ts,index.html,playwright.config.ts}`、`web/src/{main.tsx,api.ts,types.ts,format.ts,global.css,tokens.css}`、`web/src/components/*`（Shell、ui、StagePipeline、EpisodeTable、DetailPanel、RunLog、PaidGateModal、样式）、`web/src/pages/*`（9 页对应 7 个页面组件 + 样式）、`web/design/tokens.json`、`web/scripts/{tokens-from-pen,screenshot}.mjs`、`web/e2e/{server.ts,main-flow.spec.ts}` |
| 测试 | `test/server.test.ts`、`test/support/server-harness.ts`、`test/orchestration-repo.test.ts`（+1）、`test/node-protocol.test.ts`（能力探测） |
| 其他 | `package.json`（web 脚本）、`.gitignore`、`docs/web-ui.md` |

## Deviations from Plan

1. **前端 tsconfig 放宽了两项严格选项。** `web/` 关掉了 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`。
   - 原因：CSS Modules 的类名类型在这两项下会变成可能 undefined，每处都要判空。后端保持原来的严格配置。
2. **接口类型不另写一份。** 前端直接从服务端视图模块 import 类型（只取类型，构建时擦除），所以前端类型检查会一并检查这些服务端文件。
3. **剧本单元格显示「场 · 句」，不显示秒数。**
   - 原因：剧本时长由 novel-script 内部按语速折算，命令行协议里没有输出这个数。平台也不另写一套折算，免得和 skill 口径不一致。
   - 单集详情的「时长」用分镜各切秒数之和。
4. **质量门计数来自 skill 自己的 `checkup`。**
   - 计数按产物版本缓存在内存里，临时文件写在项目的 `.cache/` 下。
   - novel-characters 没有 `checkup`，退回 validate（只有违规清单）。
   - 4b 之前注册的 skill 记录里没有 checkup 这项能力，现场探测一次。
5. **估算新增按集拆开的费用**（关键帧、视频）：付费确认单要能按集勾选。分镜还没有的集不在里面。
6. **项目输入新增可选画幅（9:16 / 16:9）**：新建页的设计稿有这一项，分镜 seed 用它（`--aspect`）。
7. **新建页多了项目名和题材两个必填项。** 设计稿没有，但项目目录需要名字，novel-outline 要求题材必填。
8. **「导入现有 JSON」页签只给命令行说明**，没有做上传。
9. **设计稿里有、这次没做的：**
   - 编排运行中的「暂停」（编排器不支持中途停，按钮灰显并提示可以关掉页面）。
   - 新建 / 另存预设、导出 H3 投产包。
   - 页面上编辑凭据（只读，凭据用 `cred set` 设置）。
   - Skill 的新版本提示。
   - 运行中的「预计还要多久」进度条。
10. **侧栏里 Phase 5–7 的页面灰显**：素材与候选、生成任务、剪辑。
11. **E2E 不用回放模型**：用按提示词作答的假模型（`web/e2e/server.ts`）。打回时它会按意见改内容，这样下游才会出现需复核。

## Issues Encountered

**测试挂住。** 测试里请求失败后没关服务，进程不退出。原因有两个：路径里有未编码的中文，`http.request` 同步抛错；SSE 订阅在任务开始之后才挂上，漏掉了早期事件。改成用 `t.after()` 收尾，并且先订阅、再开任务。

**代码审查。** 审查代理报了 1 个 HIGH、5 个 MEDIUM、7 个 LOW。

已修复（都补了回归测试）：

| 级别 | 问题 | 修法 |
|---|---|---|
| HIGH | 服务被 Ctrl+C 或崩溃后，库里残留 running 记录，页面一直停在「运行中」，重跑和付费确认都点不了 | 打开项目、列出项目时，本进程没在跑这个项目的任务，就按进程号给残留的编排和运行收尾 |
| MEDIUM | 付费上限打错字（NaN）被当成「不设上限」 | 前后端都拒绝不是正数的上限；一项都没勾时确认按钮禁用 |
| MEDIUM | 右侧面板选中的项目用的是旧快照 | 改成在最新数据里重新取 |
| MEDIUM | 新建项目中途失败，留下半个同名项目 | 删掉这次建的目录 |
| MEDIUM | 注册 skill 包时解析错误会回显文件内容 | 不再回显 |

另外修了 5 条 LOW：坏的 URL 编码回 400；SSE 连接在挂上之前就断开时不再泄漏定时器，空的订阅集合会清掉；静态文件只有 `assets/` 下长缓存；`<a>` 里套 `<button>` 改掉了；`useApi` 换路径时先清掉旧数据。

记下、没有改：

- **MEDIUM，多用户机器上的风险**：令牌注入在页面里，能访问本机 127.0.0.1 的其他用户也能读到，拿到令牌就能注册 skill 包、执行其中的脚本。本工具按个人电脑设计，已写进 `docs/web-ui.md`。
- **LOW，读页面会跑 skill 脚本**：全貌页的 GET 会跑 skill 的 checkup，有缓存，不影响正确性。

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `test/server.test.ts` | 13 | 安全（Host、令牌、同源、错误分级、静态托管与安全头）、项目列表（含库版本比程序新）、全貌（质量门、分集表、按集估算、改剧本后待处理与矩阵一致）、各页接口、新建并开跑（SSE 事件、409）、打回 / 复核 / 付费确认 / 换预设与模型 / 换挂载、中断收尾、上限校验、新建失败收尾、`serve` 命令 |
| `test/orchestration-repo.test.ts` | +1 | 付费确认单的确认与取消 |
| `web/e2e/main-flow.spec.ts` | 2 | 主流程与各页可打开 |

## Next Steps

- [ ] 提交并开 PR（`/prp-pr`）
- [ ] Phase 5：付费生成（读已确认的付费确认单的勾选与上限）

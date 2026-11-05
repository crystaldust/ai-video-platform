# Web 界面

本地 Web 应用：项目列表、新建项目、全貌（含运行中）、付费确认、单集详情、角色与美术、Skill 包、模型与预设。界面不另写业务逻辑，所有数据和操作都来自 Phase 2–4a 的仓储与编排函数。

## 启动

```bash
pnpm web:install                 # 第一次：装前端依赖（只在 web/ 里）
pnpm web:build                   # 构建前端到 web/dist/
node src/cli.ts serve --skills ~/Development/ai-video/shuohao-skills/skills
```

- `--root`：项目根目录，默认 `~/ShortDrama`。下面每个含 `project.sqlite` 的子目录就是一个项目；命令行 `init` 建的项目放进来也能看到。
- `--skills`：新建项目时注册的 skill 根目录（`packs/novel.pack.json` 里的 skill 从这里找）。不给就不能在页面上新建项目，已有项目照常打开。也可用环境变量 `AVP_SKILLS_ROOT`。
- `--port`：默认 5170；`--open no` 不自动打开浏览器。
- 模型按项目的预设 / 节点覆盖解析（见 [models-and-pricing.md](models-and-pricing.md)），凭据从本机配置目录读。

## 安全模型

本机单用户。服务：

- **只监听 127.0.0.1**；
- **校验 Host**：只接受 `127.0.0.1:<端口>` 和 `localhost:<端口>`，其余回 421（防 DNS rebinding）；
- **变更请求要令牌**：所有非 GET 请求必须带启动时随机生成的令牌（请求头 `x-avp-token`）；令牌由服务注入到 `index.html` 的 `<meta name="avp-token">`，只有同源页面读得到。带了 `Origin` 的还要同源；
- **不开 CORS**，所有响应带 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`，页面带 CSP（脚本、视频只许同源；图片只许同源和 data:）；
- **素材文件**：`/api/p/:id/media/:mid` 只按库里登记过的素材 id 取文件，不接受路径参数；库里的路径再校验一次在项目的 `media/` 下，不在就 404（不说原因）；GET 不要令牌（`<img>` 带不了请求头），Host 校验照常；
- 错误分级：参数、状态这类业务错误回中文提示（导入错误带逐条问题）；意外错误只回「服务器内部错误」，详情写服务端日志；
- 凭据永不经过接口：模型页只显示「是否配置」与末 4 位。

## 接口

统一响应：`{ ok: true, data }` 或 `{ ok: false, error: { message, problems? } }`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/config` | 项目根目录、能否新建、预设、skill 包摘要 |
| GET / POST | `/api/projects` | 项目列表 / 新建（`start: true` 建好就开跑） |
| GET | `/api/p/:id/head` | 侧栏用的项目头 |
| GET | `/api/p/:id/overview` | 全貌：阶段卡（质量门来自 skill 的 `checkup`）、运行摘要、估算（含按集拆开）、分集表、待处理项、运行记录（项目的全部运行，按时间先后；重跑和打回都追加在后面，最多最近 200 次） |
| GET | `/api/p/:id/events` | SSE：任务开始 / 结束、阶段、运行与每次尝试 |
| GET | `/api/p/:id/episodes/:ep` | 单集详情（集 id 或集号） |
| GET | `/api/p/:id/cast`、`/skills`、`/models`、`/gates/:gid` | 各页数据（`/gates/:gid` 带 `skipByNode`：会跳过的已生成项，按节点、按集） |
| GET | `/api/p/:id/tasks[?gate=<id>]` | 生成任务页：已确认的确认单摘要，选中那张的任务（角色 × 5 视图、关键帧、视频按集；没建任务的视图带沿用的那张 `reuseOf`） |
| GET | `/api/p/:id/tasks/:tid` | 任务详情：提示词、参考图、状态经过 |
| GET | `/api/p/:id/media/:mid` | 素材文件（图片、视频），支持单段 Range，长缓存 |
| POST | `/api/p/:id/go` | 开编排（`mode: all / only-stale`，或 `only: <阶段>`），后台运行；全貌阶段卡上的「重跑」就是 `only`（从头重写这一阶段，先确认、写明估算） |
| POST | `/api/p/:id/reject` | 打回（`stage`、`note`，加 `episode` 单集或 `episodes` 多集），先同步校验再开后台任务；多集在一个任务里依次跑，一集失败不影响别的，`job-end.result.episodes` 带逐集结果 |
| POST | `/api/p/:id/refs` | 只补出图提示词：拿现有角色卡跑 character-refs，只写 `characterRefs`，不重写角色卡；补完把因此新冒出来的需复核确认掉（外形没变） |
| POST | `/api/p/:id/review` | 复核确认（保持现状） |
| POST | `/api/p/:id/gates/:gid` | 确认（勾选节点 × 集、单次上限）并在后台开跑付费生成，或取消付费确认单；返回 `{ gate, started, reason? }` |
| POST | `/api/p/:id/generate` | `{action:'continue', gateId}` 继续生成，`{action:'stop'}` 停止（只在两次提交之间停） |
| POST | `/api/p/:id/tasks/:tid/requery` | 重新查询（不花钱）：只对提交过还没结束、结果未知、没下载下来的任务 |
| POST | `/api/p/:id/models`、`/mount`、`/packs` | 换预设与节点模型、换挂载、注册 skill 包 |
| POST | `/api/prices/refresh` | 从 OpenRouter 拉文本价格到缓存 |

跑模型的操作（go、reject、付费生成、启动恢复）在服务进程里后台执行，同一项目同时只跑一个任务（另有库里的编排锁）。页面收到 SSE 事件就重新拉全貌；数据都在库里，关掉页面、断线重连都不丢状态。

## 开发

```bash
node src/cli.ts serve --open no --skills <skills 根目录>   # 先起后端（5170）
pnpm web:dev                                              # Vite 开发服务，/api 代理到 5170
```

- 前端在 `web/`（Vite + React + react-router + lucide-react），依赖只在 `web/` 里；后端零运行时依赖。
- 接口类型直接从服务端视图模块 import（只取类型），前后端对不上时 `pnpm web:typecheck` 报错。
- 设计变量：`web/design/tokens.json` 是从设计稿（`designs/ai-short-video-platform.pen`）导出的变量，`pnpm --dir web tokens` 生成 `web/src/tokens.css`。改了设计稿的颜色或字体就重新导出再生成。
- 截图对照：`node web/scripts/screenshot.mjs <输出目录> <地址>...`（1440×1024，和设计稿画板同尺寸）。

## 测试

```bash
pnpm test                          # 含 test/server.test.ts：安全检查、各接口、SSE、后台任务
pnpm web:build && pnpm test:e2e    # Playwright：假模型跑主流程（新建 → 一键跑 → 付费确认并生成 → 生成任务页看图、详情、全屏预览 → 打回单集 → 复核）
```

E2E 用 `web/e2e/server.ts` 起服务：真实的服务与前端，模型换成按提示词作答、吐渡口样例的假模型，付费生成换成假的图片 / 视频供应商，不出网、不花钱。服务端测试（`test/support/server-harness.ts`）默认也注入假的付费生成，确认后自动开跑碰不到真供应商。

## 还没做

- 素材与候选、审阅三态、重新生成（Phase 6），剪辑（Phase 7）：侧栏里灰显。生成任务页只有不花钱的「重新查询」。
- 页面上不能改确认单的上限或勾选：要改就开新确认单（已出过的会跳过）。
- 编排运行中不能暂停（可以关页面，重开后从断点继续）。
- 凭据在命令行设置（`cred set`），页面只读。
- 新建 / 另存预设、导出 H3 投产包、Skill 有新版本的提示。

## 多用户机器上的注意

令牌注入在页面里，能访问本机 127.0.0.1 的任何进程都能读到它；拿到令牌就能注册 skill 包、跑其中的脚本（相当于以服务进程的用户执行代码）。本工具按「个人电脑、单用户」设计：在多人共用的机器上不要开着 `serve`，或者只在需要时启动。

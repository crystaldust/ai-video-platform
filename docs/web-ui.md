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
- **不开 CORS**，所有响应带 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`，页面带 CSP（脚本只许同源）；
- 错误分级：参数、状态这类业务错误回中文提示（导入错误带逐条问题）；意外错误只回「服务器内部错误」，详情写服务端日志；
- 凭据永不经过接口：模型页只显示「是否配置」与末 4 位。

## 接口

统一响应：`{ ok: true, data }` 或 `{ ok: false, error: { message, problems? } }`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/config` | 项目根目录、能否新建、预设、skill 包摘要 |
| GET / POST | `/api/projects` | 项目列表 / 新建（`start: true` 建好就开跑） |
| GET | `/api/p/:id/head` | 侧栏用的项目头 |
| GET | `/api/p/:id/overview` | 全貌：阶段卡（质量门来自 skill 的 `checkup`）、运行摘要、估算（含按集拆开）、分集表、待处理项、最近一次编排的运行记录 |
| GET | `/api/p/:id/events` | SSE：任务开始 / 结束、阶段、运行与每次尝试 |
| GET | `/api/p/:id/episodes/:ep` | 单集详情（集 id 或集号） |
| GET | `/api/p/:id/cast`、`/skills`、`/models`、`/gates/:gid` | 各页数据 |
| POST | `/api/p/:id/go` | 开编排（`mode: all / only-stale`，或 `only: <阶段>`），后台运行 |
| POST | `/api/p/:id/reject` | 打回（`stage`、`episode?`、`note`），先同步校验再开后台任务 |
| POST | `/api/p/:id/review` | 复核确认（保持现状） |
| POST | `/api/p/:id/gates/:gid` | 确认（勾选节点 × 集、单次上限）或取消付费确认单 |
| POST | `/api/p/:id/models`、`/mount`、`/packs` | 换预设与节点模型、换挂载、注册 skill 包 |
| POST | `/api/prices/refresh` | 从 OpenRouter 拉文本价格到缓存 |

跑模型的操作（go、reject）在服务进程里后台执行，同一项目同时只跑一个任务（另有库里的编排锁）。页面收到 SSE 事件就重新拉全貌；数据都在库里，关掉页面、断线重连都不丢状态。

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
pnpm web:build && pnpm test:e2e    # Playwright：假模型跑主流程（新建 → 一键跑 → 付费确认 → 打回单集 → 复核）
```

E2E 用 `web/e2e/server.ts` 起服务：真实的服务与前端，模型换成按提示词作答、吐渡口样例的假模型，不出网、不花钱。

## 还没做

- 素材与候选、生成任务、剪辑（Phase 5–7）：侧栏里灰显。
- 付费确认只记下勾选与上限，实际生成在 Phase 5。
- 编排运行中不能暂停（可以关页面，重开后从断点继续）。
- 凭据在命令行设置（`cred set`），页面只读。
- 新建 / 另存预设、导出 H3 投产包、Skill 有新版本的提示。

## 多用户机器上的注意

令牌注入在页面里，能访问本机 127.0.0.1 的任何进程都能读到它；拿到令牌就能注册 skill 包、跑其中的脚本（相当于以服务进程的用户执行代码）。本工具按「个人电脑、单用户」设计：在多人共用的机器上不要开着 `serve`，或者只在需要时启动。

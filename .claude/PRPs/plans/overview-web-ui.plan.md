# Plan: 全貌视图 Web 界面（PRD Phase 4b）

## Summary
平台的第一个界面：本地 Web 应用，按 `designs/ai-short-video-platform.pen` 的 9 张设计稿实现项目列表、新建项目、全貌（含运行中状态）、付费确认、单集详情、角色与美术、Skill 包、模型与预设。后端是零运行时依赖的 `node:http` 服务（JSON API + SSE 推进度），只监听 127.0.0.1 并校验来源与令牌；前端是 Vite + React + TypeScript。所有数据来自 Phase 2–4a 的仓储与编排函数，界面不另写业务逻辑。

## User Story
作为作者，我希望在浏览器里看到整部作品的全貌——每个阶段、每一集的状态和质量门、哪里需要我处理——并在同一个页面里打回、重跑、确认付费，从而完全不需要在对话或命令行里推进。

## Problem → Solution
只有 CLI，全貌要靠拼命令输出 → 一个本地页面直接呈现全貌，操作就地完成。

## Metadata
- **Complexity**: XL
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`
- **PRD Phase**: Phase 4 一键编排与全貌视图（4b：界面）
- **Depends**: Phase 4a（编排、矩阵、打回、付费确认单）、Phase 3（预设、估算）、Phase 2（包、挂载、run）
- **Estimated Files**: ~45（前端组件居多）

---

## UX Design
以设计稿为准（Pencil 文件 `designs/ai-short-video-platform.pen`，画板名如下）。实现时用 Pencil MCP 的 `get_screenshot` / `get_variables` 对照。

| 画板 | 路由 | 数据来源 |
|---|---|---|
| 项目列表 · Web 1440 | `/` | 扫描配置的项目根目录（`~/ShortDrama` 默认，可配）下含 project.sqlite 的目录 |
| 新建项目 · Web 1440 | `/new` | `createProject` + `addInput` + `usePreset` + 默认挂载 novel 包 → 跳转全貌并触发 `go` |
| 全貌视图 · Web 1440 | `/p/:id` | `reviewMatrix`、最新 orchestration、各阶段最新 run、`estimateProject` |
| 运行中 · Web 1440 | `/p/:id`（orchestration running 时） | SSE `/api/p/:id/events`：run 进度、attempt 结果 |
| 付费确认 · Web 1440 | `/p/:id` 上的弹窗 | `paid_gate.estimate`；确认写 `selection` 与 `budget_cap`，状态 → confirmed（实际生成 Phase 5） |
| 单集详情 · Web 1440 | `/p/:id/ep/:epId` | 剧本 / 站位 / 分镜各侧面当前版本、`staging-carry` 结果、段内切 |
| 角色与美术 · Web 1440 | `/p/:id/cast` | cast / art / outline 侧面；参考图位为「待生成」 |
| Skill 包 · Web 1440 | `/p/:id/skills` | skill_pack、skill.capabilities、stage_mount |
| 模型与预设 · Web 1440 | `/p/:id/models` | 预设、节点覆盖、估算对比、凭据状态（只显示是否配置与末 4 位） |

**设计稿数字要按 Phase 3 的真实价格表重算**（视频按秒计费，设计稿示例偏低；模型名 `deepseek-chat` 改为注册表中的名称）——实现时以接口数据为准，不照抄设计稿文字。

### Interaction Changes
| Touchpoint | Before | After |
|---|---|---|
| 开始项目 | `init` + `input` + `pack register` + `go` | 新建项目页一键 |
| 看全貌 | `matrix` / `runs` 命令 | 全貌页 |
| 打回 | `reject` 命令 | 详情面板「附意见打回」，可选阶段 |
| 复核 | `review --keep` | 「保持现状，标记已复核」 |
| 付费确认 | `gates` 命令 | 弹窗按阶段 × 集勾选，设单次上限 |

所有界面状态都要覆盖：加载中、空、错误、成功反馈（web-app 设计规范第 6 条）。

---

## Mandatory Reading

| Priority | File | Why |
|---|---|---|
| P0 | `designs/ai-short-video-platform.pen`（经 Pencil MCP） | 9 张画板、设计变量（颜色、字体） |
| P0 | `.claude/PRPs/plans/orchestration-rerun.plan.md` | 全部后端数据与操作 |
| P0 | `src/cli.ts` | 现有命令与库函数的映射——API 层照搬同样的调用 |
| P1 | `.claude/PRPs/plans/model-adapters-presets-cost.plan.md` | 估算结果结构、凭据只读接口 |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| Vite + React + TS | vite.dev / react.dev（实施当天确认版本） | 前端为独立 `web/` 包，`vite build` 产物由 Node 服务静态托管；开发时 Vite dev server 代理 `/api` |
| Server-Sent Events | MDN EventSource | 单向推送进度足够，不引入 WebSocket |
| 本地服务安全 | DNS rebinding / CSRF 常识 | 只绑 127.0.0.1；校验 `Host` 为 `127.0.0.1:<port>` 或 `localhost:<port>`；变更类请求要求启动时生成的随机令牌（放在页面注入的 meta 里，请求头带回）；不开 CORS |
| Playwright | playwright.dev | E2E 覆盖关键流程（ECC TypeScript 测试规范要求） |

---

## Patterns to Mirror
- 后端沿用 Phase 1–4a 的仓储函数，API 处理器只做「解析参数 → 调库函数 → 统一响应」。
- 统一响应信封（ECC patterns）：`{ ok: true, data } | { ok: false, error: { message, problems? } }`；`ImportError` 的 problems 原样带出。
- 前端：每个设计稿区域一个组件文件（200–400 行以内），颜色与字体只用 CSS 变量（来自 .pen 变量：`--bg`、`--surface`、`--border`、`--text-1/2/3`、`--accent(-soft)`、`--ok/warn/err/lock(-soft)`、`--font`、`--mono`）。

---

## 关键设计

### 1. 目录
```
src/server/
  server.ts          创建 http 服务、路由表、静态托管、安全检查
  routes/*.ts        projects / overview / episode / cast / skills / models / gates / actions
  sse.ts             事件总线（编排进度 → 订阅者）
web/
  package.json       react、react-dom、react-router（devDeps：vite、@vitejs/plugin-react、typescript、@playwright/test）
  src/tokens.css     从 .pen 变量生成（脚本 `web/scripts/tokens-from-pen.mjs` 读 Pencil 导出的变量 JSON）
  src/api.ts         fetch 封装（带令牌、统一信封解析）
  src/pages/*.tsx    9 个页面
  src/components/*   StagePipeline、EpisodeTable、ReviewPanel、PaidGateModal、RunLog、CutStrip、…
```
CLI 新增 `serve [--port 5170] [--root ~/ShortDrama]`：启动服务并打开浏览器；打印带令牌的地址。

### 2. API（摘要）
| Method | Path | 作用 |
|---|---|---|
| GET | `/api/projects` | 项目列表与三段进度 |
| POST | `/api/projects` | 新建（名称、梗概、参数、预设）→ 返回 id |
| GET | `/api/p/:id/overview` | 阶段卡片、运行摘要、分集矩阵、待处理项、估算摘要 |
| GET | `/api/p/:id/events` | SSE：run 开始 / attempt 结束 / run 结束 / orchestration 结束 |
| POST | `/api/p/:id/go` | 启动编排（`mode`） |
| POST | `/api/p/:id/reject` | 打回（stage、episode?、note） |
| POST | `/api/p/:id/review` | 复核确认 |
| GET/POST | `/api/p/:id/gates/:gid` | 读取 / 确认或取消付费确认单 |
| GET | `/api/p/:id/episodes/:ep` | 单集详情 |
| GET | `/api/p/:id/cast`、`/skills`、`/models` | 各页数据 |
| POST | `/api/p/:id/models`、`/mount` | 改预设、节点覆盖、换挂载 |
- 编排在服务进程内异步执行（不阻塞请求）；同项目并发由 4a 的锁保证。
- 打开项目用 `openProject`，按请求打开、用完关闭；SSE 订阅期间保持只读连接。

### 3. 页面要点（对照设计稿）
- 全貌：阶段流水线（6 文本 + 3 付费，付费加锁）；运行摘要（对话推进恒为 0 次、用时、文本实际花费、待处理数）；分集表（每格状态点 + 数字 + 原因小字）；右侧面板随选中项切换：需复核 → 原因、影响范围、三个操作；未通过 → 违规原文、尝试记录、人工接管指引。
- 运行中：同一页面，切换为运行记录 + 「正在进行」面板（当前 attempt、重试历史、排队阶段）。
- 付费确认：按 4a 的 `paid_gate.estimate` 渲染分组与勾选；未通过 / 需复核的集默认不勾；上限输入；确认后 gate → confirmed，并提示「生成将在付费生成模块执行」（Phase 5 接入前按钮文案如此）。
- 单集详情：场次与段树、切卡片（关键帧位显示「待生成」）、画面 / 台词时间轴（按切秒数与台词所在切推算）、H3 提示词预览、切详情（景别、运镜、画面、认领节拍、参考图位）。

---

## Files to Change
| File | Action |
|---|---|
| `src/server/**` | CREATE（约 12 个文件） |
| `src/cli.ts` | UPDATE（`serve`） |
| `web/**` | CREATE（约 30 个文件） |
| `package.json` | UPDATE（workspace 或脚本：`web:dev`、`web:build`、`test:e2e`） |
| `test/server.test.ts` | CREATE（API 与安全检查，`node:test` + 真实 http 请求） |
| `web/e2e/*.spec.ts` | CREATE（Playwright） |

## NOT Building
- 付费生成的执行、素材候选与审阅、剪辑页面（Phase 5–7）
- 桌面打包（Tauri / Electron）
- 多用户、登录
- 移动端适配（只保证 ≥1280 宽可用，窄屏不崩）

---

## Step-by-Step Tasks

### Task 1: 服务骨架与安全
- **ACTION**: `server.ts`：只绑 127.0.0.1；Host 校验；变更类请求校验令牌；统一信封；错误处理（ImportError → 400 带 problems，其余 500 只回通用消息并在服务端日志记录详情）。
- **VALIDATE**: `test/server.test.ts`：错误 Host 被拒（421/403）、无令牌的 POST 被拒、GET 正常。

### Task 2: 只读 API
- **ACTION**: projects、overview、episodes、cast、skills、models、gates 的 GET。
- **VALIDATE**: 用 duko 夹具导入的项目 + 预置 run 数据断言结构。

### Task 3: 变更 API 与 SSE
- **ACTION**: go、reject、review、gates 确认、models、mount；SSE 事件总线由编排器的 `onProgress` 驱动。
- **VALIDATE**: 回放模型下 `POST /go` 后订阅 SSE 能收到 run 开始 / 结束事件，最终 orchestration done。

### Task 4: 前端工程与设计变量
- **ACTION**: 建 `web/`；用 Pencil MCP `get_variables` 导出变量，生成 `tokens.css`；字体 Noto Sans SC / JetBrains Mono（Google Fonts 或本地）。
- **VALIDATE**: `vite build` 通过；`tsc --noEmit` 通过。

### Task 5–12: 九个页面
- 每页一个任务：项目列表 → 新建项目 → 全貌 → 运行中 → 付费确认 → 单集详情 → 角色与美术 → Skill 包 → 模型与预设。
- **MIRROR**: 设计稿对应画板；组件只用 tokens。
- **VALIDATE**: 每页完成后用 chrome-devtools MCP 或 Playwright 截图，与 Pencil `get_screenshot` 并排对比；加载 / 空 / 错误三态都有。

### Task 13: E2E
- **ACTION**: Playwright：新建项目（回放模型）→ 全貌出现 6 阶段通过 → 付费确认弹窗出现 → 打回剧本第 1 集 → 全貌出现需复核 → 保持现状后消失。
- **VALIDATE**: `pnpm test:e2e` 通过。

### Task 14: 文档
- **ACTION**: `docs/web-ui.md`：启动方式、端口与令牌、安全模型、开发模式。

---

## Testing Strategy
| Test | 期望 |
|---|---|
| Host 校验 | `Host: evil.example` → 拒绝 |
| 令牌 | 缺令牌 POST → 403；GET 不需要 |
| overview 结构 | 6 阶段卡、矩阵每格有状态、待处理数与矩阵一致 |
| SSE | 编排全过程事件顺序正确，断开重连能拿到当前状态 |
| E2E 主流程 | 见 Task 13 |

### Edge Cases Checklist
- [x] 项目根目录不存在 / 为空 → 空状态页
- [x] 库版本比程序新 → 列表里标「需要升级平台」，不打开
- [x] 编排运行中关闭页面再打开 → 直接进入运行中状态
- [x] 估算无价格的节点 → 显示「无价格」而不是 0

---

## Validation Commands
```bash
pnpm typecheck && pnpm --dir web exec tsc --noEmit
pnpm test
pnpm --dir web build
pnpm test:e2e
```

### Manual Validation（Phase 4 success signal）
- [ ] `cli serve` → 新建项目贴梗概 → 一键 → 全貌显示到分镜，停在付费前，**全程没有对话推进**
- [ ] 打回一集、复核、只重跑需复核项，全在页面完成
- [ ] 9 个页面与设计稿对照无明显偏差

---

## Acceptance Criteria
- [ ] 9 个页面实现并对照设计稿
- [ ] 全貌、打回、复核、付费确认在页面完成
- [ ] 本地服务安全检查（127.0.0.1、Host、令牌）有测试
- [ ] E2E 主流程通过；类型检查与构建通过

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 前端工作量大 | H | M | 页面按优先级做：全貌 → 新建 → 运行中 → 付费确认 → 单集详情，其余可延后 |
| 设计稿与真实数据形状不一致 | M | M | 以 API 为准，必要时回改设计稿并告知 |
| 引入前端依赖与平台「零依赖」风格冲突 | M | L | 运行时零依赖只约束后端；前端依赖仅在 `web/` 内，构建产物静态托管 |

## Notes
- 前端技术栈（React + Vite）是本计划的决定，实施前可再讨论；后端 API 与前端解耦，换框架不影响 API。

# AI 短剧制作平台

一个本地运行的开源 AI 短剧制作平台。输入梗概或小说正文，**一键跑完全部文本阶段**（大纲 → 角色 → 美术 → 剧本 → 站位 → 分镜），得到整部作品的工程全貌；到了付费的图片和视频阶段先停下，给出费用估算，等人确认后再生成。

它要解决的问题：AI 短剧作者现在要和 AI agent 一个阶段一个阶段地文字来回迭代，看不到整部作品的全貌；模型和 skill 绑死在对话里；返工时说不清会波及哪些镜头。这个平台把这些都变成可配置、可追溯的：

- **全貌视图**：每个阶段、每一集的状态和质量门一目了然，哪里需要处理直接标出来。
- **不靠对话推进**：skill 当成有明确输入、输出和校验的节点来执行，没过质量门就带着错误自动重试，仍不过才交给人。
- **单集打回与「需复核」**：对某个阶段或某一集附意见打回，只重跑它；上游改了，下游受影响的集自动标为需复核。
- **模型可配置**：每个节点单独选模型，内置「小成本验证」和「生产级」两套预设；生成前按节点给出费用区间。
- **可追溯**：所有对象（集、场次、段、切、角色、场景……）都有稳定 id 和版本，存在项目目录的 SQLite 里；每次模型调用的提示词、输出、违规、用量和费用都有记录。

文本阶段由 [shuohao-skills](https://github.com/crystaldust/shuohao-skills) 的 novel-* skill 链完成（需要 3.x，带稳定 id 的版本）。

## 现状

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 项目数据层：对象、版本、引用、追溯与过期 | 完成 |
| 2 | 节点协议：skill 包注册与挂载、执行器、质量门与重试 | 完成 |
| 3 | 模型适配、预设与费用估算 | 完成 |
| 4 | 一键编排、打回重跑、需复核，以及本地 Web 界面 | 完成 |
| 5 | 图片 / 视频生成与可靠任务 | 计划中 |
| 6–8 | 审阅与局部重做、剪辑与导出、端到端验收 | 计划中 |

现在能做到：从梗概一键跑到分镜，停在付费生成之前；在页面上审阅、打回、复核、确认付费勾选。图片和视频的实际生成在 Phase 5。

## 环境要求

- **Node.js 24 以上**（直接运行 TypeScript，并用到内置的 `node:sqlite`；开发时用的是 Node 25）
- **pnpm**
- **shuohao-skills 3.x** 的 skills 目录（novel-outline、novel-characters、novel-art、novel-script、novel-staging、novel-storyboard）
- 文本模型的 API key：默认预设用 DeepSeek

后端没有运行时依赖；前端依赖只在 `web/` 里。

## 安装

```bash
pnpm install          # 后端开发依赖（TypeScript 类型检查）
pnpm web:install      # 前端依赖
pnpm web:build        # 构建前端到 web/dist/
```

## 配置凭据

凭据只保存在本机配置目录（默认 `~/.config/ai-video-platform/`，文件权限 600），不会写进项目目录或项目库，也不会在页面和报错里回显。

```bash
node src/cli.ts cred set deepseek     # 从标准输入读 key，不要写在命令行参数里
node src/cli.ts cred list             # 只显示末 4 位
```

也可以用环境变量 `DEEPSEEK_API_KEY`，或者自己写 `~/.config/ai-video-platform/deepseek.key`（权限必须是 600）。其他供应商：`openai`、`dashscope`（图片）、`minimax`（视频）。

## 启动

### Web 界面

```bash
node src/cli.ts serve --skills <shuohao-skills>/skills
```

- 打开 `http://127.0.0.1:5170/`，在「新建项目」里贴梗概，点「一键跑完文本阶段」。
- 项目默认存在 `~/ShortDrama/<项目名>/`，用 `--root` 指定别的目录；`--port` 换端口；`--open no` 不自动打开浏览器。
- skills 目录也可以用环境变量 `AVP_SKILLS_ROOT` 给。不给就只能打开已有项目，不能在页面上新建。
- 服务只监听本机，变更请求要令牌。安全模型见 [docs/web-ui.md](docs/web-ui.md)。

### 命令行

页面上的操作都有对应命令，结果 JSON 写 stdout，进度写 stderr：

```bash
CLI="node src/cli.ts"
$CLI init ~/ShortDrama/渡口 --name 渡口
$CLI pack register ~/ShortDrama/渡口 packs/novel.pack.json --root <shuohao-skills>/skills
$CLI input ~/ShortDrama/渡口 渡口.txt --kind novel --episodes 6 --seconds 60 --genre 悬疑

$CLI estimate ~/ShortDrama/渡口 --preset all     # 两套预设的费用对比
$CLI go ~/ShortDrama/渡口                        # 一键跑完文本阶段，停在付费前
$CLI matrix ~/ShortDrama/渡口                    # 需复核矩阵
$CLI reject ~/ShortDrama/渡口 script --ep 3 --note "汽笛提前到陆行远掏砚之前"
$CLI go ~/ShortDrama/渡口 --only-stale           # 只重跑受影响的部分
$CLI review ~/ShortDrama/渡口 staging --ep 3 --keep   # 或者：看过了，保持现状
$CLI gates ~/ShortDrama/渡口                     # 付费确认单
```

`node src/cli.ts --help` 列出全部命令。

## 测试

```bash
pnpm typecheck        # 后端类型检查
pnpm test             # 后端全部测试（不出网、不花钱：模型是按提示词作答的假模型）
pnpm coverage         # 带覆盖率门槛：行 80 / 分支 70 / 函数 80

pnpm web:typecheck    # 前端类型检查（接口类型直接取自服务端，前后端对不上会报错）
pnpm web:build
pnpm test:e2e         # Playwright：用假模型在浏览器里走主流程
```

第一次跑 E2E 前装浏览器：`pnpm --dir web exec playwright install chromium`。

## 目录

```
src/
  domain/  db/  repo/        数据层：对象、版本、引用、迁移
  import/                    导入 skill 产物（投影成对象与引用）
  skills/  executor/         节点协议：注册、配方、执行器、质量门
  model/  presets/  pricing/  estimate/   模型适配、预设、价格、估算
  orchestrate/               编排、需复核矩阵、打回
  server/                    本地 Web 服务（API、SSE、后台任务）
  cli*.ts                    命令行
web/                         前端（Vite + React）
packs/                       skill 包清单（novel 链）
presets/  prices/            内置预设与价格表
test/                        测试与夹具（渡口样例、skill 副本）
designs/                     界面设计稿（Pencil）
docs/                        文档
```

## 文档

- [节点协议](docs/node-protocol.md)：skill 包、挂载、配方、执行器
- [模型、预设与费用](docs/models-and-pricing.md)
- [编排、打回与需复核](docs/orchestration.md)
- [Web 界面](docs/web-ui.md)：启动、安全模型、接口、开发

## 许可

Apache-2.0

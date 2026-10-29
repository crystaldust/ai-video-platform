# Plan: 模型适配、预设与费用估算（PRD Phase 3）

## Summary
建立按能力分类的模型适配层（文本 / 图片 / 视频，各自声明能力），实现第一个真实文本适配器（OpenAI 兼容协议，先接 DeepSeek）；用两套内置预设（「小成本验证」「生产级」）把每个节点映射到模型，项目里可以逐节点覆盖；价格按「用户覆盖 → 接口拉取的缓存 → 内置带日期价格表」取，费用估算器对每个节点和整个项目给出区间，并始终标注来源、日期和「仅供参考」。凭据只存本机配置目录，不进项目。

## User Story
作为要控制成本的作者，我希望每个节点的模型可以按预设一键切换、也能单独改，并在付费生成前看到两套预设各要花多少钱，从而先用便宜的组合把流程跑通，再决定生产时花多少。

## Problem → Solution
模型写死在对话里，费用事后才知道 → 节点 → 模型由预设和项目覆盖决定，切换不改代码；生成前就有按节点拆开的费用区间，生成后记录实际费用作为校准。

## Metadata
- **Complexity**: Large（约 20 个文件）
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`
- **PRD Phase**: Phase 3 模型适配、预设与费用估算
- **Depends**: Phase 1；**实施顺序上在 Phase 2 之后**（复用 Phase 2 的 `TextModel` 接口、`node_attempt` 表与执行器）
- **Estimated Files**: 新建 ~16，修改 ~5

---

## UX Design

### Before
```
$ cli run duko outline --model-cmd "claude -p"     # 模型靠命令行参数临时指定，不知道花了多少
```

### After
```
$ cli cred set deepseek            # 从 stdin 读 key，存 ~/.config/ai-video-platform/credentials.json（0600）
$ cli preset use duko budget       # 小成本验证
$ cli model set duko text:art deepseek:deepseek-v4-pro     # 只把美术换成推理模型
$ cli estimate duko --preset all
  节点            小成本验证            生产级
  文本 ×6         $a–b                 $c–d
  角色参考图 20 张 …                    …
  关键帧 79 张     …                    …
  视频 314 秒      $7.9（H3-Lite 480P）  $25.1（H3 768P）
  合计            …                    …          ≈ ¥…（1 USD = 7.1 CNY，可改）
  价格：deepseek 10-29 接口拉取；minimax 10-29 官方页面；仅供参考
$ cli run duko outline            # 不再需要 --model-cmd：用当前预设里 text:outline 节点的模型
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 选模型 | 命令行参数 | 预设 + 节点覆盖 | `--model-cmd` 仍可临时覆盖 |
| 费用 | 事后不知道 | 生成前估算区间，生成后记实际 | 文本节点本阶段就记实际费用 |
| 凭据 | 环境变量散落 | `cred set/list/rm`，env 优先 | 不进项目目录、不进 sqlite |
| 价格 | 无 | `prices show/refresh`，每条带来源与日期 | 拉不到用内置表兜底 |

设计稿「模型与预设」页（`designs/ai-short-video-platform.pen`）是本阶段数据的最终界面；本阶段只做 CLI 与数据，界面在 Phase 4。

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `.claude/PRPs/plans/node-protocol-skill-mount.plan.md` | 关键设计 4、5 | `TextModel` 接口、`node_attempt` 表、执行器入口 `runNode` |
| P0 | `src/model/text-model.ts`、`src/model/command-model.ts`（Phase 2 产出） | all | 新适配器实现同一接口 |
| P0 | `src/executor/run-node.ts`（Phase 2 产出） | all | 接入「按节点取模型」和费用记录 |
| P1 | `src/cli.ts` | all | 新命令沿用既有模式 |
| P1 | `src/db/migrations.ts` | all | 迁移追加 |
| P1 | `test/fixtures/duko/*` | — | 估算器用样例算用量 |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| DeepSeek API | https://api-docs.deepseek.com/ （查询于 2026-10-29） | OpenAI 兼容，base `https://api.deepseek.com`；当前模型名 `deepseek-flash`（由 DeepSeek-V4.1-Flash-1017 提供）与 `deepseek-v4-pro`；旧名 `deepseek-v4-flash` 仍可用但已退役、按 Flash 计价。**单价不在快速开始页**，实施时到 Models & Pricing 页核对 |
| MiniMax 视频定价 | https://platform.minimax.io/docs/guides/pricing-video.md （查询于 2026-10-29） | H3 按输出秒计费：H3 768P $0.08/s、2K $0.13/s；H3-Highspeed 768P $0.06/s；H3-Lite 768P $0.04/s、480P $0.025/s；每任务 5 张参考图免费，超出 $0.04/张；所有任务类型同价 |
| OpenRouter models API | https://openrouter.ai/api/v1/models | 公开、免 key；`pricing.prompt` / `pricing.completion` 是**字符串**，单位 USD/token（第三方资料，实施时以官方 API 参考为准） |

```
KEY_INSIGHT: 多数供应商没有价格查询接口；文本模型可从 OpenRouter 的公开模型列表拉，视频、图片只能用内置表
APPLIES_TO: 价格来源链与「仅供参考」标注
GOTCHA: OpenRouter 价格是它自己的转售价，可能与直连价不同——拉取结果只作「参考来源之一」，内置表里记直连官方价，二者都显示来源

KEY_INSIGHT: 视频按秒计费后，整部作品的视频费用远高于设计稿示例（314 秒 × $0.08 ≈ $25）
APPLIES_TO: 估算器与设计稿数字
GOTCHA: 设计稿里 ¥27–37 的视频示例偏低，Phase 4 做界面时按本阶段的真实表重算

KEY_INSIGHT: 模型名会改（deepseek-chat → deepseek-flash）
APPLIES_TO: 适配器与预设
GOTCHA: 预设里引用的模型 id 若在适配器注册表里找不到，`preset use` 时就报错，不要等到运行时
```

---

## Patterns to Mirror
沿用 `node-protocol-skill-mount.plan.md`「Patterns to Mirror」中的 NAMING_CONVENTION、ERROR_HANDLING、MIGRATION、CLI、TEST_STRUCTURE。本阶段新增：

### EXTERNAL_IO_INJECTION
所有网络与文件系统的外部依赖都通过参数注入，测试不出网：
```ts
export interface HttpDeps { readonly fetch: typeof fetch; readonly now: () => Date; readonly sleep: (ms: number) => Promise<void> }
export const defaultHttpDeps: HttpDeps = { fetch: globalThis.fetch, now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
```

### VALIDATE_EXTERNAL_JSON
预设、价格表、凭据文件、接口响应都是外部数据：逐字段校验，失败抛 Error 点名文件和字段（与 Phase 2 的清单校验同一风格）。

---

## 关键设计

### 1. 能力与适配器
```ts
// src/model/capabilities.ts
export type Capability = 'text' | 'image' | 'video';
export interface TextCaps  { readonly contextTokens: number; readonly maxOutputTokens: number; readonly json: boolean }
export interface ImageCaps { readonly sizes: readonly string[]; readonly maxRefImages: number; readonly transparentBg: boolean }
export interface VideoCaps {
  readonly resolutions: readonly string[]; readonly durations: readonly number[] | { readonly min: number; readonly max: number };
  readonly modes: readonly ('t2v' | 'i2v' | 'first-last' | 'reference')[]; readonly maxRefImages: number; readonly freeRefImages: number; readonly audio: boolean;
}
export interface ModelInfo {
  readonly id: string;              // "deepseek:deepseek-flash"、"minimax:MiniMax-H3"
  readonly provider: string; readonly model: string; readonly capability: Capability;
  readonly caps: TextCaps | ImageCaps | VideoCaps;
  readonly params?: Readonly<Record<string, readonly string[]>>;   // 可选参数取值，如 resolution: ['480P','768P']
}
```
- 注册表 `src/model/registry.ts`：内置 `ModelInfo` 列表 + 文本模型工厂 `createTextModel(id, deps, creds)`。图片 / 视频本阶段**只登记能力**，调用实现在 Phase 5。
- `openai-compatible` 文本适配器：`POST {base}/chat/completions`，`messages: [{role:'system'},{role:'user'}]`，`response_format: {type:'json_object'}`（caps.json 为真时）；读 `usage.prompt_tokens / completion_tokens`。超时 120 s；429 / 5xx 重试 3 次，指数退避加抖动，遵守 `Retry-After`；401/403 立即失败并提示 `cred set <provider>`。错误分类成 `ModelError { kind: 'auth' | 'rate' | 'server' | 'bad_request' | 'network' | 'timeout' }`。
- `cmd:` 前缀的模型 id 保留给 Phase 2 的 `CommandTextModel`（`cmd:claude -p`）。

### 2. 节点与预设
节点（node）是「平台里要选模型的位置」，与 stage 不完全一一对应：
```
text:outline text:cast text:art text:script text:staging text:storyboard
image:character-refs image:keyframe video:segment
```
`presets/budget.json`、`presets/production.json`（仓库内置，可被 `~/.config/ai-video-platform/presets/*.json` 同名覆盖）：
```json
{ "name": "budget", "title": "小成本验证", "description": "先跑通再说",
  "nodes": {
    "text:*": { "model": "deepseek:deepseek-flash" },
    "image:character-refs": { "model": "<实施时定>", "params": { "quality": "low" } },
    "image:keyframe": { "model": "<实施时定>" },
    "video:segment": { "model": "minimax:MiniMax-H3-Lite", "params": { "resolution": "480P" } } } }
```
- `text:*` 通配，具体节点优先。
- 图片模型在实施时按当时可用的 API 选定（候选：DashScope Qwen Image、OpenAI GPT Image）；要求能力里 `maxRefImages ≥ 1`（关键帧要挂参考图）。
- 生产级：文本 `deepseek:deepseek-v4-pro`，视频 `minimax:MiniMax-H3` 768P。
- 校验：预设引用的模型 id 必须在注册表里，参数值必须在 `ModelInfo.params` 允许范围内；能力不匹配（例如给 `video:segment` 配了文本模型）拒绝。

项目层（迁移 v4，追加表，最新一条生效）：
```sql
CREATE TABLE project_preset (id INTEGER PRIMARY KEY, preset TEXT NOT NULL, set_at TEXT NOT NULL) STRICT;
CREATE TABLE node_model_override (
  id INTEGER PRIMARY KEY, node TEXT NOT NULL, model TEXT,          -- model 为 NULL 表示撤销覆盖
  params TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params)), set_at TEXT NOT NULL
) STRICT;
ALTER TABLE node_attempt ADD COLUMN cost REAL;
ALTER TABLE node_attempt ADD COLUMN cost_currency TEXT;
ALTER TABLE node_attempt ADD COLUMN price_ref TEXT;                -- 计价用的价格条目（来源 + 日期）
```
`resolveNodeModel(db, node)` → `{ modelId, params, from: 'override' | 'preset' }`。

### 3. 价格
价格条目：
```json
{ "model": "minimax:MiniMax-H3", "params": { "resolution": "768P" },
  "unit": "video_second", "price": 0.08, "currency": "USD",
  "source": "https://platform.minimax.io/docs/guides/pricing-video.md", "checkedAt": "2026-10-29" }
```
单位：`token_in` / `token_out`（每百万）、`image`、`video_second`、`ref_image_extra`。
来源链（取第一个有的，并记录是哪一层）：
1. 用户覆盖 `~/.config/ai-video-platform/prices.json`
2. 拉取缓存 `~/.config/ai-video-platform/prices-cache.json`（`prices refresh` 写入；超过 7 天显示「可能过期」但仍可用）
3. 仓库内置 `prices/builtin.json`（每条必须有 source 与 checkedAt；测试检查这一点）

拉取器（`PriceFetcher` 接口）：本阶段实现 OpenRouter 文本价格拉取（模型 id 映射写在内置表的 `openrouterId` 字段）；其余供应商没有接口，返回空。汇率：`prices/fx.json`（内置一个带日期的默认值，可覆盖），显示时注明。

### 4. 估算器
`estimateProject(db, presetOrCurrent)` → 每个节点 `{ node, model, quantity: {low, high, unit}, cost: {low, high, currency}, assumptions: string[], priceRef }` + 合计。用量模型：
| 节点 | 用量来源 | 区间 |
|---|---|---|
| 文本各阶段 | 已有产物时：上一次 run 的实际 tokens；没有时：提示词字符数（skill 文件 + 上游）/ 1.6 + 期望输出字符（按 duko 样例每集的产物大小折算）/ 1.6 | low = 1 次通过，high = 2 次（含一次修复） |
| 角色参考图 | 大纲里 lead + support 人数 × 5 视图（functional 角色不出图） | high 加 20% 重出 |
| 关键帧 | 有分镜：切数；没有：集数 × 每集 11–16 切（duko 样例区间） | high 加 20% 重出 |
| 视频 | 有分镜：Σ段秒数；没有：集数 × 单集目标秒数 | high 加一次重生成的 15% |
- 估算只读，不写库；结果里 `assumptions` 逐条说明（「按每集 11–16 切估」「按 1 USD = 7.1 CNY」）。
- 文本节点运行后，执行器按 `usage × 单价` 写 `node_attempt.cost`（用量为 null 时写 null，不猜）。

### 5. 凭据
- 读取顺序：环境变量（`DEEPSEEK_API_KEY`、`MINIMAX_API_KEY`、`DASHSCOPE_API_KEY`、`OPENAI_API_KEY`）→ `~/.config/ai-video-platform/credentials.json`。
- 文件以 0600 创建；读取时若权限比 0600 宽，拒绝并提示 `chmod 600`。
- `cred set <provider>` 只从 stdin 读（不接受命令行参数，避免进 shell 历史）；`cred list` 只显示末 4 位。
- 凭据永不写进项目目录或 sqlite；错误消息里不回显 key。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/model/capabilities.ts` | CREATE | 能力类型 |
| `src/model/registry.ts` | CREATE | 内置模型清单与文本模型工厂 |
| `src/model/openai-compatible.ts` | CREATE | 文本适配器（DeepSeek） |
| `src/model/errors.ts` | CREATE | `ModelError` 分类 |
| `src/config/paths.ts` | CREATE | 用户配置目录（`AVP_CONFIG_DIR` > `XDG_CONFIG_HOME` > `~/.config`） |
| `src/config/credentials.ts` | CREATE | 凭据读写与权限检查 |
| `src/presets/presets.ts` | CREATE | 读取与校验预设、通配解析 |
| `presets/budget.json`、`presets/production.json` | CREATE | 两套内置预设 |
| `src/pricing/prices.ts` | CREATE | 价格条目类型、来源链、查价 |
| `src/pricing/openrouter.ts` | CREATE | 文本价格拉取 |
| `prices/builtin.json`、`prices/fx.json` | CREATE | 内置价格表（每条带来源与日期）、汇率 |
| `src/estimate/usage.ts`、`src/estimate/estimate.ts` | CREATE | 用量模型与估算 |
| `src/db/schema-v4.ts`、`src/db/migrations.ts` | CREATE / UPDATE | 迁移 v4 |
| `src/repo/models.ts` | CREATE | 项目预设、节点覆盖、`resolveNodeModel` |
| `src/executor/run-node.ts` | UPDATE | 无 `--model-cmd` 时按节点取模型；写入 cost |
| `src/cli.ts` | UPDATE | `models` / `preset` / `model` / `estimate` / `prices` / `cred` |
| `test/models.test.ts`、`test/pricing.test.ts`、`test/estimate.test.ts`、`test/credentials.test.ts` | CREATE | 见测试策略 |

## NOT Building
- 图片、视频适配器的实际调用与任务状态机（Phase 5）
- 「模型与预设」界面（Phase 4）
- 语音 / TTS 节点（PRD 开放问题，未定供应商）
- 价格的自动定时刷新（只做手动 `prices refresh`）
- 多币种账单对账

---

## Step-by-Step Tasks

### Task 1: 配置目录与凭据
- **ACTION**: `configDir()`；`credentials.ts`：`getCredential(provider)`、`setCredential(provider, key)`、`listCredentials()`、`removeCredential(provider)`。
- **GOTCHA**: 写文件用 `writeFileSync(path, data, { mode: 0o600 })` 并在写后 `chmodSync` 一次（已存在文件时 mode 不生效）；读时 `statSync(path).mode & 0o077` 非 0 即拒绝。
- **VALIDATE**: 测试用临时目录注入 `AVP_CONFIG_DIR`；权限过宽被拒；env 优先于文件；list 只显示末 4 位。

### Task 2: 能力与注册表
- **ACTION**: `capabilities.ts`、`registry.ts`（内置 `MODELS: readonly ModelInfo[]`，含 deepseek-flash、deepseek-v4-pro、MiniMax-H3、MiniMax-H3-Lite 与选定的图片模型）；`findModel(id)`；`createTextModel(id, deps)`（`cmd:` 走 Phase 2 的命令行模型）。
- **VALIDATE**: 未知 id 报错列出可选；能力类型与节点类型对得上。

### Task 3: OpenAI 兼容文本适配器
- **ACTION**: 实现关键设计 1；`baseUrl` 与 `model` 来自 ModelInfo；key 来自凭据。
- **GOTCHA**: 不打印请求体与 key；超时用 `AbortSignal.any([signal, AbortSignal.timeout(ms)])`；重试只对 429/5xx/网络错误，其余 4xx 直接失败。
- **VALIDATE**: 注入假 fetch：200 正常、429 带 Retry-After 后成功、500 三次后失败（kind=server）、401（kind=auth 且消息提示 `cred set deepseek`）、返回非 JSON。

### Task 4: 预设
- **ACTION**: `loadPresets(configDir, builtinDir)`、`validatePreset(p, registry)`、`nodeConfig(preset, node)`（具体节点优先于 `text:*`）。
- **VALIDATE**: 两套内置预设都通过校验；用户目录同名预设覆盖；坏预设点名字段。

### Task 5: 迁移 v4 与项目模型选择
- **ACTION**: schema-v4（关键设计 2）；`repo/models.ts`：`usePreset`、`setNodeModel`、`clearNodeModel`、`resolveNodeModel`。
- **GOTCHA**: 迁移编号按实际合并顺序分配；本计划假定 Phase 2 的 v3 已合并。
- **VALIDATE**: 切换预设后 `resolveNodeModel` 结果随之改变，节点覆盖优先；撤销覆盖后回到预设。

### Task 6: 价格表与来源链
- **ACTION**: `prices/builtin.json`：实施当天按 External Documentation 的官方页面逐条核对后填写（DeepSeek 两个模型的输入 / 输出单价、MiniMax H3 各档每秒价、选定图片模型的每张价），每条写 `source` 与 `checkedAt`；`prices.ts`：`lookupPrice(model, params, unit)` 按来源链返回 `{entry, layer}`。
- **GOTCHA**: 查不到价格时估算器显示「无价格」并在 assumptions 里说明，而不是按 0 计。
- **VALIDATE**: 测试断言内置表每条都有 source 与合法日期；三层覆盖顺序正确；缓存超过 7 天标「可能过期」。

### Task 7: OpenRouter 拉取
- **ACTION**: `fetchOpenRouterPrices(deps)`：GET models 列表，按内置表的 `openrouterId` 取 `pricing.prompt/completion`（字符串 → 数字 × 1e6 得每百万价），写缓存。
- **VALIDATE**: 假 fetch 返回样例；字段缺失或非数字时跳过该条并记问题，不中断整体。

### Task 8: 估算器
- **ACTION**: 实现关键设计 4；`estimateProject(db, { preset?: string | 'current' })`；`compareEstimates(db, ['budget','production'])`。
- **VALIDATE**: 用 duko 夹具导入后的项目：视频秒数等于分镜段秒数之和、关键帧数等于切数；只有大纲时按集数估算并在 assumptions 说明；区间 low ≤ high；固定价格表下的结果与手算一致。

### Task 9: 接入执行器
- **ACTION**: `run <dir> <stage>` 不给 `--model-cmd` 时，`resolveNodeModel(db, 'text:'+stage)` → `createTextModel`；每次 attempt 结束按 usage 计费写 `cost` / `price_ref`。
- **VALIDATE**: 假 fetch 的 DeepSeek 适配器跑 Phase 2 的大纲集成测试，attempt 上有 cost；usage 缺失时 cost 为 null。

### Task 10: CLI
- **ACTION**: `models [--capability text|image|video]`、`preset list` / `preset use <dir> <name>`、`model set <dir> <node> <modelId> [--param k=v]` / `model clear <dir> <node>`、`estimate <dir> [--preset current|budget|production|all]`、`prices show [--model id]` / `prices refresh`、`cred set|list|rm <provider>`。
- **GOTCHA**: `cred set` 只读 stdin；`estimate` 的表格输出到 stderr、JSON 到 stdout（与 Phase 2 的进度约定一致）。
- **VALIDATE**: CLI 冒烟（`AVP_CONFIG_DIR` 指向临时目录，不出网）。

### Task 11: 文档
- **ACTION**: `docs/models-and-pricing.md`：节点列表、预设格式、价格来源链与更新方法、凭据存放位置与权限要求。

---

## Testing Strategy

### Unit Tests
| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| 预设通配 | `text:*` + `text:art` 覆盖 | art 用覆盖值，其余用通配 | |
| 预设引用未知模型 | `deepseek:deepseek-chat` | 报错并列出可选模型 | ✓ |
| 能力不匹配 | video 节点配文本模型 | 拒绝 | ✓ |
| 适配器 429 重试 | 假 fetch 429 → 200 | 成功，sleep 调用一次且遵守 Retry-After | ✓ |
| 适配器 401 | 假 fetch 401 | ModelError(auth)，消息不含 key | ✓ |
| 价格来源链 | 三层都有 / 只有内置 | 取用户层 / 取内置层并标来源 | |
| 无价格 | 未登记的模型 | 估算显示「无价格」，不按 0 计 | ✓ |
| 凭据权限 | 0644 的凭据文件 | 拒绝读取并提示 chmod | ✓ |

### Integration
| Test | 期望 |
|---|---|
| duko 全量导入后估算两套预设 | 节点齐全，视频 = 段秒数之和 × 单价，合计区间合理 |
| 切换预设不改代码 | `preset use` 后 `resolveNodeModel` 全部换掉，覆盖保留 |
| 执行器用真实适配器（假 fetch） | run passed，attempt 记录 usage 与 cost |

### Edge Cases Checklist
- [x] 空项目估算：只能给按参数的粗估，并说明
- [x] 网络失败：适配器 kind=network，重试后失败；价格拉取失败回落内置表
- [x] 权限：凭据文件权限过宽
- [x] 汇率缺失：只显示 USD

---

## Validation Commands
```bash
pnpm typecheck
node --test test/models.test.ts test/pricing.test.ts test/estimate.test.ts test/credentials.test.ts
pnpm test && pnpm coverage
```
EXPECT: 零类型错误；全部通过；覆盖率达标；测试全程不出网。

### Manual Validation
- [ ] `cred set deepseek`（真实 key）→ `run duko outline` 不带 `--model-cmd` → passed，`runs --id` 显示每次尝试的费用
- [ ] `prices refresh` 能拉到 OpenRouter 的文本价格并显示来源
- [ ] `estimate duko --preset all` 两列数字与价格表手算一致
- [ ] 凭据不在项目目录：`grep -r <key 末 8 位> <项目目录>` 无结果

---

## Acceptance Criteria
- [ ] 切换预设不改代码；节点覆盖生效且可撤销
- [ ] 同一项目给出两套预设的费用区间，每个数字都能追到价格来源与日期，并标「仅供参考」
- [ ] DeepSeek 适配器能驱动 Phase 2 的执行器跑通大纲，记录实际费用
- [ ] 凭据只在本机配置目录或环境变量，权限受检查
- [ ] 类型检查、测试、覆盖率通过

## Completion Checklist
- [ ] 网络、文件系统依赖可注入，测试不出网
- [ ] 外部 JSON（预设、价格、凭据、接口响应）全部校验
- [ ] 错误消息中文、点名对象、不泄露 key
- [ ] 内置价格表每条有来源与日期

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 官方价格页无法自动读取、价格变动 | H | M | 内置表带日期与来源；`prices show` 显示「可能过期」；生成后记实际费用校准 |
| 模型改名 | M | M | 预设在 `preset use` 时校验；注册表集中维护 |
| 估算用量模型偏差大 | M | M | 估算给区间并列出假设；Phase 8 用实际数据校准 |
| 设计稿示例价格与真实价格不符 | 已发生 | L | Phase 4 做界面时按本阶段价格表重算示例 |

## Notes
- 设计稿「模型与预设」页里写的 `deepseek-chat`、视频 ¥27–37 都是示意，按本计划的注册表和价格表在 Phase 4 更新。
- 图片模型的选型留到实施当天：以「能挂参考图、有官方按张计价」为准，选定后写进 `prices/builtin.json` 和两套预设。

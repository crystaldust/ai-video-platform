# Plan: 图片/视频生成与可靠任务（PRD Phase 5，第一部分 5a：后端与命令行）

> 2026-10-31 按当前 main（d3e661a）重写。旧版（2026-10-29）早于稳定 id、按集续跑、付费确认单按集勾选与上限、迁移 v6 等改动，且按旧的 Qwen 接口写，已作废。
> Phase 5 拆成两部分，同 Phase 4：**5a（本计划）** 数据、适配器、计划、执行、恢复、命令行；**5b（另起计划）** 接口与界面（生成任务页、候选预览、全貌付费卡片进度、设计稿补画）。

## Summary
确认付费确认单后，平台按勾选的节点和集，可靠地生成角色参考图、关键帧（百炼 Qwen-Image 3.0）和视频（MiniMax H3-Lite）。付费生成是持久化的任务状态机：**先写库再请求**，拿到供应商任务 id 立即落库；崩溃或重启后只查询、只对账，**绝不自动重新提交**；「重新查询」和「重新生成」是两个动作。每个任务记计划输入与实际输入、失败或被拒原因、预估与实际费用；产出文件进内容寻址素材库，成为挂在镜头上的候选。只执行已确认、且在预算上限内的项。

## User Story
作为作者，我希望确认费用后平台可靠地生成参考图、关键帧和视频，中途断网或重启不会重复扣费，每张图、每段视频都查得到用了什么输入、花了多少钱，从而放心地一键付费生成。

## Problem → Solution
确认单确认后什么都不会发生（`PaidGateModal` 提示「会在 Phase 5 执行」），任务、候选表从 Phase 1 起就建好但没有任何读写代码 → 任务状态机 + 适配器 + 计划器 + 执行器 + 恢复对账 + 命令行，5b 再接界面。

## Metadata
- **Complexity**: XL（拆 5a / 5b；5a 约 20 个文件）
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`
- **PRD Phase**: Phase 5 图片/视频生成与可靠任务
- **Depends**: Phase 3（模型注册表、预设、价格、凭据）、Phase 4（付费确认单）
- **Success signal（PRD:207）**: 生成过程中强制中断再重启，任务能恢复，没有重复提交

---

## UX Design

5a 只有命令行；界面在 5b。

### Before
```
全貌 → 确认付费生成 → 勾选、上限 → 确认
  → 「已确认。图片和视频会在付费生成模块（Phase 5）执行」——然后什么也不发生
```

### After（5a，命令行）
```
$ avp generate <项目> [--gate <id>]          # 按最近一张已确认的确认单生成
  计划：角色参考图 4 人 × 5 视图 = 20 张 · 关键帧 51 张 · 视频 15 段（共 112 秒）
  预估 ¥168–214 / 上限 ¥220
  ▸ 参考图  20/20 ✓
  ▸ 关键帧  49 ✓ · 2 被拒（内容审核）
  ▸ 视频    提交 15 · 生成中 6 · 完成 9
  实际 ¥131.4（含 2 张被拒的 0 元）
（kill -9 后）
$ avp tasks resume <项目>
  对账：2 个「提交中」的任务——1 个在供应商任务列表里对上（补记 id），1 个没找到（标失败，可安全重生成）
  继续查询 6 个生成中的视频；0 次重新提交
$ avp tasks <项目> [--status failed]           # 列表：状态、费用、计划 vs 实际
$ avp tasks requery <项目> <任务 id>            # 只查询，不花钱
$ avp tasks regenerate <项目> <任务 id>         # 新建一条任务（attempt_of 指向旧的），计入预算
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 确认付费确认单 | 只改状态 | 状态改了，`generate` 才开始执行 | 5a 不自动开跑；5b 在界面上确认后自动开跑 |
| 命令行 | 无 | `generate`、`tasks`、`tasks resume / requery / regenerate` | |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/db/schema-v1.ts` | 73–167 | media_file、generation_task（CHECK 只有 6 个状态）、task_event、candidate、review、selection、candidate_state 视图、唯一索引 `task_provider_id` |
| P0 | `src/db/migrations.ts` | all | 只追加；`MIGRATIONS` 现到 v6 |
| P0 | `test/migrations.test.ts` | 末尾 v6 用例 | 迁移与旧库升级的测试写法 |
| P0 | `test/scenario-082.test.ts` | all | 任务 / 候选 / 选用的既有用法（裸 SQL）；`(provider, provider_task_id)` 重复抛 UNIQUE |
| P0 | `src/repo/media.ts` | all | `addMediaFile(project, srcPath)`——收的是文件路径，下载要先落临时文件 |
| P0 | `src/repo/paid-gates.ts`、`src/server/views/gates.ts` | all；gates 35–63 | 确认单行、`checkSelection`、上限按**人民币**存、估算是美元 |
| P0 | `src/estimate/usage.ts` | 44–179 | 张数、秒数的口径（每角色 5 视图、每切 1 帧、段秒数 = max(4, Σ切秒)），计划器必须同口径 |
| P0 | `src/model/openai-compatible.ts` | 7–48 及重试 | `HttpDeps` 注入点、超时、重试与 `classify` |
| P0 | `src/model/registry.ts`、`presets/budget.json` | all | `dashscope:qwen-image-3.0 {size:'1k'}`、`minimax:MiniMax-H3-Lite {resolution:'480P'}` |
| P0 | `src/config/credentials.ts` | 79–83 | `requireCredential('dashscope' / 'minimax')`，不回显 key |
| P1 | `src/repo/runs.ts` | 86–108 | 进程号判活与 `failInterruptedRuns`——崩溃收尾的先例 |
| P1 | `src/server/jobs.ts` | 46–62 | 后台任务（5b 用；5a 的执行器要写成可被它调用的函数） |
| P1 | `src/cli-orchestrate.ts`、`src/cli-shared.ts` | COMMANDS、BOOLEAN_FLAGS | 命令注册与开关参数 |
| P1 | `test/fixtures/duko/渡口-storyboard.json` | — | 段无秒数字段；切的 `frame` 是关键帧提示词；`characters`、`props`、`sceneRef` |
| P1 | `test/fixtures/skills/novel-storyboard/references/frame.md` | 13–28 | 关键帧挂参考图的约定、提示词收尾句、一帧一调 |
| P1 | `test/fixtures/skills/novel-storyboard/scripts/novel-storyboard.mjs` | 1071–1135、2203 | `exportPack`：H3 的 Picture 顺序与 `manifest.json` |
| P2 | `/Users/lance/Development/ai-video/shuohao-skills/skills/character-refs/scripts/core.mjs` | 25–30 | 视图定义（front-full 锚点，其余只参考锚点）与比例 |
| P2 | `test/models.test.ts` | 59–78 | `fakeHttp`：假 fetch 的写法 |

## External Documentation（2026-10-31 查）

| Topic | Source | Key Takeaway |
|---|---|---|
| Qwen-Image 3.0 生成与编辑 | https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference | 文生图与图生图同一模型同一接口；`input.messages[0].content` = 0–3 个 `{image}` + 1 个 `{text}`（**没有 `input.prompt`**）；`parameters.size` 用 `W*H`；`negative_prompt`、`n`、`seed`、`prompt_extend`、`watermark` |
| 异步与任务管理 | https://www.alibabacloud.com/help/en/model-studio/manage-asynchronous-tasks | 创建 `POST /api/v1/services/aigc/image-generation/generation` + `X-DashScope-Async: enable` → `output.task_id`；查询 `GET /api/v1/tasks/{id}`；**列表 `GET /api/v1/tasks?start_time&end_time&model_name&status&page_no&page_size`（窗口 ≤ 24 h，整个账号）**；状态 PENDING/RUNNING/SUCCEEDED/FAILED/CANCELED/UNKNOWN；结果 URL 与任务记录只留 24 h |
| 百炼地域 | 同上 | 新文档用工作空间地址 `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`（国际）/ `cn-beijing`；老地址 `dashscope-intl.aliyuncs.com` / `dashscope.aliyuncs.com` 仍可用；**key 按地域，不能跨区** |
| 百炼错误与审核 | https://www.alibabacloud.com/help/en/model-studio/error-code | 审核 400 `DataInspectionFailed` / `IPInfringementSuspect`（创建时或任务 FAILED 的 `output.code` 都可能）；限流 429 `Throttling.*`；免费额度用完 403 |
| 百炼价格与限流 | model-pricing / rate-limit 页 | qwen-image-3.0 国际：输出 $0.03/张、输入参考图 $0.003/张；**失败不收费**；3.0 限 20 张/分钟、异步并发 10 |
| MiniMax 视频创建 | https://platform.minimax.io/docs/api-reference/video-generation-v2-create.md | `POST https://api.minimax.io/v2/video_generation`（国内 `api.minimax.cn`）；`model: MiniMax-H3-Lite`；`content[]` 的 `{type:'image_url', image_url:{url}, role:'reference_image'}`；`resolution` `480P`；`duration` 4–15 整数；`ratio` 参考生视频时 **Lite 不接受 `adaptive`**；返回 `{task_id}` |
| MiniMax 查询与列表 | …-v2-query.md、…-v2-list.md | `GET /v2/query/video_generation/{id}`：`task.status` queued/running/succeeded/failed/cancelled，`task.content.url` 直链（有时效，重查拿新链接），`task.usage.output_seconds`；**列表 `GET /v2/query/video_generation?filter.model&filter.status&page_num&page_size`，近 7 天**；记录可查 7 天 |
| MiniMax 图片输入 | 创建页 | `url` 可用 `data:image/png;base64,…`；参考图 ≤ 9；单张 ≤ 30 MB；整个请求体 ≤ 64 MB |
| MiniMax 错误与价格 | pricing/overview.md | 422 code 1026 = 敏感内容（查询时 `task.error.code` 1026 也是）；402 余额不足；H3-Lite 480P $0.025/s，参考图前 5 张免费、之后 $0.02/张；按量付费下失败是否收费**官方没写** |

```
KEY_INSIGHT: 两家都没有幂等键，也不能给任务打自己的标签；对账只能按「模型 + 时间窗口」在供应商任务列表里找
APPLIES_TO: 任务 3、7（适配器的 listRecent、恢复）
GOTCHA: 同一家同一时刻有多个提交请求在路上，就分不清谁是谁 → 每家供应商的「提交」串行（同一时刻最多一个 submitting），提交本身很快，不影响吞吐；生成中的任务照常并发

KEY_INSIGHT: Qwen 结果 URL 与任务记录只留 24 h；MiniMax 链接有时效但 7 天内可重查拿新链接
APPLIES_TO: 任务 6、7（下载、恢复）
GOTCHA: succeeded 立刻下载；Qwen 超过 24 h 没下载下来就只能重新生成（标出来，交给人）

KEY_INSIGHT: Qwen-Image 3.0 最多 3 张参考图
APPLIES_TO: 任务 5（关键帧的参考图选择）
GOTCHA: frame.md 要求挂场景图 + 所有出场角色 + 道具，必然超过 3 张 → 规则见「关键设计 3」，被舍掉的参考写进计划输入，实际输入里没有，界面标「计划与实际不一致」

KEY_INSIGHT: 估算单价是国际区美元价；付费确认单的上限是人民币
APPLIES_TO: 任务 6（预算）
GOTCHA: 预算比较一律换成人民币：美元 × estimate.fx.usdToCny（确认单里存着当时的汇率），不读实时汇率
```

---

## Patterns to Mirror

### NAMING / 文件头
// SOURCE: src/db/schema-v6.ts:1-5
```ts
// v6：放弃一条打回意见。打回的运行没跑完（转人工、失败）时，意见没落实，会在全貌里列出来；
// 人决定不要了就记一个放弃时间，只追加列、不删行，意见本身仍留在记录里。
export const SCHEMA_V6 = `
ALTER TABLE revision_request ADD COLUMN dismissed_at TEXT;
`;
```
每个文件第一行中文说明是什么、为什么；函数 camelCase，常量 UPPER_SNAKE，文件 kebab-case；接口字段 `readonly`；库里 snake_case 行用 `toRow` 转成 camelCase（见 `src/repo/runs.ts` 的 `toRun`）。

### HTTP 注入与错误分类
// SOURCE: src/model/openai-compatible.ts:7-11, 42-48
```ts
export interface HttpDeps {
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}
function classify(status: number, provider: string, body: string, retryAfter: number | null): ModelError {
  const detail = body.slice(0, 300);
  if (status === 401 || status === 403) return new ModelError('auth', `${provider} 鉴权失败（HTTP ${status}）：检查凭据，cred set ${provider}`, status);
  if (status === 429) return new ModelError('rate', `${provider} 限流（HTTP 429）：${detail}`, status, retryAfter);
  if (status >= 500) return new ModelError('server', `${provider} 服务端错误（HTTP ${status}）：${detail}`, status, retryAfter);
  return new ModelError('bad_request', `${provider} 拒绝了请求（HTTP ${status}）：${detail}`, status);
}
```
图片、视频适配器复用 `HttpDeps`、`defaultHttpDeps`、`ModelError`（`src/model/errors.ts`），**提交请求不自动重试**（见关键设计 2），查询请求按现有指数退避重试。

### 凭据
// SOURCE: src/config/credentials.ts:79-83
```ts
export function requireCredential(provider: Provider, opts: CredentialOptions = {}): string {
  const found = findCredential(provider, opts);
  if (!found) throw new Error(`没有 ${provider} 的凭据：设置环境变量 ${ENV_VARS[provider]}，或运行 cred set ${provider}（从 stdin 读入）`);
  return found.key;
}
```
key 只放在请求头，不写进 `actual_input`、`task_event.detail`、错误消息、日志。

### 崩溃收尾
// SOURCE: src/repo/runs.ts:86-108（`isAlive(pid)` + `failInterruptedRuns(db, isActive)`）
任务表加 `pid`：恢复时只处理「进程已经不在」的任务，同一进程正在跑的不碰。

### 测试：假 fetch
// SOURCE: test/models.test.ts:61-77
```ts
function fakeHttp(replies: Reply[]): HttpDeps & { calls: { url: string; init: RequestInit }[]; sleeps: number[] } {
  …
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = replies.shift();
      if (!r) throw new Error('没有更多预设响应');
      if (r instanceof Error) throw r;
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers ?? {} });
    }) as typeof fetch,
```
生成测试用**假供应商**（实现 `ImageModel` / `VideoModel` 接口、记录每次 submit），适配器测试用 `fakeHttp`。不调真实接口。

### 迁移测试
// SOURCE: test/migrations.test.ts（v6 用例）——内存库断言新列 / CHECK；临时文件里跑 `MIGRATIONS.slice(0, 6)` 造 v6 旧库并插旧数据，`openDb` 升级后断言版本与旧数据都在。

---

## 关键设计

### 1. 任务状态机（迁移 v7 重建 generation_task）
```
planned ──写 submitting + submitted_at + pid──▶ submitting ──拿到 task_id 落库──▶ submitted ──▶ running
   │                                                │                                             │
   │                       崩溃后恢复：列表对账 ─────┴─▶ submitted（唯一匹配）                      ├─▶ succeeded ─下载入库建候选─▶ collected
   │                                                  ├─▶ failed（没找到：提交未到达，可安全重生成）  ├─▶ failed（原因）
   │                                                  └─▶ unknown（多个匹配，交给人）                └─▶ rejected（内容审核，原因）
   └─超预算 / 人取消──▶ cancelled
```
- v7：SQLite 改不了 CHECK，按「建新表 → 复制 → 删旧表 → 改名」重建 `generation_task`，同时重建依赖它的 `task_provider_id` 索引和 `candidate_state` 视图；`task_event.task_id`、`candidate.task_id` 的外键按表名引用，改名后仍有效（迁移测试要验证外键检查 `PRAGMA foreign_key_check` 为空）。
- 新状态：`submitting`、`collected`、`cancelled`、`unknown`；新列：`node`（`image:character-refs` / `image:keyframe` / `video:segment`）、`episode_key`、`label`（如 `front-full`、`ct_xxx`）、`content_fingerprint`（计划输入的 `contentHash`）、`paid_gate_id`、`attempt_of`（重生成时指向原任务）、`pid`、`submitted_at`、`provider_status`（供应商原始状态）、`result_url`（不含凭据）。
- 合法转移表写在 `src/generate/state-machine.ts`，非法转移抛错；每次转移写一条 `task_event`（供应商响应的关键字段，**不含 key、不含图片 base64**）。
- **重新查询**：对有 `provider_task_id` 的 submitted / running / unknown / succeeded（未下载）任务再查一次，不花钱。
- **重新生成**：新建任务（`attempt_of` 指向旧任务、同一 `paid_gate_id`），只有人明确操作才做，计入预算。

### 2. 提交的纪律（防重复付费）
1. 提交前：同一事务里把任务从 planned 改成 submitting、记 `submitted_at`、`pid`；**事务提交成功后**才发请求。
2. 每家供应商的提交串行（进程内一把锁：同一时刻最多一个 submitting 请求在路上），便于对账。
3. 提交请求**不自动重试**：网络错误、超时、5xx 都可能已经到达供应商——保持 submitting，交给对账；只有明确的 4xx（参数错 400、余额不足 402、审核 422 / DataInspectionFailed）直接转 failed / rejected。429 限流：可以确定没创建任务，等 `Retry-After` 后重新提交（仍是同一条任务）。
4. 拿到 task_id：立刻写 `provider_task_id`、转 submitted。唯一索引 `(provider, provider_task_id)` 兜底。

### 3. 任务计划（从确认单到任务列表）
输入：一张 `confirmed` 的确认单的 `selection`（`{'image:character-refs': true, 'image:keyframe': [ep…], 'video:segment': [ep…]}`）、上限（人民币）、当时的估算（含 fx）、当前产物（outline、cast、art、storyboard）。同一确认单重复执行：已经有任务的 (node, label) 不再建——**幂等的计划**。
- **角色参考图**（`image:character-refs`，selection 为 true 时）：大纲里 `tier !== 'functional'` 的角色（同 `usage.ts` 的口径），每人 5 个视图：`front-full`（锚点，不挂参考）→ 锚点 collected 后再出 `face-front`、`side-full`、`back-full`、`face-45`，都只参考锚点。提示词 = cast 卡 `image.prompt` + 视图说明（视图名、比例沿用 character-refs `core.mjs` 的定义，写成平台内常量）；目标实体 = 角色实体；候选 label = 视图名。
- **关键帧**（`image:keyframe`，勾选的集）：每切一张，提示词 = 切的 `frame` + 参考说明开头 + frame.md 的收尾句；画幅取分镜 `aspectRatio`；目标 = 切实体。参考图（最多 3 张，Qwen 3.0 上限）：出场角色的锚点图优先（按 `characters` 顺序），**场景图、道具图本阶段没有来源**（见 NOT Building），计划输入里记下「想挂但没有」的参考。依赖：所需角色锚点必须先 collected，否则这一帧等待。
- **视频**（`video:segment`，勾选的集）：每段一个任务，模式 = 参考生视频：`text` = 段的 `h3Prompt`，`reference_image` = 这一段各切的关键帧，按 Picture 顺序（同 `exportPack`：段内切的顺序）；`duration` = max(4, Σ切秒) 取整（计划 vs 实际不一致时都记）；`ratio` = 项目画幅（Lite 不接受 adaptive）；`resolution` 取预设。依赖：这一段所有关键帧 collected。
- 每个任务的 `planned_input` 是规范化 JSON（参考图用素材库 sha256 表示，不放 base64），`content_fingerprint = contentHash(planned_input)`。

### 4. 执行与预算
- 顺序与依赖：参考图锚点 → 其余视图 & 关键帧（锚点就绪的）→ 视频（关键帧就绪的）。并发：图片 4、视频 3（可配置）；提交串行（见 2）。
- 预算（人民币）：提交前若 `已花实际 + 在途预估 + 本任务预估 > 上限` → 不提交，执行器停下并说明「到上限了，剩 N 个任务没提交」（任务保持 planned）。实际费用：Qwen 按 `usage`（输出张数 × 单价 + 输入参考图 × 单价），MiniMax 按 `usage.output_seconds × 单价 + 超出 5 张的参考图`；单价查不到记 null（不猜），失败 / 被拒：Qwen 记 0（官方：失败不收费），MiniMax 记 null 并在 `error` 旁注明「按量付费下失败是否收费官方未说明」。
- 轮询：视频 10 s、图片 5 s，带抖动；查询走重试。
- 下载：succeeded 立即下载到 `media/.tmp-…` → 校验类型 / 大小 → `addMediaFile` → 建 candidate（`label` = 视图名或 `v1`、`v2`…，`(target_entity_id, label)` 唯一，重生成递增）→ collected。下载失败可单独重试（重新查询拿新链接），不重新生成。
- 参考图上传：读素材库文件转 `data:image/png;base64,…`；Qwen 单张 ≤ 10 MB、MiniMax 整个请求体 ≤ 64 MB——超限就报错转 failed（原因写明），不静默缩图。

### 5. 恢复（`tasks resume`，5b 里 serve 启动时也调用）
只处理 `pid` 已不在的任务：
1. **submitting**：调供应商列表（Qwen：`model_name` + `[submitted_at − 2 min, submitted_at + 10 min]`；MiniMax：`filter.model` 近 7 天按创建时间过滤），去掉库里已有的 task_id：唯一匹配 → 补记 task_id 转 submitted；无匹配 → failed（原因「提交没有到达供应商，可安全重新生成」）；多个匹配 → unknown（列出候选 task_id，交给人用 requery 指定）。
2. **submitted / running**：继续轮询。
3. **succeeded**（未 collected）：重新下载；Qwen 超过 24 h 拿不到结果 → failed（原因「结果已过期」）。
4. **planned**：不动（继续提交要人发起 `generate`）。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/db/schema-v7.ts`、`src/db/migrations.ts` | CREATE / UPDATE | 重建 generation_task（新状态与列）、重建索引与视图 |
| `src/generate/state-machine.ts` | CREATE | 状态、合法转移表、`transition()` |
| `src/repo/tasks.ts` | CREATE | 任务与事件的读写（`createTask`、`markSubmitting`、`recordProviderId`、`transition`、`listTasks`…） |
| `src/repo/candidates.ts` | CREATE | 建候选、下一个 label |
| `src/model/media-model.ts` | CREATE | `ImageModel`、`VideoModel` 接口（submit / query / listRecent）与公共类型 |
| `src/model/dashscope-image.ts` | CREATE | Qwen-Image 3.0 异步接口 |
| `src/model/minimax-video.ts` | CREATE | H3 V2 接口 |
| `src/model/registry.ts` | UPDATE | `createImageModel` / `createVideoModel`；按凭据与地域配置选地址 |
| `src/config/credentials.ts` 或 `src/config/endpoints.ts` | UPDATE / CREATE | 地域（国际 / 国内）与百炼工作空间地址的配置，见 Notes 待定项 1 |
| `src/generate/planner.ts` | CREATE | 确认单 → 任务计划（纯函数为主，快照测试） |
| `src/generate/prompts.ts` | CREATE | 角色视图提示词、关键帧提示词与参考选择 |
| `src/generate/runner.ts` | CREATE | 依赖调度、并发、串行提交、预算、轮询、下载入库 |
| `src/generate/recovery.ts` | CREATE | 恢复对账 |
| `src/cli-generate.ts`、`src/cli.ts`、`src/cli-shared.ts` | CREATE / UPDATE | `generate`、`tasks`、`tasks resume / requery / regenerate` |
| `test/generate-*.test.ts`、`test/media-models.test.ts`、`test/migrations.test.ts` | CREATE / UPDATE | 见 Testing Strategy |
| `test/support/fake-media.ts` | CREATE | 假图片 / 视频供应商（可编程：成功、失败、审核拒绝、提交后崩溃、列表返回值） |
| `docs/generation.md` | CREATE | 状态机、提交纪律、恢复语义、费用口径、地域与凭据 |

## NOT Building
- 接口、界面、设计稿补画（5b）
- 场景图、道具图的生成（估算里没有这两个节点；关键帧本阶段只挂角色锚点，见 Notes 待定项 2）
- 审阅、合格 / 选用、修订路径（Phase 6）；剪辑（Phase 7）
- 回调地址（`callback_url`）：需要公网可达的端点，本地服务不适用，用轮询
- 第二家供应商、自动质检、配音

---

## Step-by-Step Tasks

### Task 1: 迁移 v7 与状态机
- **ACTION**: `schema-v7.ts` 重建 generation_task；`state-machine.ts`。
- **IMPLEMENT**: 新表含旧列 + 新列（见关键设计 1），CHECK 含 10 个状态与 `node` 的取值；`INSERT INTO new SELECT … FROM old`（新列置 NULL / 由 capability 推 node 时置 NULL）；重建 `task_provider_id` 唯一索引与 `candidate_state` 视图（视图定义照抄 v1:159-167）。状态机：`TASK_STATUSES` 常量元组 + `isTaskStatus`、`TRANSITIONS: Record<status, status[]>`、`assertTransition(from, to)`。
- **MIRROR**: 迁移测试；`as const` 元组 + 守卫（`src/domain/types.ts` 的 `STAGES` / `isStage`）。
- **GOTCHA**: 迁移在 `withTransaction` 里跑，`PRAGMA foreign_keys` 在事务内改不了——用 `foreign_key_check` 验证而不是关外键；重建视图前先 `DROP VIEW candidate_state`。
- **VALIDATE**: 新库有新列与 CHECK；v6 旧库（含 scenario-082 那样的任务、候选行）升级后数据、唯一索引、视图结果都在；`foreign_key_check` 为空；每条合法 / 非法转移各有用例。

### Task 2: 任务与候选仓储
- **ACTION**: `src/repo/tasks.ts`、`src/repo/candidates.ts`。
- **IMPLEMENT**: `createTask`（planned，写 planned_input 与 fingerprint）、`markSubmitting(id, pid)`（只允许 planned → submitting，一条事务）、`recordProviderId`、`transition(id, to, detail)`（校验 + 写 task_event）、`setActualInput`、`setCost`、`listTasks(filter)`、`tasksOfGate(gateId)`、`nextLabel(entityId, base)`、`addCandidate`。
- **MIRROR**: `src/repo/runs.ts` 的 Raw → Row、`nowIso()`。
- **GOTCHA**: `task_event.detail` 里不放 key 与 base64；`recordProviderId` 撞唯一索引时抛出明确错误（说明这个供应商任务已经记在另一条任务上）。
- **VALIDATE**: 单元测试覆盖每个函数、非法转移、唯一索引。

### Task 3: 适配器接口与两家实现
- **ACTION**: `media-model.ts`、`dashscope-image.ts`、`minimax-video.ts`、`registry.ts` 工厂。
- **IMPLEMENT**: `submit(req) → {providerTaskId}`（不重试，见关键设计 2）、`query(id) → {status, providerStatus, url?, usage?, error?: {code, message, moderation: boolean}}`、`listRecent({model, since, until}) → [{providerTaskId, createdAt}]`（分页取完）。状态映射：Qwen PENDING→submitted、RUNNING→running、SUCCEEDED→succeeded、FAILED→failed（`DataInspectionFailed`/`IPInfringementSuspect` → rejected）、CANCELED→cancelled、UNKNOWN→unknown；MiniMax queued→submitted、running、succeeded、failed（code 1026 → rejected）、cancelled。
- **MIRROR**: `HttpDeps`、`classify`、`ModelError`；提交前用 `requireCredential`。
- **GOTCHA**: Qwen `size` 用 `W*H`、请求体用 `input.messages`；Qwen 列表时间参数是 `YYYYMMDDhhmmss`（UTC+8）、窗口 ≤ 24 h；MiniMax 错误体是 `{type:'error', error:{…}}`；Lite 的 ratio 不能是 adaptive；data URI 的格式名小写。
- **VALIDATE**: `fakeHttp` 覆盖：提交成功、400 / 402 / 422 / 审核码、429、5xx 与网络错误（**提交不重试，抛出可识别的「结果未知」错误**）、查询的各状态映射、列表分页、请求头里有 key 而错误消息里没有。

### Task 4: 角色视图与关键帧的提示词
- **ACTION**: `src/generate/prompts.ts`。
- **IMPLEMENT**: `CHARACTER_VIEWS`（front-full 2:3 锚点、face-front 4:5、side-full 2:3、back-full 2:3、face-45 4:5，注明来源 character-refs `core.mjs`）；`characterViewPrompt(card, view)`；`keyframePrompt(cut, refs)`（参考说明开头 + `frame` + 收尾句 `No text, no watermark, no borders — a single clean full-bleed frame.`）；`pickRefs(cut, anchors, max=3)`。尺寸：1k 档按比例给 `W*H`（总像素在 512²–2048² 之间）。
- **VALIDATE**: 快照式断言：提示词结构、参考顺序、超过 3 个角色时的取舍与「想挂但没有」的记录。

### Task 5: 任务计划
- **ACTION**: `src/generate/planner.ts`。
- **IMPLEMENT**: `planGeneration(db, gate) → PlannedTask[]`（node、episodeKey、label、targetVersionId、dependsOn、plannedInput、costEstimate 人民币）；与已有任务对比只补缺（幂等）；数量口径与 `usage.ts` 一致（每角色 5 张、每切 1 张、段秒数 max(4, Σ)）。
- **GOTCHA**: `target_version_id` 取实体当前版本（`currentVersion`，见 scenario-082）；确认单未确认、或勾选的集在当前分镜里已不存在 → 报错说明。
- **VALIDATE**: 渡口样例：确认单勾 ep1 关键帧与视频 → 任务数 = 第 1 集切数 / 段数，与估算的数量一致；重复计划不新增；没勾的集不建。

### Task 6: 执行器
- **ACTION**: `src/generate/runner.ts`。
- **IMPLEMENT**: `runGeneration(project, gateId, {models, http, concurrency, onProgress, signal})`：按依赖调度、每家串行提交、预算检查（人民币，fx 取确认单估算里的）、轮询、下载入库建候选、记实际输入与费用；进度事件（5b 推给页面）。
- **GOTCHA**: 预算检查在提交前做；被拒、失败不让依赖它的任务卡死——依赖失败的任务保持 planned 并在汇总里列出「等待：某锚点生成失败」。
- **VALIDATE**: 假供应商：全流程成功 → 候选数 = 任务数；预算到线 → 剩余任务 planned、submit 次数正确；审核拒绝 → rejected、原因、费用 0；下载失败 → succeeded 未 collected，重试下载后 collected 且 submit 次数不变。

### Task 7: 恢复
- **ACTION**: `src/generate/recovery.ts`。
- **IMPLEMENT**: `recoverTasks(project, {models, isActive})`：关键设计 5 的 4 条。
- **VALIDATE**: 「提交前崩溃」（submitting 写入后 submit 前抛错）→ 列表无匹配 → failed，submit 0 次；「提交后崩溃」（submit 成功、记 id 前抛错）→ 唯一匹配 → submitted，**submit 总次数仍为 1**；多个匹配 → unknown；同进程仍在跑的任务不动。

### Task 8: 命令行
- **ACTION**: `src/cli-generate.ts`，注册进 `src/cli.ts`。
- **IMPLEMENT**: `generate <dir> [--gate <id>] [--concurrency N]`、`tasks <dir> [--status s] [--node n]`、`tasks resume <dir>`、`tasks requery <dir> <id>`、`tasks regenerate <dir> <id>`；进度打到 stderr，结果 JSON 打到 stdout（同现有命令）。
- **VALIDATE**: `test/cli.test.ts` 冒烟（假供应商通过环境变量或命令模型注入，同 `duko-cmd.ts` 的做法）。

### Task 9: 文档
- **ACTION**: `docs/generation.md`；`docs/models-and-pricing.md` 补地域与两家凭据；`docs/orchestration.md` 的「Phase 5 处理」改成实际行为。

---

## Testing Strategy

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| 先写库再请求 | submit 前抛错 | 库里任务 submitting、供应商 0 次调用；恢复后 failed（可安全重生成） | 是 |
| 提交后崩溃 | submit 成功、记 id 前抛错 | 恢复对账唯一匹配 → submitted；submit 总次数 1 | 是 |
| 对账多个匹配 | 时间窗内同模型 2 个陌生任务 | unknown，不重提 | 是 |
| 提交网络错误 | fetch 抛错 | 不重试，保持 submitting | 是 |
| 429 | 提交返回 429 | 等待后重新提交同一任务，最终只有 1 个 provider id | 是 |
| 审核拒绝 | 422 / DataInspectionFailed | rejected、原因、费用规则 | 是 |
| 重新查询 vs 重新生成 | requery / regenerate | requery 不调 submit；regenerate 新任务 attempt_of 指向旧任务、label 递增 | |
| 预算上限 | 上限低于总预估 | 提交到线即停，其余 planned，金额按人民币比较 | 是 |
| 依赖 | 锚点失败 | 其余视图、用到它的关键帧不提交，汇总说明 | 是 |
| 幂等计划 | 同一确认单跑两次 | 不新增任务 | |
| 迁移 | v6 库含任务、候选 | 升级后数据、索引、视图、外键都对 | |
| 082 | 只对 082 段 regenerate | 其他段任务数不变 | |

### Edge Cases Checklist
- [ ] 确认单未确认 / 已取消 / 不存在
- [ ] 勾选的集在当前分镜里已删除
- [ ] 角色卡缺 `image.prompt`
- [ ] 参考图超过供应商大小限制
- [ ] 凭据缺失（报错说明 `cred set`，不回显 key）
- [ ] 进程中断后同时有 submitting、running、succeeded 未下载

---

## Validation Commands

### Static Analysis
```bash
npx tsc -p . && npm run -s web:typecheck
```
EXPECT: 零错误

### Unit / Full Tests
```bash
node --test test/generate-*.test.ts test/media-models.test.ts test/migrations.test.ts
npm test
npm run coverage
```
EXPECT: 全部通过；覆盖率达到 package.json 的门槛（行 80、分支 70、函数 80）

### E2E / Build
```bash
npm run -s test:e2e && npm run -s web:build
```
EXPECT: 不回归

### Manual Validation（要花真钱，单独征得用户同意后才做）
- [ ] 用户写入 dashscope、minimax 凭据（`cred set`，从 stdin，不进对话）
- [ ] 在项目**副本**上：确认单只勾 1 个角色锚点 + 1 帧关键帧 + 1 段视频，上限 ¥5
- [ ] `generate` 中途 `kill -9`，`tasks resume`：对照供应商任务列表，没有重复提交；全部 collected 或明确失败
- [ ] 每个候选都查得到计划输入、实际输入、模型、参数、费用

---

## Acceptance Criteria
- [ ] 强制中断再重启，任务能恢复，没有重复提交（PRD 成功标准）
- [ ] 重新查询与重新生成分开
- [ ] 计划 / 实际输入、失败 / 被拒原因、预估 / 实际费用全部记录
- [ ] 预算上限生效（人民币口径）
- [ ] 全部测试、类型检查、覆盖率通过

## Completion Checklist
- [ ] 代码照抄上面的模式（文件头、Raw→Row、HttpDeps、ModelError、requireCredential）
- [ ] key 不出现在库、事件、日志、错误消息里
- [ ] 没有自动重提的代码路径（审查时专门查）
- [ ] 文档更新

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 无幂等键 | 已知 | H | 先写库 + 串行提交 + 列表对账 + unknown 交给人 |
| Qwen 列表是整个账号的 | M | M | 时间窗 + 模型过滤 + 去掉库里已有的 id；账号里同时有别的程序在提交同模型时会多匹配 → unknown，交给人 |
| 结果 URL 过期（Qwen 24 h） | M | M | 成功立即下载；过期标 failed 写明原因 |
| 参考图上限 3 | 已知 | M | 取舍规则 + 计划输入记全，界面（5b）标「计划与实际不一致」 |
| MiniMax 按量付费下失败是否收费未写明 | M | L | 实际费用记 null 并注明；冒烟时看账单核对 |
| 真实验证花钱 | H | M | 自动测试全用假供应商；冒烟只在副本上、最小选择、低上限，且先征得同意 |

## Notes / 已定（GATE 1，2026-10-31 用户确认）
1. **地域**：默认国际区（与内置的美元单价一致）。地域与地址写进配置（`~/.config/ai-video-platform/endpoints.json`，缺省即国际区），国内区可选。百炼先用老地址 `https://dashscope-intl.aliyuncs.com`（不需要工作空间 id），配置可改；MiniMax 国际区 `https://api.minimax.io`，国内 `https://api.minimax.cn`。
2. **场景图、道具图**：本阶段不做；关键帧只挂角色锚点，计划输入里记下「想挂但没有」的场景 / 道具参考。另记 backlog #28。
3. **角色视图提示词**：方案 A——在短剧工坊里照 character-refs `core.mjs` 的 5 个视图写常量，提示词 = 角色卡 `image.prompt` + 视图说明，出图走短剧工坊自己的任务状态机。方案 C（character-refs 加「只出提示词」命令、短剧工坊改调它，视图规则只留一份）记 backlog #29。
4. **5b**：生成任务页、候选预览（媒体文件接口、CSP `media-src`）、全貌付费卡片进度、serve 启动时自动恢复、确认后自动开跑——5a 完成后另起计划。

# 编排、打回与需复核

## 一键跑

```bash
cli go <dir>                               # 按依赖一键跑完文本阶段，停在付费前
cli go <dir> --only-stale                  # 只重跑「需复核」的部分
cli go <dir> --only script                 # 只跑一个阶段（不管有没有产物都重跑）
cli go <dir> --concurrency 2 --model-cmd "<命令>"
```

阶段依赖（`src/orchestrate/deps.ts`，数据不写死在流程里）：

| 阶段 | 必须有 | 有就带上 |
|---|---|---|
| outline | — | — |
| cast | outline | — |
| art | outline | cast |
| script | outline | art |
| staging | script、art | outline |
| storyboard | script、staging | outline、cast、art |

- 分层只看「必须有」：`outline` → `cast ∥ art ∥ script` → `staging` → `storyboard`，同层并发（默认 3）。
- 每个阶段这次做什么：**没有产物**就从头跑；**有产物但在需复核矩阵里**就只改受影响的集（在当前版本上改）；都不是就跳过。所以中断后再 `go` 会从断的地方接着跑。
- 某阶段没过（`needs_human` / `failed` / 没挂载）只阻断依赖它的下游，原因写「上游 xxx 未通过」，其余照跑。
- 同一项目同一时刻只允许一条编排在跑；进程中断后，重新 `go` 时把残留的 running 编排标为失败。
- 退出码：全部通过 0；有阶段转人工或被阻断 2；有阶段失败 1。

## 付费前停下

文本层跑完后，平台用 `estimateProject`（见 [models-and-pricing.md](models-and-pricing.md)）估一次后面图片、视频的费用，生成**付费确认单**（`paid_gate`，状态 `awaiting_confirmation`，存估算全文与价格来源）。有阶段没过也照样生成，编排汇总里的 `unfinished` 标出没完成的阶段。新确认单生成时，之前还在等确认的旧单作废。

```bash
cli gates <dir>
```

确认后用 `cli generate <dir>` 按勾选的节点与集生成（到预算上限就停），见 [generation.md](generation.md)。

## 打回

```bash
cli reject <dir> script --ep 3 --note "汽笛提前到陆行远掏砚之前"
cli reject <dir> art --note "渡船船舱再暗一些"
```

- 意见以【作者意见】段进入这次运行的每一遍提示词；当前版本按每一遍切片后作为【底稿】给模型——是「改这一版」，不是从空白重写。
- `--ep` 认集号或集 id，集号按**当前大纲**认。只有剧本、站位、分镜能带 `--ep`（按集负责）；大纲、角色、美术是整份负责的，带了报错。
- 单集重跑只处理这一集，导入时也只对这一集负责：其他集不退役、版本不变、引用不重钉。产物版本库里存的是并回后的整份文档（下游拿它当上游）。并回后的整份再过一次 skill 的门，有问题只提示、不阻断（例如剧本总时长）。
- 每次打回记一条 `revision_request`，运行上记 `revision_request_id`。

## 需复核

```bash
cli matrix <dir>                                 # 阶段 × 集：过期原因、是否已确认、最近一次运行
cli review <dir> staging --ep 3 --keep           # 看过了，保持现状
cli go <dir> --only-stale                        # 或者：只重跑受影响的部分
```

- 底层就是 `stale`（过期现算）：引用方钉着的上游版本已经不是最新。阶段 = 引用方的侧面，集 = 引用方当前版本的所属集；跨集共用的对象（角色卡、美术、站位认图）归到集为空的那一格。
- `review --keep` 记一条复核确认，存当时各过期上游的版本号；当前过期的上游版本都不比快照里的新，这一格就算确认过。上游之后再变，这一格重新出现。**不改动引用表**。
- `--only-stale` 按依赖顺序处理：每层开跑时重新算矩阵，上游刚重跑完产生的新格子也会算进来。上游变了重跑时附给模型的意见是「上游有改动：按新的上游修改这一版，没受影响的内容保持不变」。

## staging-carry 门

分镜每一场**第一段**的 `blocking` 必须照抄站位的开场走位句（`novel-staging blocking` 按站位写出）。分镜配方把每场的走位句放进提示词的【开场走位】段；validate 之后平台再逐场检查（去掉空白后做包含判断），不满足的违规原文是：

> 段 sg_… 的 blocking 没有照抄站位的开场走位：『…』（场次 sc_… 第一段的 blocking 要以这句开头）

和 skill 的 validate 违规一起进修复循环。分镜没写到的场次不查。

## 数据（迁移 v5）

| 表 | 内容 |
|---|---|
| `orchestration` | 模式（all / only-stale / single）、状态（running / done / blocked / failed）、汇总 |
| `revision_request` | 打回：阶段、集、意见、打回时的产物版本 |
| `review_ack` | 复核确认：阶段、集、确认时各上游的版本快照 |
| `paid_gate` | 付费确认单：估算全文、状态 |
| `node_run` 增列 | `orchestration_id`、`episode_key`（只重跑几集时，逗号分隔）、`revision_request_id` |

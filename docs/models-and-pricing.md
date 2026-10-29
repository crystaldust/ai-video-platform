# 模型、预设与费用

## 节点

| 节点 | 能力 | 阶段 |
|---|---|---|
| `text:outline` … `text:storyboard` | 文本 | 六个文本阶段 |
| `image:character-refs` | 图片 | 角色参考图（Phase 5 执行） |
| `image:keyframe` | 图片 | 分镜关键帧（Phase 5 执行） |
| `video:segment` | 视频 | 每段一次视频生成（Phase 5 执行） |

## 预设

仓库内置两套（`presets/`）：

| 预设 | 文本 | 图片 | 视频 |
|---|---|---|---|
| `budget` 小成本验证 | DeepSeek Flash | Qwen-Image 3.0 1K | MiniMax H3-Lite 480P |
| `production` 生产级 | DeepSeek V4 Pro | Qwen-Image 3.0 Pro 2K | MiniMax H3 768P |

- `text:*` 这类通配对整类节点生效，具体节点优先。
- 用户目录 `<配置目录>/presets/<name>.json` 里同名的预设覆盖内置的。
- 预设在使用前校验：模型必须在注册表里（`models`）、能力和节点对得上、参数在允许范围内。

```bash
cli preset use <dir> production
cli model set <dir> text:art deepseek:deepseek-v4-pro     # 只换一个节点
cli model clear <dir> text:art                            # 撤销，回到预设
cli model show <dir>
cli run <dir> outline                                     # 不带 --model-cmd：用 text:outline 节点的模型
```

## 价格与估算

价格按「用户覆盖 `<配置目录>/prices.json` → 拉取缓存 `<配置目录>/prices-cache.json` → 内置 `prices/builtin.json`」取第一个有的。每条都带来源、核对日期和 `verified`（是否在官方页面核对过）。

- 视频（MiniMax H3 系列）和图片（Qwen-Image 3.0）的价格已在官方页面核对（2026-10-29，图片取新加坡国际站价）。
- DeepSeek Flash 的价格来自第三方，标「未核对官方」；DeepSeek V4 Pro 暂无可靠价格，估算显示「无价格」并把合计标为不完整，**不按 0 计**。
- `cli prices refresh` 从 OpenRouter 公开模型列表拉文本价格写进缓存；那是 OpenRouter 的转售价，同样标「未核对官方」。
- 汇率 `prices/fx.json` 是近似值，只用于显示人民币，可在 `<配置目录>/fx.json` 覆盖。

```bash
cli estimate <dir> --preset all      # 两套预设并排，表格在 stderr、JSON 在 stdout
cli prices show --model minimax:MiniMax-H3-Lite
```

估算的依据：已有通过的运行就用它的实际 token；文本阶段每集用量按 Phase 2 真实运行（DeepSeek 跑《渡口》6 集）折算；角色参考图 = 要出图的人物 × 5 张视图；关键帧 = 分镜切数（没有分镜按每集 11–16 切）；视频 = 分镜各段秒数之和（没有分镜按集数 × 单集时长）。每一项的假设都写在结果的 `assumptions` 里。

文本节点运行时，每次模型调用按「用量 × 单价」记下实际费用、计价依据和结束原因（`node_attempt.cost` / `price_ref` / `finish_reason`）；用量或价格缺失就记 null。

## 截断

推理模型的推理 token 也计入输出上限。输出撞上上限（`finish_reason: length`）时，执行器不原样重试：大纲、剧本的分集批次对半拆开再写，拆到一集还截断就转人工，说明需要更大的输出上限或换模型。

## 凭据

读取顺序：环境变量（`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `DASHSCOPE_API_KEY` / `MINIMAX_API_KEY`）→ `<配置目录>/credentials.json` → `<配置目录>/<provider>.key`。

- 配置目录：`$AVP_CONFIG_DIR` > `$XDG_CONFIG_HOME/ai-video-platform` > `~/.config/ai-video-platform`。
- 文件必须是 600 权限，否则拒绝读取。凭据永不写进项目目录或项目库，错误消息里不回显 key。
- `cli cred set <provider>` 只从 stdin 读；`cli cred list` 只显示末 4 位。

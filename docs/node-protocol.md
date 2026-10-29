# 节点协议

平台把 skill 当成有明确输入、输出、校验和版本的节点来执行：不靠对话推进，每次调用都有记录。

## 快速开始

```bash
cli init ~/dramas/duko --name 渡口
cli pack register ~/dramas/duko packs/novel.pack.json --root ~/.claude/skills
cli input ~/dramas/duko 梗概.txt --episodes 6 --seconds 60 --genre 悬疑
cli run ~/dramas/duko outline --model-cmd "claude -p"
cli run ~/dramas/duko script  --model-cmd "claude -p"
cli runs ~/dramas/duko            # 运行记录
cli runs ~/dramas/duko --id 1     # 某次运行的每次尝试（步骤、违规、提示词长度、用量）
```

`--model-cmd` 是任何「从 stdin 读提示词、往 stdout 写结果」的命令；正式的供应商适配器与预设见 Phase 3。命令按空白切分参数、不经过 shell，不支持引号。

## skill 包清单

`packs/<name>.pack.json`：

```json
{
  "name": "novel",
  "requires": { "major": 3 },
  "skills": [
    { "name": "novel-outline", "stage": "outline", "script": "scripts/novel-outline.mjs", "recipe": "novel-outline" },
    { "name": "character-refs", "stage": null, "script": "scripts/character-refs.mjs", "recipe": null }
  ]
}
```

- `name` 是 skill 目录名，注册时到 `--root/<name>/SKILL.md` 读名称与版本（不信清单）。
- `stage` 为 `null` 的 skill 只注册不挂载（例如出图，Phase 5 再接）。
- `script` 必须是 skill 目录内的相对路径；只有提示词的 skill 写 `null`。
- `requires.major`：挂到 outline / art / script / staging / storyboard 的 skill 主版本不能低于它——这些阶段的产物要带稳定 id，平台的键依赖它们。
- 注册时记下 `SKILL.md` 与脚本的 sha256，并无参运行脚本探测它支持哪些子命令（seed / ids / validate / blocking）。
- 有阶段、且该阶段还没挂载的 skill 注册时自动挂上；重新注册升级后的同名 skill 时，挂载自动换到新注册的那份（结果里的 `remounted`）；阶段被别的 skill 占着时不动，只提示。`cli mount <dir> <stage> <skill>` 手动换挂载。同一阶段只挂一个。
- 某个脚本探测不了（挂住、起不来）只算这个 skill 的问题，其他 skill 照常注册。

## 配方

| 配方 | 步骤 |
|---|---|
| `novel-outline` | 骨架（outline-pass.md）→ `validate --stage beats` → 分集（episode-pass.md，每批 ≤10 集）→ `ids --write` → `validate` → 平台门 |
| `novel-script` | 每批 ≤3 集：`seed <outline> --eps a-b` → 写（script-pass.md）→ 合并 → `ids --outline --write` → `validate --outline [--art]` → 平台门 |
| `novel-characters` | `seed <outline>`（名单、分档由大纲定）→ 每个角色一张卡（profile-pass.md + sheet.md + 原文）→ 故事摘要 → 合并 → `validate <cast> <原文>` → 平台门 |
| `novel-art` | `seed <outline>` → 场景（scene-pass.md）→ 道具（prop-pass.md）→ 合并 → `validate [--cast]` → 平台门 |
| `novel-staging` | `seed <script> --art --outline` → 认图（read-pass.md，每个地点一次）→ 每批 ≤3 集排位（staging-pass.md）→ 合并 → `validate --script --art` → 平台门 |
| `novel-storyboard` | `novel-staging blocking` 取每场开场走位句 → 每批 ≤2 集：`seed <script> --eps a-b` → 切镜（storyboard-pass / shot-writing / frame / h3-prompt）→ 合并 → `ids --script --write` → `validate` + **staging-carry 门** → 平台门 |
| `single-pass` | （有 seed 就先 seed）→ 一次写完（SKILL.md 正文 + schema.md + 上游）→（有 ids 就补 id）→（有 validate 就校验）→ 平台门 |

剧本、站位、分镜的配方能只重跑其中几集（打回单集、上游变了只改受影响的集），见 [orchestration.md](orchestration.md)。

**平台门**：用导入时的投影干跑一遍（不写库），投影报的问题当违规；同时复查配方最后一道 skill 质量门，修复后也照样补 id。任何配方最后都过这一道，保证通过的产物既能导入、也满足 skill 的质量门。

## 重试与转人工

- 模型输出取第一个 ```json 代码块（没有就取第一个 `{` 到最后一个 `}`）；解析不了算一条违规，带着违规重问。
- 门不过：把整份当前文档和违规原文交给模型，要求输出改好的整份（保留已有 id），修完先补 id 再查。
- 每道门、每次提问最多 `--max-attempts` 次（默认 3）。用尽就转人工：运行状态 `needs_human`，CLI 退出码 2，留下：
  - `runs/<id>/out/<stage>.json`：最后一版能解析的文档（人要改的就是它）
  - `runs/<id>/out/<stage>.raw.txt`：最后一次解析不了的模型原始输出（有才写）
  - `runs/<id>/violations.txt`：违规清单
- 人工修好后：`cli import <dir> <stage> <修好的文件> --run <id>`，导入成功即结案（状态 `resolved`，关联产物版本）。如果这次运行之后已经有更新的运行通过或结案，拒绝结案——免得旧修复盖掉新结果；确实要用，去掉 `--run` 直接导入。

## 一键模式跳过的人工拍板

SKILL.md 里写给交互式 agent 的「⛔ 用户拍板」在平台里不会停下等人，跳过的点记在运行的 `skipped_human_gates`，全貌界面会显示「这一步没有经过人工确认」。

## 运行目录与记录

- `runs/<id>/in/`：上游产物；`work/`：seed 输出、补 id 的中间文件；`out/`：最后一版。
- 库表：`node_run`（阶段、skill、模型、状态、产物版本、跳过的人工点、错误、进程号）、`node_attempt`（步骤、次数、完整的系统提示与用户提示、输出、违规、用量）。
- 运行记录一建好，之后任何一步出错（建目录、写文件、进度回调、配方、导入）都会收尾为 `failed` 或 `needs_human`，不会卡在 `running`。
- 别的进程留下的 `running` 运行：原进程已不在就标为 `failed`（进程中断）；同一阶段有活着的运行时拒绝再开。进程号被系统复用时认不出来，确认它已经不在跑后用 `cli runs unlock <dir> --id N` 解开。

# 代码评审：shuohao-skills `feat/stable-ids`（3.0.0）

**评审日期**：2026-10-28
**范围**：`5612d2a..5e2494e`，共 10 个提交，66 个文件，+3387 / −651 行
**方式**：正确性、测试质量、文档一致性三路并行评审；MEDIUM 及以上的问题由主会话重新复现
**结论**：**APPROVE with comments**。没有 CRITICAL 或 HIGH 问题。建议合并前修掉 M1–M4，其余问题可以和 M1–M4 一起顺手修。

## 验证

| 检查 | 结果 |
|---|---|
| 7 个 skill 的自测 | 通过：character-refs 233、art 168、characters 337、outline 287、script 193、staging 122、storyboard 406 |
| 报告合并、ids 同步、夹具同步 | 通过：92 / 23 / 58 |
| 按 CHANGELOG 的 5 步迁移 2.x 样例 | 5 步全部 rc=0，checkup 结果：outline 15/15、art 10/10、script 11/11、staging 9/9、storyboard 18/18 |
| 迁移顺序写错时 | 能拦住，提示准确 |
| 对 3.0 文件再跑一次 migrate | 输出逐字节不变 |
| 非 migrate 路径里是否还按位置解析引用 | 没有发现（`ids` 补缺时按集号照抄的情况见 L5） |

## MEDIUM

### M1. export 不校验 id，可以把文件写到 `--out` 之外（已复现）
- `skills/novel-storyboard/scripts/novel-storyboard.mjs:1050-1100`（`exportPack`）、`:2173-2230`（CLI 的 export 分支）
- **场景**：把某段的 `id` 改成 `"../../pwned"`，再运行 `export … --out a/b/out`，结果写出了 `a/pwned/prompt.md`。`ids` 门能识别出这个 id 格式不对，但 export 不跑门。
- **说明**：id 写在模型生成的 JSON 里，属于不可信输入。2.x 的段 id 也有同样的问题，不是这次新引入的；但"导出文件名只用合法 id"正是这次改造的目标之一。
- **修复**：在 `exportPack` 开头校验每段的 `isId(…,'sg')` 和每切的 `isId(…,'ct')`，不通过就 throw。CLI 拷图之前也走一遍同样的校验。补一条 CLI 负例测试，见 T1。

### M2. 插集时新集和旧集撞号，新爽点会被静默挂到旧集（已复现）
- `skills/novel-outline/scripts/novel-outline.mjs:208-218`（`assignOutlineIds`）：`byEp` 里集号重复时，后写入的覆盖先写入的。
- **场景**：在第 2 位插入 `{ep:2}`，同时新增爽点 `{episode:2}`，然后运行 `ids`。爽点的 `episodeRef` 指向旧的第 2 集，`ids` 门全部通过。之后运行 `renumber`，又会按这个错的引用改写集号，错误就固化了。
- **修复**：如果某个集号对应多集，又有缺 `episodeRef` 的爽点需要按这个集号补引用，就 throw，提示先 `renumber`；或者调整 `renumber`，让它在集缺 id 时也能正确运行，并且排在补引用之前。schema.md 里写清楚插集时 `ep` 该怎么写。

### M3. 大纲插集之后，下游的集号缓存没有工具刷新（已核实）
- `skills/novel-outline/references/schema.md:118`、`README.en.md:66` 写着"下游按 id 对账，不受影响"。
- **实际**：大纲 `renumber` 之后，script、staging、storyboard 的 `ids` 门都会点名"集号过期"。这一点是对的，不会静默出错。但这三个 skill 都没有刷新显示编号的命令，`script ids --outline` 也不会改正已有的 `ep`，只能手动一处一处改。
- **影响**：门的检查是对的，但插一集就要手动改下游所有集号，和"根治"的目标不符。
- **修复（二选一）**：给 script、storyboard 加一个 `renumber --outline` 命令（staging 加 `--script`），按上游 id 刷新显示缓存；或者至少把文档改成实际的做法。推荐前者。

### M4. 各 README 的门数改了，门表没补 `ids` 那一行（已核实）
- `skills/novel-script/README.md:20`：标题写 11 道，表里只有 10 行；`README.en.md` 标题还写着 Ten。
- `skills/novel-staging/README.md:20`：标题写 9 道，表里只有 8 行；`README.en.md` 标题还写着 8。
- `skills/novel-outline/README.md:19`：标题写 15 道，表里只有 14 行；`README.en.md:21` 同样只列了 14 项。
- 根目录 `README.md:86` 写的是 "eight gates"，应为 nine（`README.zh.md` 已经改对了）。

### M5. 旧分镜图改名的步骤写得不完整
- `CHANGELOG.md:21` 只写了"按新 manifest 的 label 对照改名"。没写要先运行 `export` 才会生成 manifest，也没写旧文件 `f<k>.png` 对应 `pictures[k-1]`。
- **修复**：把步骤写明，最好附一个改名脚本（或者给 storyboard 加 `migrate-frames <旧目录>` 命令）。

## 测试缺口（按严重度，满分 10）

在 scratchpad 里做了 28 个变异，其中 11 个没被测试抓到。

| # | 严重度 | 缺口 | 建议补的测试 |
|---|---|---|---|
| T1 | 9 | `export` 子命令完全没有 CLI 测试：落盘、`--frames`、`--out`、`--images`、`--protocol` 都没测（变异 M2–M5 都没被抓到） | 在临时目录里跑 export，断言 `o/<sg>/<ct>.png` 存在、`missing` 为空；再加负例：非法 id、非法 protocol、缺 `--script` |
| T2 | 8 | 不带 `--seed` 的 `ids` 随机路径没有测试（改成固定种子也能全部通过） | 两份相同的无 id 输入，分别不带 seed 跑一次，断言两边 id 不相交 |
| T3 | 7 | script 的 `ids --write` 测试是空的（`selftest.mjs:550-553`）：如果 `--write` 没有写盘，这条断言照样成立 | `--write` 之后断言文件内容变了，并且带上 `sc_` / `bt_` id |
| T4 | 6 | `assignStoryboardIds` / `assignScriptIds` 的撞号隔离没有测试 | 用恒定的假 rng，断言 id 互不重复，或者断言撞号时会重抽 |
| T5 | 5 | `ID_RE` 没测过长的 id；`cryptoRng` 没测能不能取到 31 | `isId('sc_'+'a'.repeat(9))` 应为 false；大样本抽样断言能出现 31 |
| T6 | 4 | art 的 props 分支没测 `usage.episodes` 的校验 | `props[0].usage.episodes=[1]` 应报错 |
| T7 | 4 | 多集都缺集 id 时，每集是否抄到了对应的集 id，没有测试 | 两集以上都缺集 id 的输入，逐集断言 |
| T8 | 3 | migrate 遇到反向区间 `beats:[3,1]` 没有测试 | 应报"超出该场" |
| T9 | — | 没有跨 skill 的整链测试，夹具同步只做字节比对 | 可选：outline→…→storyboard 用新生成的 id 跑通一遍 |

## LOW

- **L1** `renumberOutline` 在有集缺 id 时，会把缺 `episodeRef` 的爽点集号改错（`novel-outline.mjs:222-227`，`epOf` 的 key 是 `undefined`）。已复现：第 5 集被改成了第 2 集。修复：过滤掉缺 id 的集，或者直接 throw。和 M2 一起修。
- **L2** art 的 `usage.episodes` 不和大纲对照：格式合法但已经不在大纲里的集 id 能通过校验，render 时显示成 `?`。建议 render 时给出警告。
- **L3** 下游（staging、storyboard）遇到剧本里重复的场 id 或拍 id 时，不再检查，后出现的覆盖先出现的。目前依赖 script 门先跑，影响小。
- **L4** storyboard 的 migrate 不处理 `seedScenes`，留下了过期字段，但没有门会读它。
- **L5** AGENTS.md:10 和 CHANGELOG.md:28 写的是"只有 migrate 按位置查找"，但 `ids` 补缺时也会按集号照抄集 id。改一下文档的措辞即可。
- **L6** `skills/novel-storyboard/README.en.md:48` 还残留 "scene index"。
- **L7** 覆盖门的标题还写着"连续"（`novel-storyboard.mjs:905`、`:1136`），文档里已经去掉了。
- **L8** CHANGELOG.md:30 写的 `--seed` 适用范围过宽：art 和 staging 的 migrate 不分配 id，传了 `--seed` 会被静默忽略。
- **L9** `skills/novel-art/references/report-style.md:27` 写的门数是 11（应为 10）。这是旧错，不在本次 diff 里，顺手修掉。
- **L10** 新增文案里有十来处单字"用"，违反 AGENTS.md 的单字词规则：AGENTS.md:10，CHANGELOG.md:5/36/48，novel-art SKILL.md:109，novel-storyboard SKILL.md:44/105，novel-storyboard schema.md:23/96，novel-outline schema.md:110。AGENTS.md 里那条新规则自己的标题"身份用 id，不用位置"也在其中。

## 已确认没有问题的地方

- 五份 `ids.mjs` 逐字节相同。`newId` 会避开已有 id，`assignIds` 不改入参，`seededRng` 结果确定，`collectIds` 会对整份文档去重。
- 各 skill 的 `ids` 门都能拦住：重复 id、格式错误、缺失、跨集或跨场的引用、编号缓存和 id 不一致、`hookBeat` 指到别的集。
- storyboard 的覆盖门能报出重复认领、漏拍、乱序、认领了别场的拍；剧本插入一拍后，只有新的那一拍被点名。
- 所有 migrate 都是幂等的，不改入参，报错时会点名出错的条目。

## 修复结果（shuohao-skills `dfff5b5`）

全部问题都已修复（M1–M5、T1–T8、L1–L10），T9（整链测试）没有做，原因见下。

- **M1**：新增 `assertExportIds`，`exportPack` 和 CLI 拷图前都调用。
- **M2 / L1**：集号和位置对不上时，`ids` 不再按集号补爽点归属；`renumber` 只对照已有 id 的集。
- **M3**：新增 `renumberScript`、`renumberStaging`、`renumberStoryboard` 三个函数和对应的 CLI `renumber` 命令。在样例副本上走完插集全流程（大纲插集 → renumber → ids → 下游三个 renumber），之后 script、staging、storyboard 的 checkup 全部通过。
- **M4 / M5 / L5–L10**：文档已改；CHANGELOG 里的改名脚本照字面跑通。
- **L2**：`render --outline` 遇到大纲里没有的集 id 时打印警告。**L3**：staging、storyboard 的 `ids` 门会查剧本里的重复 id。**L4**：migrate 按剧本重新生成 `seedScenes` 底稿。
- **测试**：outline 287→293、script 193→206、staging 122→131、storyboard 406→440、art 168→173、ids 同步 23→25。13 处修复逐一撤掉，每一处都会被测试发现。
- **T9 没做**：每个 skill 必须能单独拷走，整链测试只能放在仓库根目录。现在的夹具同步测试加上各 skill 的上游夹具测试已经覆盖了契约，等真出现跨 skill 的回归再加。

**复现脚本**：`/private/tmp/claude-502/-Users-lance-Development-ai-ai-video-platform/c2ddd2c1-a7a5-42d8-b142-d850889f4eaf/scratchpad/review-correctness/`、`…/review-tests/`、`…/review-docs/`

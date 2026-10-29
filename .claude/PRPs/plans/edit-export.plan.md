# Plan: 基础剪辑与导出（PRD Phase 7）

## Summary
用已选用且合格的候选自动拼出每集的剪辑：镜序按分镜段顺序，入出点默认整段、可调；字幕从剧本台词按分镜的配音对齐生成；声音轨包括视频自带声音和可选的背景音乐。剪辑版本只追加，每个片段钉在具体候选上——改选 082 后生成新的剪辑版本，旧剪辑原样保留。用外部 ffmpeg 渲染成片，导出后核验时长、规格、哈希，并把成片作为素材入库。

## User Story
作为作者，我希望选定素材后平台自动拼出可看的一集，改选某个镜头的版本后重新导出就自动用上新版，从而不用手工在剪辑软件里替换片段。

## Problem → Solution
选定素材后还要手工剪辑、替换 → 剪辑数据由选用自动生成，渲染一条命令完成，版本可追溯。

## Metadata
- **Complexity**: Large
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`
- **PRD Phase**: Phase 7 基础剪辑与导出
- **Depends**: Phase 5（候选素材）；与 Phase 6 并行，但只接受 `usableForEdit` 的候选（Phase 6 定义；若 Phase 6 未完成，临时规则为「collected ∧ 被选用」，Phase 6 合并后收紧）
- **Estimated Files**: ~18

---

## UX Design
```
剪辑 › 第 01 集 › 剪辑 v2（因为改选 082 自动生成，v1 保留）
时间轴：[081 v1 0–12s][082 v2 0–12s][083 v1 0–11s] …   合计 57.0 s（目标 45–60）
字幕：31 条（来自剧本台词，按分镜配音对齐）  音乐：渡口-雾.mp3（-18 dB）
[导出成片]  →  ✓ 1080×1920 · H.264 · 57.03 s · sha256 3f9a…（已入素材库）
```
设计稿：Phase 7 开始前在 .pen 补画「剪辑」页（时间轴、字幕列表、导出结果与核验）。

---

## Mandatory Reading
| Priority | File | Why |
|---|---|---|
| P0 | `src/db/schema-v1.ts` 的 edit_version / edit_clip | 已有：版本只追加、片段钉候选、出点 > 入点 |
| P0 | `test/scenario-082.test.ts` | 「旧剪辑保持原样、新剪辑换 082」的既有断言 |
| P0 | Phase 6 计划的 `usableForEdit` | 准入规则 |
| P1 | 上游 `novel-storyboard` 报告中的「配音对齐单」与 `references/h3-prompt.md` | 台词在段内的时间位置 |
| P1 | 上游 `novel-script` 的 `--cast` 台词本 | 说话人与台词 |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| ffmpeg concat / subtitles / amix | ffmpeg.org 文档（实施时确认本机版本） | 统一转码后 concat（不同来源参数可能不一致，不用 `-c copy`）；字幕用 ASS 烧录或 SRT 软字幕二选一；背景音乐 `amix` + `volume`；`ffprobe -show_format -show_streams -of json` 做核验 |
| ffmpeg 许可 | ffmpeg.org/legal.html | 作为外部可执行文件调用，不链接、不分发，不影响平台许可证 |

---

## 关键设计

### 1. 剪辑数据（迁移 v8）
- `edit_version` 增加 `basis`（auto / manual）、`reason`（「改选 082」）、`spec`（分辨率、帧率、字幕方式）。
- 新表：`edit_subtitle(edit_version_id, start_s, end_s, text, speaker, source_ref)`、`edit_audio(edit_version_id, kind music|voice|sfx, media_file_id, start_s, gain_db)`、`render(id, edit_version_id, status, media_file_id, probe JSON, error, created_at)`。
- 片段沿用 `edit_clip`（钉 candidate）。

### 2. 自动拼剪
- `autoAssemble(db, episode)`：按分镜段顺序取每段被选用的 usable 候选；缺候选的段列为「缺口」（不能导出，界面列出）。
- 选用变化检测：当前选用与最新剪辑版本的片段不一致 → 生成新剪辑版本（basis auto，reason 写清哪些段改了），旧版本不动。
- 手动调整入出点 → 新版本（basis manual）。

### 3. 字幕
- 来源：剧本台词（说话人、文本）+ 分镜里该台词所在的切与段内时刻（配音对齐）→ 换算到剪辑时间轴（段在剪辑中的起点 + 段内时刻 − 入点）。
- 超出片段入出点的台词裁掉并在核验里提示。
- 第一版烧录（ASS，字体用设计稿的 Noto Sans SC），可选导出 SRT。

### 4. 渲染与核验
- 检测 ffmpeg / ffprobe（`which` + `-version`），缺失时给安装提示，不崩。
- 每个片段先统一转码到剪辑规格（分辨率、帧率、像素格式、音频采样率），再 concat，再叠字幕与音乐；全部在 `renders/<id>/` 工作目录，参数用数组传给 `execFile`。
- 核验：时长与剪辑总长误差 ≤ 0.1 s；分辨率、编码符合规格；计算 sha256；入素材库；render 记录 probe。

---

## Files to Change
| File | Action |
|---|---|
| `src/db/schema-v8.ts`、`migrations.ts` | CREATE / UPDATE |
| `src/edit/assemble.ts`、`src/edit/subtitles.ts`、`src/edit/render.ts`、`src/edit/verify.ts` | CREATE |
| `src/repo/edits.ts` | CREATE |
| `src/server/routes/edit.ts`、`web/src/pages/Edit.tsx`、`web/src/components/{Timeline,SubtitleList,RenderResult}.tsx` | CREATE |
| `src/cli.ts` | UPDATE（`edit assemble` / `edit show` / `edit trim` / `render` / `renders`） |
| `designs/ai-short-video-platform.pen` | UPDATE（剪辑页） |
| `test/edit-*.test.ts`、`test/fixtures/media/*`（几段 1 s 的测试视频，由 ffmpeg 现场生成，不入库） | CREATE |

## NOT Building
- 外部剪辑软件导出（EDL / FCPXML）——PRD Should，放到第一版之后
- 转场、调色、复杂混音
- 临时配音 / TTS（PRD 开放问题）
- 多集合并导出

---

## Step-by-Step Tasks
1. 迁移 v8 与仓储。
2. 自动拼剪与缺口检测；选用变化 → 新版本。
3. 字幕时间换算（纯函数，重点测试）。
4. ffmpeg 检测与渲染管线（测试里用 `ffmpeg -f lavfi -i testsrc` 现场生成 1 s 片段；本机无 ffmpeg 时相关测试 skip 并明确输出原因）。
5. 核验与入库。
6. CLI、API、设计稿、页面。
7. 文档 `docs/edit-export.md`。

## Testing Strategy
| Test | 期望 |
|---|---|
| 改选 082 | 新剪辑版本只换 082 的片段，旧版本不变（PRD success signal） |
| 准入 | 不合格或未选用的候选不能进剪辑 |
| 缺口 | 有段没有选用 → 不能导出，列出缺哪些段 |
| 字幕换算 | 入点裁剪、跨段、超出出点的台词 |
| 渲染核验 | 时长误差 ≤ 0.1 s、规格正确、sha256 入库 |
| 无 ffmpeg | 清晰报错与安装提示 |

## Validation Commands
```bash
pnpm typecheck && pnpm test && pnpm coverage
```
### Manual Validation（Phase 7 success signal）
- [ ] 改选 082 的版本后，重新导出的成片自动使用新版；旧剪辑版本仍可导出旧成片

## Acceptance Criteria
- [ ] 自动拼剪、字幕、背景音乐、导出、核验全部可用
- [ ] 剪辑版本只追加，片段钉具体候选
- [ ] 测试通过（ffmpeg 相关测试在有 ffmpeg 的环境中执行）

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 不同片段编码参数不一致导致 concat 失败 | H | M | 先统一转码再拼 |
| CI 环境无 ffmpeg | M | L | 渲染测试按环境 skip 并输出原因；纯逻辑（拼剪、字幕）不依赖 ffmpeg |
| 中文字幕字体缺失 | M | M | 指定字体文件路径；核验时检查 ffmpeg 日志中的字体回退警告 |

## Notes
- PRD Should「临时配音先定时长，再生成视频」留给第一版之后。

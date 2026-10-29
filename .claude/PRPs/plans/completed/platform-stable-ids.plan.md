# Plan: 平台改键——集、剧本场次、分镜段、分镜切改用 3.0 稳定 id

## Summary
上游 skill 链 3.0.0 给集、剧本场次、节拍、分镜段、分镜切都分配了稳定 id（`ep_/sc_/bt_/sg_/ct_` + 8 位 Crockford base32）。平台 Phase 1 的这四类对象还在用按位置推算的键（`E01`、`E01-SC02`、`E01-03`、`E01-03.c1`），插一集、插一场就会整体漂移。本计划把这四类键换成上游 id，覆盖范围（退役判断）从"集号"改为"集 id"，并把 duko 夹具换成 3.0 样例。

## Problem → Solution
按位置定键，插入即漂移，退役只能处理删除 → 键就是上游 id，位置和编号只当显示；退役按集 id 判断范围。

## Metadata
- **Complexity**: Medium（约 15 个文件）
- **Source PRD**: `.claude/PRPs/prds/ai-short-drama-platform.prd.md`（Phase 1 的后续修正）
- **起因**: `reports/project-data-layer-report.md` 第 104 行的已知问题；`reports/stable-ids-3-storyboard-wrapup-report.md` 的待办

## 关键决定

| 决定 | 选择 | 理由 |
|---|---|---|
| 键格式 | episode / script_scene / segment / cut 直接用上游 id；C/S/P/B 不变 | 上游已经是身份的唯一来源，平台不再推算 |
| 对象属于哪一集 | `entity_version` 新增 `episode_key` 列（迁移 v2），由投影显式给出 | 新键不再编码集号；退役按集判断需要能查到"这个对象属于哪一集" |
| 站位场次的集 | 投影上下文提供"场次 id → 集 id"（来自库里剧本侧面的当前版本） | staging.json 只有 `sceneRef`，没有集 id；投影保持纯函数，查库放在导入层 |
| payload 里的位置 | 不再往 payload 里塞 `ep`/`index` 这类推算出的位置；顺序由父对象的 `sceneKeys`/`cutKeys` 表达 | 插一集只改显示编号，不应让每个场次都长出新版本、把下游全标成过期 |
| 剧本节拍 | 不建对象，`beatIds` 原样留在切的 payload 里 | Phase 1 没有节拍对象；切 → 段 → 场次的引用已足够判断过期（YAGNI） |
| 旧库 | 迁移 v2 只加列；v1 库里的旧格式键不改写 | Phase 1 尚无真实项目；旧键对象会成为孤儿，重建项目即可（写进报告） |

## Files to Change

| File | Action |
|---|---|
| `src/domain/keys.ts` | 删掉 episodeKey / scriptSceneKey / cutKey / episodeOfKey；四类键的正则改为上游 id |
| `src/domain/types.ts` | `EntityDraft.episode?`；`Coverage.episodes: string[] \| 'all'`；`ProjectionContext.sceneEpisode` |
| `src/db/schema-v2.ts`、`src/db/migrations.ts` | 迁移 v2：`entity_version.episode_key` |
| `src/repo/entities.ts` | 写入 / 读出 episode_key；`liveEntities` 带集；`sceneEpisodeIndex` |
| `src/import/projection.ts` | `entity()` 接受集；`coverEpisodes` 收集 id |
| `src/import/import-artifact.ts` | 按集 id 判断范围；上下文加 sceneEpisode |
| `src/import/projections/{outline,script,staging,storyboard}.ts` | 按 id 定键、按 id 引用 |
| `test/fixtures/duko/*` | 换成 3.0 样例（cast 不变） |
| `test/*.test.ts` | 键改为样例里的 id；新增插集 / 插场不漂移、按集 id 退役的测试 |

## NOT Building
- 剧本节拍对象、art `usage.episodes` 的引用
- v1 旧键的数据迁移
- 显示编号（第 N 集、E01-02）的推算——留给 UI 阶段

## Validation
- `pnpm typecheck`、`pnpm test`、`pnpm coverage`（行 80% / 分支 70% / 函数 80%）
- 新增：在中间插一集 / 插一场后重新导入，原有对象的键和版本不变，下游不报过期

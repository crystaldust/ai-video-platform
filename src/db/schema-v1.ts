// v1 表结构。原则：版本只追加不覆盖；引用钉在被引用方的具体版本上，过期现算不存标记；
// 任务执行、素材合格、被选用三件事分表记录。
export const SCHEMA_V1 = `
CREATE TABLE project_meta (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- skill 产物原文：按阶段只追加
CREATE TABLE artifact_version (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('outline','cast','art','script','staging','storyboard')),
  v INTEGER NOT NULL CHECK (v >= 1),
  doc TEXT NOT NULL CHECK (json_valid(doc)),
  content_hash TEXT NOT NULL,
  skill TEXT,
  source_path TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (stage, v)
) STRICT;

CREATE TABLE entity (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('episode','character','location','prop','beat','script_scene','segment','cut')),
  key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (kind, key)
) STRICT;

CREATE TABLE entity_version (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entity(id),
  facet TEXT NOT NULL CHECK (facet IN ('outline','cast','art','script','staging','storyboard')),
  v INTEGER NOT NULL CHECK (v >= 1),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  content_hash TEXT NOT NULL,
  artifact_version_id INTEGER REFERENCES artifact_version(id),
  -- 1 = 退役：上游产物里已经没有这个对象了。退役也是一个版本（payload 为 null），历史照旧可查
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (entity_id, facet, v)
) STRICT;

-- 引用钉在被引用方的具体版本上；过期现算，不存标记
CREATE TABLE ref (
  id INTEGER PRIMARY KEY,
  from_version_id INTEGER NOT NULL REFERENCES entity_version(id),
  role TEXT NOT NULL,
  to_version_id INTEGER NOT NULL REFERENCES entity_version(id),
  UNIQUE (from_version_id, role, to_version_id)
) STRICT;
CREATE INDEX ref_to ON ref(to_version_id);
CREATE INDEX ref_from ON ref(from_version_id, role);

-- 当前版本可能是退役版本；"现在还有效"要再加 retired = 0
CREATE VIEW current_version AS
  SELECT ev.* FROM entity_version ev
  WHERE ev.v = (SELECT MAX(x.v) FROM entity_version x WHERE x.entity_id = ev.entity_id AND x.facet = ev.facet);

-- 生效的引用：同一版本以同一身份引用同一对象，可能被先后钉过多次（下游重新导入即复核），
-- 只有最新那次钉住的版本算数。不按目标侧面分组：目标侧面会随上游补齐而切换
-- （人物先钉大纲、有了角色卡改钉角色卡），旧侧面那条必须随之失效，否则永远报过期
CREATE VIEW live_ref AS
  SELECT r.* FROM ref r JOIN entity_version tv ON tv.id = r.to_version_id
  WHERE r.id = (
    SELECT MAX(r2.id) FROM ref r2 JOIN entity_version t2 ON t2.id = r2.to_version_id
    WHERE r2.from_version_id = r.from_version_id AND r2.role = r.role AND t2.entity_id = tv.entity_id
  );

-- 素材：内容寻址，rel_path 相对项目目录
CREATE TABLE media_file (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  rel_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  created_at TEXT NOT NULL
) STRICT;

-- 以下为 Phase 5–7 预留：本阶段只建表，场景测试验证它能表达 082 案例
CREATE TABLE generation_task (
  id INTEGER PRIMARY KEY,
  target_version_id INTEGER NOT NULL REFERENCES entity_version(id),
  capability TEXT NOT NULL CHECK (capability IN ('text','image','video','audio')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','submitted','running','succeeded','failed','rejected')),
  provider_task_id TEXT,
  planned_input TEXT NOT NULL CHECK (json_valid(planned_input)),
  actual_input TEXT CHECK (actual_input IS NULL OR json_valid(actual_input)),
  cost_estimate REAL,
  cost_actual REAL,
  currency TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
-- 同一供应商任务 ID 只能落库一次：断线恢复时只能续查，不能重复付费
CREATE UNIQUE INDEX task_provider_id ON generation_task(provider, provider_task_id) WHERE provider_task_id IS NOT NULL;

CREATE TABLE task_event (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES generation_task(id),
  status TEXT NOT NULL,
  detail TEXT CHECK (detail IS NULL OR json_valid(detail)),
  at TEXT NOT NULL
) STRICT;

CREATE TABLE candidate (
  id INTEGER PRIMARY KEY,
  target_entity_id INTEGER NOT NULL REFERENCES entity(id),
  task_id INTEGER REFERENCES generation_task(id),
  media_file_id INTEGER NOT NULL REFERENCES media_file(id),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (target_entity_id, label)
) STRICT;

CREATE TABLE review (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidate(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail','note')),
  at_seconds REAL CHECK (at_seconds IS NULL OR at_seconds >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;

-- 选用只追加，最新一条生效；candidate_id 为 NULL 表示撤销选用
CREATE TABLE selection (
  id INTEGER PRIMARY KEY,
  target_entity_id INTEGER NOT NULL REFERENCES entity(id),
  candidate_id INTEGER REFERENCES candidate(id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE edit_version (
  id INTEGER PRIMARY KEY,
  episode_entity_id INTEGER NOT NULL REFERENCES entity(id),
  v INTEGER NOT NULL CHECK (v >= 1),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (episode_entity_id, v)
) STRICT;

-- 剪辑片段钉在具体候选上：换选不会悄悄改动旧剪辑
CREATE TABLE edit_clip (
  id INTEGER PRIMARY KEY,
  edit_version_id INTEGER NOT NULL REFERENCES edit_version(id),
  position INTEGER NOT NULL CHECK (position >= 1),
  candidate_id INTEGER NOT NULL REFERENCES candidate(id),
  in_s REAL NOT NULL CHECK (in_s >= 0),
  out_s REAL NOT NULL,
  CHECK (out_s > in_s),
  UNIQUE (edit_version_id, position)
) STRICT;

-- 三态：执行（任务状态）/ 合格（最近一条非 note 审阅）/ 选用（该对象最近一条 selection）
CREATE VIEW candidate_state AS
SELECT c.id AS candidate_id, c.target_entity_id, c.label,
  COALESCE(t.status, 'manual') AS exec_status,
  COALESCE((SELECT r.verdict FROM review r WHERE r.candidate_id = c.id AND r.verdict <> 'note'
            ORDER BY r.id DESC LIMIT 1), 'unreviewed') AS qc_status,
  (SELECT s.candidate_id FROM selection s WHERE s.target_entity_id = c.target_entity_id
     ORDER BY s.id DESC LIMIT 1) IS c.id AS selected
FROM candidate c LEFT JOIN generation_task t ON t.id = c.task_id;
`;

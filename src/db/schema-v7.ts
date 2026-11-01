// v7：付费生成的任务状态机（Phase 5）。generation_task 在 v1 只预留了 6 个状态，
// 先写库再请求、崩溃后对账还要「提交中」「已入库」「已取消」「未知」，并记下任务属于哪个节点、哪一集、哪张确认单。
// SQLite 改不了 CHECK，只能重建表：旧数据先抄到临时表 → 删旧表 → 用原名建新表 → 抄回来。
// 外键在迁移事务里关不掉（PRAGMA foreign_keys 事务内无效），所以推迟到提交时检查：
// 删旧表时 task_event、candidate 暂时成了孤行，原样插回父行后又对上了。
// 不用「建新表再改名」：删旧表时记下的孤行，改名不会抵消，提交时照样报外键错。
// candidate_state 视图引用了这张表，删表前先删掉、最后照原样重建。
export const SCHEMA_V7 = `
PRAGMA defer_foreign_keys = ON;
DROP VIEW candidate_state;

CREATE TABLE generation_task_v6_copy AS SELECT * FROM generation_task;
DROP TABLE generation_task;

CREATE TABLE generation_task (
  id INTEGER PRIMARY KEY,
  target_version_id INTEGER NOT NULL REFERENCES entity_version(id),
  capability TEXT NOT NULL CHECK (capability IN ('text','image','video','audio')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  -- planned → submitting（已落库、请求在路上）→ submitted → running → succeeded → collected（已下载入库）
  -- 终态：failed、rejected（内容审核）、cancelled；unknown = 崩溃后对账对出多个可能，交给人
  status TEXT NOT NULL CHECK (status IN ('planned','submitting','submitted','running','succeeded','collected','failed','rejected','cancelled','unknown')),
  provider_task_id TEXT,
  planned_input TEXT NOT NULL CHECK (json_valid(planned_input)),
  actual_input TEXT CHECK (actual_input IS NULL OR json_valid(actual_input)),
  cost_estimate REAL,
  cost_actual REAL,
  currency TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 付费节点（v7 之前的任务没有记，为空）
  node TEXT CHECK (node IS NULL OR node IN ('image:character-refs','image:keyframe','video:segment')),
  episode_key TEXT,
  -- 同一目标下区分任务：角色视图名（front-full…）、切 id、段 id
  label TEXT,
  -- 计划输入规范化后的哈希：同一确认单再执行一次时认出已经建过的任务
  content_fingerprint TEXT,
  paid_gate_id INTEGER REFERENCES paid_gate(id),
  -- 重新生成：指向被重做的那条任务
  attempt_of INTEGER REFERENCES generation_task(id),
  -- 正在提交 / 轮询它的进程：恢复时只处理进程已经不在的任务
  pid INTEGER,
  submitted_at TEXT,
  provider_status TEXT,
  result_url TEXT
) STRICT;

INSERT INTO generation_task (id, target_version_id, capability, provider, model, status, provider_task_id, planned_input, actual_input,
  cost_estimate, cost_actual, currency, error, created_at, updated_at)
SELECT id, target_version_id, capability, provider, model, status, provider_task_id, planned_input, actual_input,
  cost_estimate, cost_actual, currency, error, created_at, updated_at
FROM generation_task_v6_copy;
DROP TABLE generation_task_v6_copy;

-- 同一供应商任务 ID 只能落库一次：断线恢复时只能续查，不能重复付费
CREATE UNIQUE INDEX task_provider_id ON generation_task(provider, provider_task_id) WHERE provider_task_id IS NOT NULL;
CREATE INDEX task_gate ON generation_task(paid_gate_id, node);

-- 三态：执行（任务状态）/ 合格（最近一条非 note 审阅）/ 选用（该对象最近一条 selection）——同 v1
CREATE VIEW candidate_state AS
SELECT c.id AS candidate_id, c.target_entity_id, c.label,
  COALESCE(t.status, 'manual') AS exec_status,
  COALESCE((SELECT r.verdict FROM review r WHERE r.candidate_id = c.id AND r.verdict <> 'note'
            ORDER BY r.id DESC LIMIT 1), 'unreviewed') AS qc_status,
  (SELECT s.candidate_id FROM selection s WHERE s.target_entity_id = c.target_entity_id
     ORDER BY s.id DESC LIMIT 1) IS c.id AS selected
FROM candidate c LEFT JOIN generation_task t ON t.id = c.task_id;
`;

// v5：编排与重跑。一次「一键跑」是一条 orchestration；打回带意见（revision_request），
// 「看过了，保持现状」记一条复核确认（review_ack，存确认时各上游的版本快照，过期仍是现算）；
// 文本阶段跑完、付费阶段之前停下，生成付费确认单（paid_gate，存估算全文）。
// revision_request 要先建：node_run 的新列引用它。
export const SCHEMA_V5 = `
CREATE TABLE orchestration (
  id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('all','only-stale','single')),
  status TEXT NOT NULL CHECK (status IN ('running','done','blocked','failed')),
  -- 执行它的进程：重启时只把进程已经不在的 running 标为失败
  pid INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT CHECK (summary IS NULL OR json_valid(summary))
) STRICT;

CREATE TABLE revision_request (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('outline','cast','art','script','staging','storyboard')),
  -- NULL = 整个阶段
  episode_key TEXT,
  note TEXT NOT NULL,
  base_artifact_version_id INTEGER REFERENCES artifact_version(id),
  created_at TEXT NOT NULL
) STRICT;

ALTER TABLE node_run ADD COLUMN orchestration_id INTEGER REFERENCES orchestration(id);
ALTER TABLE node_run ADD COLUMN episode_key TEXT;
ALTER TABLE node_run ADD COLUMN revision_request_id INTEGER REFERENCES revision_request(id);

-- 只追加：同一 (阶段, 集) 最新一条生效
CREATE TABLE review_ack (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('outline','cast','art','script','staging','storyboard')),
  episode_key TEXT,
  -- {"<kind>/<key>/<facet>": 确认时那个上游的版本号, …}
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE paid_gate (
  id INTEGER PRIMARY KEY,
  orchestration_id INTEGER REFERENCES orchestration(id),
  status TEXT NOT NULL CHECK (status IN ('awaiting_confirmation','confirmed','cancelled')),
  estimate TEXT NOT NULL CHECK (json_valid(estimate)),
  selection TEXT CHECK (selection IS NULL OR json_valid(selection)),
  budget_cap REAL,
  currency TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
) STRICT;
`;

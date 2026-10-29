// v3：节点协议。项目输入（梗概 / 小说 + 参数）、skill 包与挂载、节点运行与每次尝试。
// 全部只追加：输入、挂载取最新一条；运行的每次模型调用都留完整提示词和输出，方便追溯。
export const SCHEMA_V3 = `
CREATE TABLE project_input (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('synopsis','novel')),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  params TEXT NOT NULL CHECK (json_valid(params)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE skill_pack (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  registered_at TEXT NOT NULL
) STRICT;

CREATE TABLE skill (
  id INTEGER PRIMARY KEY,
  pack_id INTEGER NOT NULL REFERENCES skill_pack(id),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  stage TEXT CHECK (stage IS NULL OR stage IN ('outline','cast','art','script','staging','storyboard')),
  dir TEXT NOT NULL,
  script TEXT,
  recipe TEXT,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities)),
  skill_md_hash TEXT NOT NULL,
  script_hash TEXT,
  UNIQUE (pack_id, name)
) STRICT;

-- 挂载只追加，同一阶段最新一条生效
CREATE TABLE stage_mount (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('outline','cast','art','script','staging','storyboard')),
  skill_id INTEGER NOT NULL REFERENCES skill(id),
  mounted_at TEXT NOT NULL
) STRICT;

CREATE TABLE node_run (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('outline','cast','art','script','staging','storyboard')),
  skill_id INTEGER NOT NULL REFERENCES skill(id),
  model TEXT NOT NULL,
  input_id INTEGER REFERENCES project_input(id),
  status TEXT NOT NULL CHECK (status IN ('running','passed','needs_human','failed','resolved')),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  artifact_version_id INTEGER REFERENCES artifact_version(id),
  skipped_human_gates TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skipped_human_gates)),
  error TEXT,
  -- 执行它的进程：重启时只把进程已经不在的 running 标为失败，不误伤正在跑的
  pid INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;

CREATE TABLE node_attempt (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES node_run(id),
  step TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 1),
  system_prompt TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  output TEXT,
  violations TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(violations)),
  usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
  started_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;
CREATE INDEX node_attempt_run ON node_attempt(run_id);
`;

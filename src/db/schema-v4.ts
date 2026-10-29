// v4：模型选择与费用。项目用哪套预设、哪些节点单独覆盖（都只追加，最新一条生效）；
// 每次模型调用记下实际费用与计价依据（哪条价格、哪个来源、哪天核对的）。
export const SCHEMA_V4 = `
CREATE TABLE project_preset (
  id INTEGER PRIMARY KEY,
  preset TEXT NOT NULL,
  set_at TEXT NOT NULL
) STRICT;

-- model 为 NULL 表示撤销覆盖，回到预设
CREATE TABLE node_model_override (
  id INTEGER PRIMARY KEY,
  node TEXT NOT NULL,
  model TEXT,
  params TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params)),
  set_at TEXT NOT NULL
) STRICT;

ALTER TABLE node_attempt ADD COLUMN cost REAL;
ALTER TABLE node_attempt ADD COLUMN cost_currency TEXT;
ALTER TABLE node_attempt ADD COLUMN price_ref TEXT;
ALTER TABLE node_attempt ADD COLUMN finish_reason TEXT;
`;

// v2：对象版本记下所属集（集的稳定 id）。
// 3.0 起场次、分镜段、分镜切的键不再编码集号，退役要按集判断范围，只能把集单独记下来。
// 跨集共用的侧面（人物、场景、站位认图）为 NULL。
export const SCHEMA_V2 = `
ALTER TABLE entity_version ADD COLUMN episode_key TEXT;
CREATE INDEX entity_version_episode ON entity_version(episode_key) WHERE episode_key IS NOT NULL;
`;

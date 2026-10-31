// v6：放弃一条打回意见。打回的运行没跑完（转人工、失败）时，意见没落实，会在全貌里列出来；
// 人决定不要了就记一个放弃时间，只追加列、不删行，意见本身仍留在记录里。
export const SCHEMA_V6 = `
ALTER TABLE revision_request ADD COLUMN dismissed_at TEXT;
`;

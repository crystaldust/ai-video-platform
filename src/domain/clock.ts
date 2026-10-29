/** 落库时间统一用 ISO 8601 UTC 字符串，按字典序即时间序。 */
export const nowIso = (): string => new Date().toISOString();

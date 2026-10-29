// 项目输入：梗概或小说正文 + 改编参数。只追加，最新一条生效；每次运行记下用的是哪一条。
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../domain/clock.ts';
import { sha256 } from '../domain/hash.ts';

export const INPUT_KINDS = ['synopsis', 'novel'] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export interface InputParams {
  /** 总集数 */
  readonly episodes: number;
  /** 单集目标时长（秒） */
  readonly seconds: number;
  /** 题材：决定爽点类型，novel-outline 要求必填 */
  readonly genre: string;
  /** 画幅：分镜与下游出图共同遵守；不给时分镜按 16:9 */
  readonly aspect?: Aspect;
}

export const ASPECTS = ['16:9', '9:16'] as const;
export type Aspect = (typeof ASPECTS)[number];

export interface InputRow {
  readonly id: number;
  readonly kind: InputKind;
  readonly text: string;
  readonly contentHash: string;
  readonly params: InputParams;
  readonly createdAt: string;
}

const LIMITS = { episodes: [1, 200], seconds: [10, 600] } as const;

const inRange = (n: unknown, [lo, hi]: readonly [number, number]): n is number => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;

/** 参数来自命令行或界面：逐项校验，点名出错的字段。 */
export function validateParams(params: Partial<Record<keyof InputParams, unknown>>): InputParams {
  const problems: string[] = [];
  if (!inRange(params.episodes, LIMITS.episodes)) problems.push(`集数必须是 ${LIMITS.episodes.join('–')} 的整数：${String(params.episodes)}`);
  if (!inRange(params.seconds, LIMITS.seconds)) problems.push(`单集时长必须是 ${LIMITS.seconds.join('–')} 秒的整数：${String(params.seconds)}`);
  const genre = typeof params.genre === 'string' ? params.genre.trim() : '';
  if (!genre) problems.push('题材不能为空');
  const aspect = params.aspect;
  if (aspect !== undefined && !(ASPECTS as readonly unknown[]).includes(aspect)) problems.push(`画幅只能是 ${ASPECTS.join(' / ')}：${String(aspect)}`);
  if (problems.length) throw new Error(`输入参数不对：${problems.join('；')}`);
  return { episodes: params.episodes as number, seconds: params.seconds as number, genre, ...(aspect !== undefined ? { aspect: aspect as Aspect } : {}) };
}

export function addInput(db: DatabaseSync, input: { kind: InputKind; text: string; params: InputParams }): InputRow {
  if (!(INPUT_KINDS as readonly string[]).includes(input.kind)) throw new Error(`不认识的输入类型：${input.kind}（可选 ${INPUT_KINDS.join(' / ')}）`);
  const text = input.text.trim();
  if (!text) throw new Error('输入正文不能为空');
  const params = validateParams(input.params);
  const createdAt = nowIso();
  const contentHash = sha256(text);
  const result = db
    .prepare('INSERT INTO project_input (kind, text, content_hash, params, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.kind, text, contentHash, JSON.stringify(params), createdAt);
  return { id: Number(result.lastInsertRowid), kind: input.kind, text, contentHash, params, createdAt };
}

export function currentInput(db: DatabaseSync): InputRow | null {
  const row = db.prepare('SELECT * FROM project_input ORDER BY id DESC LIMIT 1').get() as
    | { id: number; kind: InputKind; text: string; content_hash: string; params: string; created_at: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, kind: row.kind, text: row.text, contentHash: row.content_hash, params: JSON.parse(row.params), createdAt: row.created_at };
}

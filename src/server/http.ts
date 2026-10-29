// HTTP 小工具：统一响应信封、请求体解析、带状态码的错误。路由处理器只做「解析参数 → 调库函数 → 返回数据」。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ImportError } from '../import/import-artifact.ts';

/** 统一响应：成功 { ok: true, data }；失败 { ok: false, error: { message, problems? } }。 */
export type Envelope = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: { readonly message: string; readonly problems?: readonly string[] } };

/** 带状态码、可以直接给用户看的错误。其余错误一律 500，只回通用消息。 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const MAX_BODY_BYTES = 1_000_000;

/** 库函数自己 throw new Error('…') 的业务错误：类型就是 Error，且不带系统错误码。 */
const isPlainError = (e: unknown): e is Error => e instanceof Error && e.constructor === Error && !('code' in e);

export function send(res: ServerResponse, status: number, body: Envelope): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export const ok = (res: ServerResponse, data: unknown): void => send(res, 200, { ok: true, data });

/**
 * 错误 → 响应。HttpError 原样回消息；ImportError 回 400 并带上逐条问题；
 * 库函数直接 throw new Error(...) 的是业务校验（参数不对、状态不允许），回 400 并带消息——它们本来就是写给用户看的中文提示；
 * 其余（TypeError、数据库错误、带 code 的系统错误……）是意外，回 500 通用消息，详情只记服务端日志。
 */
export function sendError(res: ServerResponse, error: unknown, log: (line: string) => void): void {
  if (error instanceof HttpError) return send(res, error.status, { ok: false, error: { message: error.message } });
  if (error instanceof ImportError) return send(res, 400, { ok: false, error: { message: error.message, problems: error.problems } });
  if (isPlainError(error)) return send(res, 400, { ok: false, error: { message: error.message } });
  log(`意外错误：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  send(res, 500, { ok: false, error: { message: '服务器内部错误' } });
}

/** 读 JSON 请求体；超过上限、不是 JSON 对象都报 400。空体当 {}。 */
export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体太大');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, '请求体应该是 JSON 对象');
  return doc as Record<string, unknown>;
}

/** 请求体里的字段校验：必填字符串、可选字符串、正整数。 */
export function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `缺少 ${key}`);
  return v;
}

export function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${key} 应该是字符串`);
  return v;
}

export function int(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (!Number.isInteger(v) || (v as number) < 1) throw new HttpError(400, `${key} 应该是正整数`);
  return v as number;
}

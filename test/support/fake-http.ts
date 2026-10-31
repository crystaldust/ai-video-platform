// 测试共用：可编程的假 HTTP（同 test/models.test.ts 的 fakeHttp），记下每次请求，不碰网络。
import type { HttpDeps } from '../../src/model/openai-compatible.ts';

export type Reply = { status: number; body: unknown; headers?: Record<string, string> } | Error;

export interface FakeHttp extends HttpDeps {
  readonly calls: { url: string; init: RequestInit }[];
  readonly sleeps: number[];
}

export function fakeHttp(replies: Reply[]): FakeHttp {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    random: () => 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = replies.shift();
      if (!r) throw new Error('没有更多预设响应');
      if (r instanceof Error) throw r;
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers ?? {} });
    }) as typeof fetch,
  };
}

export const bodyOf = (call: { init: RequestInit }): Record<string, unknown> => JSON.parse(String(call.init.body)) as Record<string, unknown>;
export const headerOf = (call: { init: RequestInit }, name: string): string | undefined => (call.init.headers as Record<string, string>)[name];

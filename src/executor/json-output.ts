// 从模型输出里取 JSON：依次试标了 json 的代码块、其他代码块、第一个 { 到最后一个 }，取第一个能解析成对象的。
// 模型常在 JSON 前面写一小段别的代码块，字符串里也可能出现 ```，只认第一个块会把有效输出误判成坏的。
// 都解析不了本身就是一条违规，交给修复循环，不抛错。
export type JsonExtraction = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly violation: string };

const FENCES = /```([\w-]*)[^\S\n]*\n([\s\S]*?)\n?```/g;

function candidates(text: string): string[] {
  const blocks = [...text.matchAll(FENCES)].map((m) => ({ lang: (m[1] ?? '').toLowerCase(), body: m[2] ?? '' }));
  const tagged = blocks.filter((b) => b.lang === 'json').map((b) => b.body);
  const others = blocks.filter((b) => b.lang !== 'json').map((b) => b.body);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const braces = start >= 0 && end > start ? [text.slice(start, end + 1)] : [];
  return [...tagged, ...others, ...braces];
}

export function extractJson(text: string): JsonExtraction {
  const list = candidates(text);
  if (!list.length) return { ok: false, violation: '输出不是合法 JSON：没有找到 JSON 代码块或 { … }' };
  let firstProblem = '';
  for (const raw of list) {
    try {
      const value: unknown = JSON.parse(raw);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value };
      firstProblem ||= '顶层必须是对象';
    } catch (error) {
      firstProblem ||= error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, violation: `输出不是合法 JSON：${firstProblem}` };
}

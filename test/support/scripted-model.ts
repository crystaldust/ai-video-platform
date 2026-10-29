// 测试用文本模型：按调用顺序返回预设输出，并记下收到的每个请求，供断言提示词内容。
import type { TextModel, TextRequest, TextResult } from '../../src/model/text-model.ts';

export type Reply = string | ((req: TextRequest) => string);

export class ScriptedTextModel implements TextModel {
  readonly id = 'scripted:test';
  readonly requests: TextRequest[] = [];
  private readonly replies: Reply[];

  constructor(replies: readonly Reply[]) {
    this.replies = [...replies];
  }

  async complete(req: TextRequest): Promise<TextResult> {
    this.requests.push(req);
    const next = this.replies.shift();
    if (next === undefined) throw new Error(`脚本化模型没有更多预设输出了（第 ${this.requests.length} 次调用）`);
    return { text: typeof next === 'function' ? next(req) : next, usage: { inputTokens: req.user.length, outputTokens: null } };
  }
}

/** 包成模型常见的输出格式：一段说明 + json 代码块。 */
export const fenced = (doc: unknown): string => `好的，结果如下：\n\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\`\n`;

/**
 * 按请求内容作答的测试模型：并发跑几个阶段时调用顺序不固定，按提示词里的任务、骨架决定输出。
 * respond 返回 undefined 就报错，免得测试悄悄拿到空输出。
 */
export class RoutedTextModel implements TextModel {
  readonly id = 'scripted:routed';
  readonly requests: TextRequest[] = [];
  private readonly respond: (req: TextRequest, n: number) => string | undefined;

  constructor(respond: (req: TextRequest, n: number) => string | undefined) {
    this.respond = respond;
  }

  async complete(req: TextRequest): Promise<TextResult> {
    this.requests.push(req);
    // 让出一次事件循环，并发的阶段才会真的交错
    await new Promise((r) => setImmediate(r));
    const text = this.respond(req, this.requests.length);
    if (text === undefined) throw new Error(`路由模型不知道怎么回答第 ${this.requests.length} 次调用：${req.user.slice(-200)}`);
    return { text, usage: { inputTokens: req.user.length, outputTokens: 100 } };
  }
}

/** 提示词里某一段的正文（【标题…】到下一个【或结尾）。 */
export function promptSection(user: string, titleStart: string): string | null {
  const i = user.indexOf(`【${titleStart}`);
  if (i < 0) return null;
  const body = user.slice(user.indexOf('\n', i) + 1);
  const next = body.search(/\n\n【/);
  return next < 0 ? body : body.slice(0, next);
}

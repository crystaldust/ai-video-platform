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

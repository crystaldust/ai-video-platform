// 文本模型接口：执行器只认这个。正式的供应商适配器（DeepSeek 等）、预设与计费在 Phase 3 实现同一接口。
export interface TextRequest {
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens?: number;
}

export interface TextUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** 输入里命中缓存的部分（计价更低）；不知道就省略 */
  readonly cachedInputTokens?: number | null;
  /** 推理模型的推理 token，也计入输出上限；不知道就省略 */
  readonly reasoningTokens?: number | null;
}

/** 为什么停：length 表示撞上输出上限被截断，执行器要单独处理，不能原样重试。 */
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'other';

export interface TextResult {
  readonly text: string;
  readonly usage: TextUsage;
  /** 不知道（如命令行模型）就省略 */
  readonly finishReason?: FinishReason;
}

export interface TextModel {
  /** 记进运行记录，例如 "cmd:claude -p"、"deepseek:deepseek-flash" */
  readonly id: string;
  complete(req: TextRequest, signal?: AbortSignal): Promise<TextResult>;
}

export const NO_USAGE: TextUsage = { inputTokens: null, outputTokens: null };

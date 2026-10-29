// 文本模型接口：执行器只认这个。正式的供应商适配器（DeepSeek 等）、预设与计费在 Phase 3 实现同一接口。
export interface TextRequest {
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens?: number;
}

export interface TextUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface TextResult {
  readonly text: string;
  readonly usage: TextUsage;
}

export interface TextModel {
  /** 记进运行记录，例如 "cmd:claude -p"、"deepseek:deepseek-flash" */
  readonly id: string;
  complete(req: TextRequest, signal?: AbortSignal): Promise<TextResult>;
}

export const NO_USAGE: TextUsage = { inputTokens: null, outputTokens: null };

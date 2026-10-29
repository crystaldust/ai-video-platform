// 模型能力声明：按能力分类（文本 / 图片 / 视频），每个模型说清自己能做什么。
// 预设、节点覆盖都要先过这里的校验：模型 id 在不在、能力对不对、参数值在不在允许范围内。
export const CAPABILITIES = ['text', 'image', 'video'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface TextCaps {
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  /** 推理模型：推理 token 也计入输出上限，默认上限取 maxOutputTokens 而不是保守值 */
  readonly reasoning: boolean;
}

export interface ImageCaps {
  /** 能挂几张参考图（关键帧要挂角色、场景参考图，需要 ≥ 1） */
  readonly maxRefImages: number;
}

export interface VideoCaps {
  readonly resolutions: readonly string[];
  readonly durationRange: readonly [number, number];
  readonly modes: readonly ('t2v' | 'i2v' | 'first-last' | 'reference')[];
  readonly maxRefImages: number;
  /** 每个任务免费的参考图张数，超出另计费 */
  readonly freeRefImages: number;
}

interface ModelBase {
  /** "<供应商>:<模型名>"，如 deepseek:deepseek-flash */
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly title: string;
  /** 可选参数及其取值，如 { resolution: ['480P', '768P'] } */
  readonly params?: Readonly<Record<string, readonly string[]>>;
}

export type ModelInfo =
  | (ModelBase & { readonly capability: 'text'; readonly caps: TextCaps; readonly baseUrl: string })
  | (ModelBase & { readonly capability: 'image'; readonly caps: ImageCaps })
  | (ModelBase & { readonly capability: 'video'; readonly caps: VideoCaps });

/** 平台里要选模型的位置。文本节点与阶段一一对应；图片、视频节点在 Phase 5 执行。 */
export const NODES = [
  'text:outline',
  'text:cast',
  'text:art',
  'text:script',
  'text:staging',
  'text:storyboard',
  'image:character-refs',
  'image:keyframe',
  'video:segment',
] as const;
export type Node = (typeof NODES)[number];

export const isNode = (x: unknown): x is Node => (NODES as readonly unknown[]).includes(x);
export const capabilityOfNode = (node: Node): Capability => node.split(':')[0] as Capability;

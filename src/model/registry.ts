// 内置模型清单与文本、图片、视频模型工厂。能力数值来自供应商文档（查询于 2026-10-29，图片、视频 2026-10-31 复核），价格不在这里，见 prices/。
import { findCredential, isProvider, requireCredential, type CredentialOptions } from '../config/credentials.ts';
import type { ModelInfo } from './capabilities.ts';
import { CommandTextModel } from './command-model.ts';
import { mediaEndpoint } from '../config/endpoints.ts';
import { DashScopeImageModel } from './dashscope-image.ts';
import type { ImageModel, VideoModel } from './media-model.ts';
import { MiniMaxVideoModel } from './minimax-video.ts';
import { defaultHttpDeps, OpenAICompatibleTextModel, type HttpDeps } from './openai-compatible.ts';
import type { TextModel } from './text-model.ts';

const H3_MODES = ['t2v', 'i2v', 'first-last', 'reference'] as const;

export const MODELS: readonly ModelInfo[] = [
  // DeepSeek：OpenAI 兼容；flash 由 DeepSeek-V4.1-Flash 提供，是推理模型（推理 token 计入输出上限）
  { id: 'deepseek:deepseek-flash', provider: 'deepseek', model: 'deepseek-flash', title: 'DeepSeek Flash', capability: 'text', baseUrl: 'https://api.deepseek.com', caps: { contextTokens: 128_000, maxOutputTokens: 32_768, reasoning: true } },
  { id: 'deepseek:deepseek-v4-pro', provider: 'deepseek', model: 'deepseek-v4-pro', title: 'DeepSeek V4 Pro', capability: 'text', baseUrl: 'https://api.deepseek.com', caps: { contextTokens: 128_000, maxOutputTokens: 32_768, reasoning: true } },
  // 阿里云百炼 Qwen-Image 3.0：按张计费，输入图片（参考图）另按张计费，同一个模型既能文生图也能挂参考图
  // 参考图最多 3 张（百炼文档 2026-10-31）
  { id: 'dashscope:qwen-image-3.0', provider: 'dashscope', model: 'qwen-image-3.0', title: 'Qwen-Image 3.0', capability: 'image', params: { size: ['1k', '2k'] }, caps: { maxRefImages: 3 } },
  { id: 'dashscope:qwen-image-3.0-pro', provider: 'dashscope', model: 'qwen-image-3.0-pro', title: 'Qwen-Image 3.0 Pro', capability: 'image', params: { size: ['1k', '2k'] }, caps: { maxRefImages: 3 } },
  // MiniMax H3：按输出秒计费；时长 4–15 秒正好对应分镜「段 ≤ 15 秒」
  { id: 'minimax:MiniMax-H3', provider: 'minimax', model: 'MiniMax-H3', title: 'MiniMax H3', capability: 'video', params: { resolution: ['768P', '2K'] }, caps: { resolutions: ['768P', '2K'], durationRange: [4, 15], modes: H3_MODES, maxRefImages: 9, freeRefImages: 5 } },
  { id: 'minimax:MiniMax-H3-Lite', provider: 'minimax', model: 'MiniMax-H3-Lite', title: 'MiniMax H3 Lite', capability: 'video', params: { resolution: ['480P', '768P'] }, caps: { resolutions: ['480P', '768P'], durationRange: [4, 15], modes: H3_MODES, maxRefImages: 9, freeRefImages: 5 } },
];

const CMD_PREFIX = 'cmd:';

export function findModel(id: string): ModelInfo {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`不认识的模型：${id}（可选 ${MODELS.map((x) => x.id).join(' / ')}，或 cmd:<命令>）`);
  return m;
}

export const isCommandModel = (id: string): boolean => id.startsWith(CMD_PREFIX);

export interface TextModelOptions extends CredentialOptions {
  readonly http?: HttpDeps;
}

/** 按模型 id 造一个文本模型：cmd:<命令> 走命令行模型，其余走注册表里的供应商适配器。 */
export function createTextModel(id: string, opts: TextModelOptions = {}): TextModel {
  if (isCommandModel(id)) return new CommandTextModel(id.slice(CMD_PREFIX.length));
  const info = findModel(id);
  if (info.capability !== 'text') throw new Error(`${id} 是${info.capability === 'image' ? '图片' : '视频'}模型，不能用在文本节点`);
  if (!isProvider(info.provider)) throw new Error(`${id} 的供应商 ${info.provider} 没有凭据配置项`);
  const key = requireCredential(info.provider, opts);
  return new OpenAICompatibleTextModel(info, key, opts.http ?? defaultHttpDeps);
}

/** 这个模型的凭据配好了没有（不读出 key 本身给调用方）。 */
export function hasCredentialFor(id: string, opts: CredentialOptions = {}): boolean {
  if (isCommandModel(id)) return true;
  const info = findModel(id);
  return isProvider(info.provider) && findCredential(info.provider, opts) !== null;
}

/** 按模型 id 造图片模型（付费节点 image:*）：地址按 endpoints.json 的地域，凭据按供应商。 */
export function createImageModel(id: string, opts: TextModelOptions = {}): ImageModel {
  const info = findModel(id);
  if (info.capability !== 'image') throw new Error(`${id} 不是图片模型`);
  if (info.provider !== 'dashscope') throw new Error(`图片供应商 ${info.provider} 还没有接入`);
  return new DashScopeImageModel(info.model, requireCredential('dashscope', opts), mediaEndpoint('dashscope', opts), opts.http ?? defaultHttpDeps);
}

/** 按模型 id 造视频模型（付费节点 video:*）。 */
export function createVideoModel(id: string, opts: TextModelOptions = {}): VideoModel {
  const info = findModel(id);
  if (info.capability !== 'video') throw new Error(`${id} 不是视频模型`);
  if (info.provider !== 'minimax') throw new Error(`视频供应商 ${info.provider} 还没有接入`);
  return new MiniMaxVideoModel(info.model, requireCredential('minimax', opts), mediaEndpoint('minimax', opts), opts.http ?? defaultHttpDeps);
}

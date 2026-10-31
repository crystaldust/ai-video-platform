// 图片、视频供应商的接口地址。两家都分国际区、国内区：key 按地域发放、不能跨区，价格也不同。
// 默认国际区（内置价格表是国际区的美元价）；要用国内区，在配置目录的 endpoints.json 里改：
//   { "dashscope": "https://dashscope.aliyuncs.com", "minimax": "https://api.minimax.cn" }
// 百炼新文档推荐工作空间地址（https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com），也可以写在这里。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CredentialOptions } from './credentials.ts';
import { configDir } from './paths.ts';

export const MEDIA_PROVIDERS = ['dashscope', 'minimax'] as const;
export type MediaProvider = (typeof MEDIA_PROVIDERS)[number];

export const DEFAULT_ENDPOINTS: Readonly<Record<MediaProvider, string>> = {
  dashscope: 'https://dashscope-intl.aliyuncs.com',
  minimax: 'https://api.minimax.io',
};

const FILE = 'endpoints.json';

/**
 * 只认两家的官方域名：key 会随每个请求发出去，写错一个字母就是把 key 交给别人。
 * 百炼：国际 / 国内老地址，及工作空间地址 <id>.<地域>.maas.aliyuncs.com；MiniMax：国际、国内。
 */
const OFFICIAL: Readonly<Record<MediaProvider, (host: string) => boolean>> = {
  dashscope: (h) => h === 'dashscope.aliyuncs.com' || h === 'dashscope-intl.aliyuncs.com' || /^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/.test(h),
  minimax: (h) => h === 'api.minimax.io' || h === 'api.minimax.cn' || h === 'api.minimaxi.com',
};

/** 配置里的地址必须是 https、不带路径以外的东西；写错了直接报，免得 key 发到别的地方去。 */
function checkUrl(provider: MediaProvider, raw: unknown): string {
  if (typeof raw !== 'string') throw new Error(`${FILE} 里 ${provider} 的地址应该是字符串`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${FILE} 里 ${provider} 的地址不是合法的 URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${FILE} 里 ${provider} 的地址要用 https`);
  if (url.search || url.hash || url.username || url.password) throw new Error(`${FILE} 里 ${provider} 的地址不能带查询串、锚点或账号`);
  if (url.port || !OFFICIAL[provider](url.hostname)) throw new Error(`${FILE} 里 ${provider} 的地址不是官方域名（${url.hostname}）：key 会随请求发出去，只允许官方地址`);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function mediaEndpoint(provider: MediaProvider, opts: CredentialOptions = {}): string {
  const path = join(opts.dir ?? configDir(opts.env), FILE);
  if (!existsSync(path)) return DEFAULT_ENDPOINTS[provider];
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // 不回显文件内容
    throw new Error(`${FILE} 不是合法的 JSON`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${FILE} 应该是对象：{"dashscope": "https://…", "minimax": "https://…"}`);
  const raw = (doc as Record<string, unknown>)[provider];
  return raw === undefined ? DEFAULT_ENDPOINTS[provider] : checkUrl(provider, raw);
}

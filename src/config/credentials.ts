// 供应商凭据：只在环境变量或本机配置目录里，永不进项目目录或项目库。
// 读取顺序：环境变量 → credentials.json → <provider>.key（单个 key 文件，作者早先手工放的就是这种）。
// 文件必须是 600 权限；错误消息里不回显 key。
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './paths.ts';

export const PROVIDERS = ['deepseek', 'openai', 'dashscope', 'minimax'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ENV_VARS: Readonly<Record<Provider, string>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  minimax: 'MINIMAX_API_KEY',
};

const FILE = 'credentials.json';

export const isProvider = (x: unknown): x is Provider => (PROVIDERS as readonly unknown[]).includes(x);

function assertPrivate(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} 的权限是 ${mode.toString(8)}，凭据文件必须只有自己能读：chmod 600 ${path}`);
}

function readStore(dir: string): Partial<Record<Provider, string>> {
  const path = join(dir, FILE);
  if (!existsSync(path)) return {};
  assertPrivate(path);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // 解析错误的原文会带出文件内容（可能就是 key），只报文件名
    throw new Error(`${path} 不是合法 JSON（内容不显示，以免泄露凭据）`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${path} 不是 JSON 对象`);
  return Object.fromEntries(Object.entries(doc).filter(([k, v]) => isProvider(k) && typeof v === 'string' && v.trim())) as Partial<Record<Provider, string>>;
}

function writeStore(dir: string, store: Partial<Record<Provider, string>>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, FILE);
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  // 已存在的文件 writeFileSync 不会改权限，补一次
  chmodSync(path, 0o600);
}

export type CredentialSource = 'env' | 'file' | 'keyfile';

export interface CredentialLookup {
  readonly key: string;
  readonly source: CredentialSource;
}

export interface CredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly dir?: string;
}

export function findCredential(provider: Provider, opts: CredentialOptions = {}): CredentialLookup | null {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? configDir(env);
  const fromEnv = env[ENV_VARS[provider]]?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const stored = readStore(dir)[provider];
  if (stored) return { key: stored.trim(), source: 'file' };
  const keyFile = join(dir, `${provider}.key`);
  if (existsSync(keyFile)) {
    assertPrivate(keyFile);
    const key = readFileSync(keyFile, 'utf8').trim();
    if (key) return { key, source: 'keyfile' };
  }
  return null;
}

/** 取凭据，没有就报错并提示怎么配。 */
export function requireCredential(provider: Provider, opts: CredentialOptions = {}): string {
  const found = findCredential(provider, opts);
  if (!found) throw new Error(`没有 ${provider} 的凭据：设置环境变量 ${ENV_VARS[provider]}，或运行 cred set ${provider}（从 stdin 读入）`);
  return found.key;
}

export function setCredential(provider: Provider, key: string, opts: CredentialOptions = {}): void {
  const value = key.trim();
  if (!value) throw new Error('凭据不能为空');
  const dir = opts.dir ?? configDir(opts.env ?? process.env);
  writeStore(dir, { ...readStore(dir), [provider]: value });
}

export function removeCredential(provider: Provider, opts: CredentialOptions = {}): boolean {
  const dir = opts.dir ?? configDir(opts.env ?? process.env);
  const store = readStore(dir);
  const had = provider in store;
  if (had) {
    const { [provider]: _removed, ...rest } = store;
    writeStore(dir, rest);
  }
  const keyFile = join(dir, `${provider}.key`);
  const hadKeyFile = existsSync(keyFile);
  if (hadKeyFile) rmSync(keyFile);
  return had || hadKeyFile;
}

/** 只给末 4 位，用于列表显示。 */
export const maskKey = (key: string): string => (key.length <= 4 ? '****' : `····${key.slice(-4)}`);

export function listCredentials(opts: CredentialOptions = {}): { provider: Provider; source: CredentialSource | null; masked: string | null }[] {
  return PROVIDERS.map((provider) => {
    const found = findCredential(provider, opts);
    return { provider, source: found?.source ?? null, masked: found ? maskKey(found.key) : null };
  });
}

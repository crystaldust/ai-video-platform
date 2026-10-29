// 凭据、模型注册表与 OpenAI 兼容适配器：全部用临时目录和假 fetch，不出网、不读真实凭据。
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findCredential, listCredentials, maskKey, removeCredential, requireCredential, setCredential } from '../src/config/credentials.ts';
import { configDir } from '../src/config/paths.ts';
import { ModelError } from '../src/model/errors.ts';
import { OpenAICompatibleTextModel, type HttpDeps } from '../src/model/openai-compatible.ts';
import { createTextModel, findModel, hasCredentialFor } from '../src/model/registry.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'avp-cfg-'));
const noEnv: NodeJS.ProcessEnv = {};

test('配置目录：AVP_CONFIG_DIR > XDG_CONFIG_HOME > ~/.config', () => {
  assert.equal(configDir({ AVP_CONFIG_DIR: '/x' }), '/x');
  assert.equal(configDir({ XDG_CONFIG_HOME: '/xdg' }), '/xdg/ai-video-platform');
  assert.match(configDir({}), /\.config\/ai-video-platform$/);
});

test('凭据：环境变量优先，其次 credentials.json，再次 <provider>.key；列表只显示末 4 位', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'deepseek.key'), 'sk-keyfile-1111\n', { mode: 0o600 });
  assert.deepEqual(findCredential('deepseek', { dir, env: noEnv }), { key: 'sk-keyfile-1111', source: 'keyfile' });
  setCredential('deepseek', ' sk-file-2222 ', { dir, env: noEnv });
  assert.equal(statSync(join(dir, 'credentials.json')).mode & 0o777, 0o600);
  assert.deepEqual(findCredential('deepseek', { dir, env: noEnv }), { key: 'sk-file-2222', source: 'file' });
  assert.deepEqual(findCredential('deepseek', { dir, env: { DEEPSEEK_API_KEY: 'sk-env-3333' } }), { key: 'sk-env-3333', source: 'env' });
  const rows = listCredentials({ dir, env: noEnv });
  assert.deepEqual(rows.find((r) => r.provider === 'deepseek'), { provider: 'deepseek', source: 'file', masked: '····2222' });
  assert.equal(rows.find((r) => r.provider === 'minimax')?.masked, null);
  assert.equal(maskKey('abc'), '****');
  assert.equal(removeCredential('deepseek', { dir, env: noEnv }), true);
  assert.equal(findCredential('deepseek', { dir, env: noEnv }), null);
  assert.throws(() => requireCredential('deepseek', { dir, env: noEnv }), /DEEPSEEK_API_KEY.*cred set deepseek/);
  rmSync(dir, { recursive: true, force: true });
});

test('凭据：权限比 600 宽的文件拒绝读取，错误里不带 key', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ deepseek: 'sk-secret-9999' }));
  chmodSync(join(dir, 'credentials.json'), 0o644);
  assert.throws(() => findCredential('deepseek', { dir, env: noEnv }), (e: Error) => /chmod 600/.test(e.message) && !e.message.includes('sk-secret'));
  assert.throws(() => setCredential('deepseek', '  ', { dir, env: noEnv }), /不能为空/);
  rmSync(dir, { recursive: true, force: true });
});

test('注册表：未知模型列出可选项；图片 / 视频模型不能当文本模型用；cmd: 走命令行模型', () => {
  assert.throws(() => findModel('deepseek:deepseek-chat'), /不认识的模型.*deepseek:deepseek-flash/);
  assert.throws(() => createTextModel('minimax:MiniMax-H3', { env: noEnv, dir: tmp() }), /视频模型，不能用在文本节点/);
  assert.equal(createTextModel('cmd:claude -p').id, 'cmd:claude -p');
  const dir = tmp();
  assert.equal(hasCredentialFor('deepseek:deepseek-flash', { dir, env: noEnv }), false);
  assert.throws(() => createTextModel('deepseek:deepseek-flash', { dir, env: noEnv }), /没有 deepseek 的凭据/);
  assert.equal(createTextModel('deepseek:deepseek-flash', { dir, env: { DEEPSEEK_API_KEY: 'k' } }).id, 'deepseek:deepseek-flash');
});

type Reply = { status: number; body: unknown; headers?: Record<string, string> } | Error;

function fakeHttp(replies: Reply[]): HttpDeps & { calls: { url: string; init: RequestInit }[]; sleeps: number[] } {
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

const flash = findModel('deepseek:deepseek-flash') as Extract<ReturnType<typeof findModel>, { capability: 'text' }>;
const ok = (content: string, finish = 'stop') => ({
  status: 200,
  body: { choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 60, completion_tokens_details: { reasoning_tokens: 30 } } },
});

test('适配器：请求体带 system / user 与输出上限；结果带用量、缓存命中、推理 token、结束原因', async () => {
  const http = fakeHttp([ok('```json\n{}\n```')]);
  const r = await new OpenAICompatibleTextModel(flash, 'sk-x', http).complete({ system: 'S', user: 'U' });
  assert.equal(r.text, '```json\n{}\n```');
  assert.equal(r.finishReason, 'stop');
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 50, cachedInputTokens: 60, reasoningTokens: 30 });
  const body = JSON.parse(String(http.calls[0]!.init.body));
  assert.equal(http.calls[0]!.url, 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
  assert.equal(body.max_tokens, flash.caps.maxOutputTokens, '推理模型默认给足输出上限');
  assert.equal((http.calls[0]!.init.headers as Record<string, string>)['Authorization'], 'Bearer sk-x');
});

test('适配器：截断如实带回 finishReason=length', async () => {
  const r = await new OpenAICompatibleTextModel(flash, 'k', fakeHttp([ok('', 'length')])).complete({ system: '', user: '' });
  assert.equal(r.finishReason, 'length');
  assert.equal(r.text, '');
});

test('适配器：429 遵守 Retry-After 后成功；500 连续失败按指数退避后报 server', async () => {
  const http = fakeHttp([{ status: 429, body: 'slow down', headers: { 'retry-after': '2' } }, ok('{}')]);
  assert.equal((await new OpenAICompatibleTextModel(flash, 'k', http).complete({ system: '', user: '' })).text, '{}');
  assert.deepEqual(http.sleeps, [2000]);
  const bad = fakeHttp(Array.from({ length: 4 }, () => ({ status: 500, body: 'boom' })));
  await assert.rejects(new OpenAICompatibleTextModel(flash, 'k', bad).complete({ system: '', user: '' }), (e: ModelError) => e.kind === 'server' && e.status === 500);
  assert.deepEqual(bad.sleeps, [1000, 2000, 4000], '重试 3 次，指数退避');
});

test('适配器：401 立即失败、提示配凭据且不带 key；400 不重试；网络错误重试后报 network；非 JSON 报 server', async () => {
  const auth = fakeHttp([{ status: 401, body: 'bad key' }]);
  await assert.rejects(new OpenAICompatibleTextModel(flash, 'sk-secret', auth).complete({ system: '', user: '' }), (e: ModelError) => e.kind === 'auth' && /cred set deepseek/.test(e.message) && !e.message.includes('sk-secret'));
  assert.equal(auth.calls.length, 1);
  const badReq = fakeHttp([{ status: 400, body: 'nope' }]);
  await assert.rejects(new OpenAICompatibleTextModel(flash, 'k', badReq).complete({ system: '', user: '' }), (e: ModelError) => e.kind === 'bad_request');
  assert.equal(badReq.calls.length, 1);
  const net = fakeHttp(Array.from({ length: 4 }, () => new TypeError('fetch failed')));
  await assert.rejects(new OpenAICompatibleTextModel(flash, 'k', net).complete({ system: '', user: '' }), (e: ModelError) => e.kind === 'network');
  assert.equal(net.calls.length, 4);
  // 200 但不是 JSON（代理出错页之类）算服务端错误，同样重试，用尽后报 server
  const html = fakeHttp(Array.from({ length: 4 }, () => ({ status: 200, body: '<html>' })));
  await assert.rejects(new OpenAICompatibleTextModel(flash, 'k', html).complete({ system: '', user: '' }), (e: ModelError) => e.kind === 'server' && /不是 JSON/.test(e.message));
  assert.equal(html.calls.length, 4);
});

test('凭据文件以 600 创建后内容可读回', () => {
  const dir = tmp();
  setCredential('minimax', 'mm-1', { dir, env: noEnv });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')), { minimax: 'mm-1' });
  rmSync(dir, { recursive: true, force: true });
});

test('评审修复：凭据文件不是合法 JSON 时只报文件名，不带出内容', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'credentials.json'), 'sk-test-abcdef', { mode: 0o600 });
  assert.throws(() => findCredential('deepseek', { dir, env: noEnv }), (e: Error) => /不是合法 JSON/.test(e.message) && !e.message.includes('sk-test'));
  rmSync(dir, { recursive: true, force: true });
});

test('评审修复：Retry-After 超过上限不等，直接报限流', async () => {
  const http = fakeHttp([{ status: 429, body: 'later', headers: { 'retry-after': '3600' } }]);
  await assert.rejects(new OpenAICompatibleTextModel(flash, 'k', http).complete({ system: '', user: '' }), (e: ModelError) => e.kind === 'rate' && /3600 秒，超过上限/.test(e.message));
  assert.deepEqual(http.sleeps, []);
});

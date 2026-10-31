// 百炼 Qwen-Image 与 MiniMax 视频适配器：请求格式、状态映射、错误分类——尤其是提交绝不自动重试。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mediaEndpoint } from '../src/config/endpoints.ts';
import { DashScopeImageModel } from '../src/model/dashscope-image.ts';
import { SubmitError } from '../src/model/media-model.ts';
import { MiniMaxVideoModel } from '../src/model/minimax-video.ts';
import { createImageModel, createVideoModel } from '../src/model/registry.ts';
import { bodyOf, fakeHttp, headerOf } from './support/fake-http.ts';

const KEY = 'sk-secret-123';
const REF = { sha256: 'a'.repeat(64), dataUri: 'data:image/png;base64,AAAA' };
const image = (replies: Parameters<typeof fakeHttp>[0]) => {
  const http = fakeHttp(replies);
  return { http, model: new DashScopeImageModel('qwen-image-3.0', KEY, 'https://dashscope-intl.aliyuncs.com', http) };
};
const video = (replies: Parameters<typeof fakeHttp>[0]) => {
  const http = fakeHttp(replies);
  return { http, model: new MiniMaxVideoModel('MiniMax-H3-Lite', KEY, 'https://api.minimax.io', http) };
};
const rejectsKind = async (p: Promise<unknown>, kind: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof SubmitError && e.kind === kind && !e.message.includes(KEY));
};

test('百炼提交：异步头、messages 里先参考图后文字、size 用 *；实际输入里参考图换成 sha256、没有 key', async () => {
  const { http, model } = image([{ status: 200, body: { output: { task_id: 'ds-1', task_status: 'PENDING' }, request_id: 'r' } }]);
  const got = await model.submit({ prompt: '雾里的码头', negativePrompt: '文字', size: '928*1664', refs: [REF] });
  assert.equal(got.providerTaskId, 'ds-1');
  const call = http.calls[0]!;
  assert.equal(call.url, 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/image-generation/generation');
  assert.equal(headerOf(call, 'X-DashScope-Async'), 'enable');
  assert.equal(headerOf(call, 'authorization'), `Bearer ${KEY}`);
  const body = bodyOf(call);
  assert.deepEqual(body['input'], { messages: [{ role: 'user', content: [{ image: REF.dataUri }, { text: '雾里的码头' }] }] });
  assert.deepEqual(body['parameters'], { size: '928*1664', n: 1, prompt_extend: false, watermark: false, negative_prompt: '文字' });
  assert.ok(!JSON.stringify(got.actualInput).includes('base64'), '实际输入不放图片本身');
  assert.ok(JSON.stringify(got.actualInput).includes(REF.sha256));
  assert.ok(!JSON.stringify(got.actualInput).includes(KEY));
});

test('百炼提交的错误：网络错误、超时、5xx → 结果未知且只发一次；429 → 限流；审核 → rejected；其余 4xx → invalid', async () => {
  for (const reply of [new Error('ECONNRESET'), { status: 503, body: 'busy' }]) {
    const { http, model } = image([reply, { status: 200, body: { output: { task_id: 'never' } } }]);
    await rejectsKind(model.submit({ prompt: 'p', size: '1024*1024', refs: [] }), 'unknown');
    assert.equal(http.calls.length, 1, '提交绝不自动重试');
  }
  await rejectsKind(image([{ status: 429, body: { code: 'Throttling.RateQuota' }, headers: { 'retry-after': '3' } }]).model.submit({ prompt: 'p', size: '1024*1024', refs: [] }), 'rate');
  await rejectsKind(image([{ status: 400, body: { code: 'DataInspectionFailed', message: 'inappropriate' } }]).model.submit({ prompt: 'p', size: '1024*1024', refs: [] }), 'rejected');
  await rejectsKind(image([{ status: 400, body: { code: 'IPInfringementSuspect', message: 'x' } }]).model.submit({ prompt: 'p', size: '1024*1024', refs: [] }), 'rejected');
  await rejectsKind(image([{ status: 401, body: { code: 'InvalidApiKey' } }]).model.submit({ prompt: 'p', size: '1024*1024', refs: [] }), 'invalid');
  await rejectsKind(image([{ status: 200, body: 'not json' }]).model.submit({ prompt: 'p', size: '1024*1024', refs: [] }), 'unknown');
});

test('百炼查询：状态映射、结果地址与用量；审核失败 → rejected；查询会重试', async () => {
  const ok = image([
    { status: 503, body: 'busy' },
    { status: 200, body: { output: { task_id: 'ds-1', task_status: 'SUCCEEDED', choices: [{ message: { content: [{ image: 'https://oss/x.png' }] } }] }, usage: { output_image_count: 1, input_image_count: 1 } } },
  ]);
  const got = await ok.model.query('ds-1');
  assert.equal(ok.http.calls.length, 2, '查询可以重试');
  assert.equal(ok.http.calls[1]!.url, 'https://dashscope-intl.aliyuncs.com/api/v1/tasks/ds-1');
  assert.deepEqual({ state: got.state, url: got.url, usage: got.usage }, { state: 'succeeded', url: 'https://oss/x.png', usage: { outputImages: 1, inputImages: 1 } });
  const legacy = await image([{ status: 200, body: { output: { task_status: 'SUCCEEDED', results: [{ url: 'https://oss/y.png' }] } } }]).model.query('ds-2');
  assert.equal(legacy.url, 'https://oss/y.png', '旧的 results[].url 也认');
  for (const [s, state] of [['PENDING', 'submitted'], ['RUNNING', 'running'], ['CANCELED', 'cancelled'], ['UNKNOWN', 'unknown']] as const) {
    assert.equal((await image([{ status: 200, body: { output: { task_status: s } } }]).model.query('x')).state, state);
  }
  const failed = await image([{ status: 200, body: { output: { task_status: 'FAILED', code: 'InternalError', message: 'boom' } } }]).model.query('x');
  assert.deepEqual({ state: failed.state, error: failed.error }, { state: 'failed', error: { code: 'InternalError', message: 'boom' } });
  assert.equal((await image([{ status: 200, body: { output: { task_status: 'FAILED', code: 'DataInspectionFailed', message: 'x' } } }]).model.query('x')).state, 'rejected');
});

test('百炼列表：按模型与时间窗（北京时间 YYYYMMDDhhmmss）分页取完', async () => {
  const { http, model } = image([
    { status: 200, body: { data: [{ task_id: 'a', gmt_create: '2026-10-31 20:00:01.000' }], total: 2, total_page: 2 } },
    { status: 200, body: { data: [{ task_id: 'b', gmt_create: 1761912000000 }], total: 2, total_page: 2 } },
  ]);
  const got = await model.listRecent({ since: new Date('2026-10-31T12:00:00Z'), until: new Date('2026-10-31T12:10:00Z') });
  const q = new URL(http.calls[0]!.url).searchParams;
  assert.equal(q.get('start_time'), '20261031200000');
  assert.equal(q.get('end_time'), '20261031201000');
  assert.equal(q.get('model_name'), 'qwen-image-3.0');
  assert.deepEqual(got, [
    { providerTaskId: 'a', createdAt: '2026-10-31T12:00:01.000Z' },
    { providerTaskId: 'b', createdAt: new Date(1761912000000).toISOString() },
  ]);
});

test('MiniMax 提交：文字 + 参考图（reference_image），分辨率、时长、画幅；422 → rejected；网络错误只发一次', async () => {
  const { http, model } = video([{ status: 200, body: { task_id: 'mm-1' } }]);
  const got = await model.submit({ prompt: 'Picture 1 …', refs: [REF, REF], duration: 6, resolution: '480P', ratio: '9:16' });
  assert.equal(got.providerTaskId, 'mm-1');
  const call = http.calls[0]!;
  assert.equal(call.url, 'https://api.minimax.io/v2/video_generation');
  assert.deepEqual(bodyOf(call), {
    model: 'MiniMax-H3-Lite',
    content: [{ type: 'text', text: 'Picture 1 …' }, { type: 'image_url', image_url: { url: REF.dataUri }, role: 'reference_image' }, { type: 'image_url', image_url: { url: REF.dataUri }, role: 'reference_image' }],
    resolution: '480P',
    duration: 6,
    ratio: '9:16',
  });
  assert.ok(!JSON.stringify(got.actualInput).includes('base64'));
  await rejectsKind(video([{ status: 422, body: { type: 'error', error: { type: 'sensitive', message: 'x', http_code: 422 } } }]).model.submit({ prompt: 'p', refs: [], duration: 4, resolution: '480P', ratio: '9:16' }), 'rejected');
  await rejectsKind(video([{ status: 402, body: { type: 'error', error: { message: 'balance' } } }]).model.submit({ prompt: 'p', refs: [], duration: 4, resolution: '480P', ratio: '9:16' }), 'invalid');
  const net = video([new Error('socket hang up'), { status: 200, body: { task_id: 'never' } }]);
  await rejectsKind(net.model.submit({ prompt: 'p', refs: [], duration: 4, resolution: '480P', ratio: '9:16' }), 'unknown');
  assert.equal(net.http.calls.length, 1);
});

test('MiniMax 查询：状态映射、直链与秒数；审核 1026 → rejected', async () => {
  const done = await video([{ status: 200, body: { task: { task_id: 'mm-1', status: 'succeeded', content: { url: 'https://cdn/v.mp4' }, usage: { output_seconds: 6, input_image_count: 2 } } } }]).model.query('mm-1');
  assert.deepEqual({ state: done.state, url: done.url, usage: done.usage }, { state: 'succeeded', url: 'https://cdn/v.mp4', usage: { outputSeconds: 6, inputImages: 2 } });
  for (const [s, state] of [['queued', 'submitted'], ['running', 'running'], ['cancelled', 'cancelled']] as const) {
    assert.equal((await video([{ status: 200, body: { task: { status: s } } }]).model.query('x')).state, state);
  }
  assert.equal((await video([{ status: 200, body: { task: { status: 'failed', error: { code: 1026, message: 'sensitive' } } } }]).model.query('x')).state, 'rejected');
  assert.equal((await video([{ status: 200, body: { task: { status: 'failed', error: { code: 1000, message: 'x' } } } }]).model.query('x')).state, 'failed');
});

test('MiniMax 列表：按模型过滤、分页取完、时间窗外的不要', async () => {
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const { http, model } = video([
    { status: 200, body: { items: [{ task_id: 'a', created_at: at('2026-10-31T12:01:00Z') }, { task_id: 'old', created_at: at('2026-10-30T00:00:00Z') }], total: 3 } },
    { status: 200, body: { items: [{ task_id: 'b' }], total: 3 } },
  ]);
  const got = await model.listRecent({ since: new Date('2026-10-31T12:00:00Z'), until: new Date('2026-10-31T12:10:00Z') });
  assert.equal(new URL(http.calls[0]!.url).searchParams.get('filter.model'), 'MiniMax-H3-Lite');
  assert.deepEqual(got, [
    { providerTaskId: 'a', createdAt: '2026-10-31T12:01:00.000Z' },
    { providerTaskId: 'b', createdAt: null },
  ]);
});

test('地址配置：默认国际区；endpoints.json 可改成国内区；非 https 拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avp-ep-'));
  assert.equal(mediaEndpoint('dashscope', { dir, env: {} }), 'https://dashscope-intl.aliyuncs.com');
  writeFileSync(join(dir, 'endpoints.json'), JSON.stringify({ minimax: 'https://api.minimax.cn/' }));
  assert.equal(mediaEndpoint('minimax', { dir, env: {} }), 'https://api.minimax.cn');
  writeFileSync(join(dir, 'endpoints.json'), JSON.stringify({ minimax: 'http://evil.example' }));
  assert.throws(() => mediaEndpoint('minimax', { dir, env: {} }), /https/);
});

test('注册表：按模型 id 造图片 / 视频模型；没有凭据报 cred set；文本模型不能当图片用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avp-cred-'));
  assert.throws(() => createImageModel('dashscope:qwen-image-3.0', { dir, env: {} }), /cred set dashscope/);
  const env = { DASHSCOPE_API_KEY: KEY, MINIMAX_API_KEY: KEY };
  assert.equal(createImageModel('dashscope:qwen-image-3.0', { dir, env }).model, 'qwen-image-3.0');
  assert.equal(createVideoModel('minimax:MiniMax-H3-Lite', { dir, env }).model, 'MiniMax-H3-Lite');
  assert.throws(() => createImageModel('minimax:MiniMax-H3-Lite', { dir, env }), /不是图片模型/);
  assert.throws(() => createVideoModel('deepseek:deepseek-flash', { dir, env }), /不是视频模型/);
});

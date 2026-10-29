// 预设、项目模型选择、价格来源链、OpenRouter 拉取、费用估算。不出网，用固定价格表。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareEstimates, estimateProject } from '../src/estimate/estimate.ts';
import { checkChoice, loadPresets, parsePreset, presetChoice, BUILTIN_PRESET_DIR } from '../src/presets/presets.ts';
import { fetchOpenRouterPrices } from '../src/pricing/openrouter.ts';
import { loadPriceSources, lookupPrice, parsePriceTable, BUILTIN_PRICES, type PriceSources } from '../src/pricing/prices.ts';
import { clearNodeModel, currentPresetName, resolveNodeModel, setNodeModel, usePreset } from '../src/repo/models.ts';
import { importAll, tempProject } from './helpers.ts';

const NONE = '/nonexistent-avp';
const dirs = { builtin: BUILTIN_PRESET_DIR, user: NONE };
const FX = { usdToCny: 7, checkedAt: '2026-10-29', source: 'test' };

test('内置两套预设通过校验；具体节点优先于通配；用户目录同名预设覆盖内置', () => {
  const [budget] = loadPresets(dirs);
  assert.equal(budget?.name, 'budget');
  assert.equal(presetChoice(budget!, 'text:art')?.model, 'deepseek:deepseek-flash');
  assert.deepEqual(presetChoice(budget!, 'video:segment'), { model: 'minimax:MiniMax-H3-Lite', params: { resolution: '480P' } });
  const user = mkdtempSync(join(tmpdir(), 'avp-preset-'));
  writeFileSync(join(user, 'budget.json'), JSON.stringify({ name: 'budget', nodes: { 'text:*': { model: 'deepseek:deepseek-v4-pro' }, 'text:art': { model: 'deepseek:deepseek-flash' } } }));
  const custom = loadPresets({ builtin: BUILTIN_PRESET_DIR, user }).find((p) => p.name === 'budget')!;
  assert.equal(custom.origin, 'user');
  assert.equal(presetChoice(custom, 'text:outline')?.model, 'deepseek:deepseek-v4-pro');
  assert.equal(presetChoice(custom, 'text:art')?.model, 'deepseek:deepseek-flash');
  rmSync(user, { recursive: true, force: true });
});

test('预设校验：未知模型、能力不匹配、参数越界、未知节点逐条报出', () => {
  assert.throws(
    () => parsePreset({ name: 'bad', nodes: { 'text:*': { model: 'deepseek:deepseek-chat' }, 'video:segment': { model: 'deepseek:deepseek-flash' }, 'image:keyframe': { model: 'dashscope:qwen-image-3.0', params: { size: '8k' } }, 'audio:tts': { model: 'x' } } }, 'builtin', 'bad.json'),
    (e: Error) => /不认识的模型/.test(e.message) && /需要video模型/.test(e.message) && /size 只能是 1k \/ 2k/.test(e.message) && /不认识的节点：audio:tts/.test(e.message),
  );
  assert.deepEqual(checkChoice('text:script', { model: 'cmd:claude -p', params: {} }), []);
  assert.match(checkChoice('video:segment', { model: 'cmd:x', params: {} })[0] ?? '', /不能用命令行模型/);
});

test('项目模型选择：默认 budget；换预设不改代码；节点覆盖优先且可撤销；坏覆盖被拒', () => {
  const { project, cleanup } = tempProject();
  const { db } = project;
  assert.equal(currentPresetName(db), 'budget');
  assert.equal(resolveNodeModel(db, 'text:art', { dirs }).model, 'deepseek:deepseek-flash');
  usePreset(db, 'production', dirs);
  assert.equal(resolveNodeModel(db, 'video:segment', { dirs }).params['resolution'], '768P');
  setNodeModel(db, 'text:art', { model: 'deepseek:deepseek-flash', params: {} });
  assert.deepEqual([resolveNodeModel(db, 'text:art', { dirs }).model, resolveNodeModel(db, 'text:art', { dirs }).from], ['deepseek:deepseek-flash', 'override']);
  assert.equal(resolveNodeModel(db, 'text:art', { dirs, preset: 'production', ignoreOverrides: true }).model, 'deepseek:deepseek-v4-pro');
  clearNodeModel(db, 'text:art');
  assert.equal(resolveNodeModel(db, 'text:art', { dirs }).from, 'preset');
  assert.throws(() => usePreset(db, 'nope', dirs), /没有预设 nope/);
  assert.throws(() => setNodeModel(db, 'text:art', { model: 'minimax:MiniMax-H3', params: {} }), /需要text模型/);
  assert.throws(() => setNodeModel(db, 'audio:x', { model: 'x', params: {} }), /不认识的节点/);
  cleanup();
});

test('价格：内置表每条都有来源与日期；来源链 用户 > 缓存 > 内置；缓存超过 7 天标可能过期；越具体的参数越优先', () => {
  const builtin = parsePriceTable(JSON.parse(readFileSync(BUILTIN_PRICES, 'utf8')), BUILTIN_PRICES);
  assert.ok(builtin.every((e) => e.source && /^\d{4}-\d{2}-\d{2}$/.test(e.checkedAt)));
  const e = (price: number, params?: Record<string, string>) => ({ model: 'm', unit: 'video_second' as const, price, currency: 'USD', source: 's', checkedAt: '2026-10-01', verified: true, ...(params ? { params } : {}) });
  const src: PriceSources = { user: [], cache: [e(2)], cacheFetchedAt: '2026-10-01T00:00:00Z', builtin: [e(3), e(4, { resolution: '480P' })] };
  assert.equal(lookupPrice({ ...src, user: [e(1)] }, 'm', 'video_second')?.layer, 'user');
  const cached = lookupPrice(src, 'm', 'video_second', {}, new Date('2026-10-20'));
  assert.deepEqual([cached?.layer, cached?.stale], ['cache', true]);
  assert.equal(lookupPrice({ ...src, cache: [] }, 'm', 'video_second', { resolution: '480P' })?.entry.price, 4);
  assert.equal(lookupPrice(src, 'nope', 'video_second'), null);
  assert.throws(() => parsePriceTable({ entries: [{ model: 'm', unit: 'image', price: -1 }] }, 'x.json'), /字段不全或不合法/);
});

test('OpenRouter：字符串单价换算成每百万；缺失与非数字记问题不中断；HTTP 错误报错', async () => {
  const wanted = [{ model: 'deepseek:deepseek-flash', unit: 'token_in' as const, price: 0, currency: 'USD', source: 's', checkedAt: '2026-10-29', verified: false, openrouterId: 'ds/flash' }, { model: 'x:y', unit: 'token_in' as const, price: 0, currency: 'USD', source: 's', checkedAt: '2026-10-29', verified: false, openrouterId: 'missing/one' }];
  const fake = (async () => new Response(JSON.stringify({ data: [{ id: 'ds/flash', pricing: { prompt: '0.0000003', completion: 'abc' } }] }))) as unknown as typeof fetch;
  const r = await fetchOpenRouterPrices(wanted, fake, '2026-10-29');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0]!.price, 0.3);
  assert.equal(r.entries[0]!.verified, false);
  assert.ok(r.problems.some((p) => p.includes('completion')) && r.problems.some((p) => p.includes('missing/one')));
  await assert.rejects(fetchOpenRouterPrices(wanted, (async () => new Response('x', { status: 503 })) as unknown as typeof fetch), /HTTP 503/);
});

test('估算：渡口全量导入后视频按分镜秒数、关键帧按切数；无价格不按 0 计；两套预设并排', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const prices = loadPriceSources(NONE);
  const budget = estimateProject(project.db, { prices, fx: FX, presetDirs: dirs });
  const video = budget.nodes.find((n) => n.node === 'video:segment')!;
  const kf = budget.nodes.find((n) => n.node === 'image:keyframe')!;
  assert.equal(kf.usage[0]!.qty.low, 34, '渡口分镜 34 切');
  assert.match(video.assumptions[0] ?? '', /分镜各段秒数之和/);
  assert.equal(video.cost!.low, Math.round(video.usage[0]!.qty.low * 0.025 * 1000) / 1000 + Math.round(0 * 1000) / 1000);
  assert.ok(budget.nodes.every((n) => !n.cost || n.cost.low <= n.cost.high));
  assert.equal(budget.incomplete, false);
  const [, production] = compareEstimates(project.db, ['budget', 'production'], { prices, fx: FX, presetDirs: dirs });
  assert.equal(production!.incomplete, true, 'DeepSeek V4 Pro 没有价格：标不完整');
  assert.equal(production!.nodes.find((n) => n.node === 'text:outline')!.cost, null);
  cleanup();
});

test('估算：只有输入时按集数粗估并写明假设', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline']);
  const r = estimateProject(project.db, { prices: loadPriceSources(NONE), fx: FX, presetDirs: dirs });
  const kf = r.nodes.find((n) => n.node === 'image:keyframe')!;
  assert.match(kf.assumptions[0] ?? '', /还没有分镜，按每集 11–16 切估/);
  const refs = r.nodes.find((n) => n.node === 'image:character-refs')!;
  assert.match(refs.assumptions[0] ?? '', /功能角色不出图/);
  cleanup();
});

test('评审修复：非 USD 价格不混进 USD 估算；--param 解析；坏缓存不挡 prices refresh', async () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const prices = loadPriceSources(NONE);
  const cny = { ...prices, user: [{ model: 'dashscope:qwen-image-3.0', unit: 'image' as const, price: 0.2, currency: 'CNY', source: 'u', checkedAt: '2026-10-29', verified: true }] };
  const r = estimateProject(project.db, { prices: cny, fx: FX, presetDirs: dirs });
  const kf = r.nodes.find((n) => n.node === 'image:keyframe')!;
  assert.equal(kf.cost, null);
  assert.match(kf.prices.join(' '), /币种是 CNY/);
  cleanup();
  const { parseParams } = await import('../src/cli-models.ts');
  assert.deepEqual(parseParams('resolution=480P,size=1k'), { resolution: '480P', size: '1k' });
  assert.throws(() => parseParams('resolution'), /键=值/);
  const { refreshPriceCache } = await import('../src/pricing/openrouter.ts');
  const cfg = mkdtempSync(join(tmpdir(), 'avp-cache-'));
  writeFileSync(join(cfg, 'prices-cache.json'), '{ truncated');
  const fake = (async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch;
  const out = await refreshPriceCache(cfg, fake);
  assert.deepEqual(JSON.parse(readFileSync(out.path, 'utf8')).entries, []);
  rmSync(cfg, { recursive: true, force: true });
});

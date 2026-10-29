// CLI 冒烟：真起一个 node 进程跑命令，看退出码和输出。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STAGES } from '../src/domain/types.ts';
import { DUKO, fixturePath, loadFixture } from './helpers.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('init → 依次导入 6 份 → lineage → stale → media', () => {
  const root = mkdtempSync(join(tmpdir(), 'avp-cli-'));
  const dir = join(root, 'duko');
  const init = run('init', dir, '--name', '渡口');
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).name, '渡口');

  for (const stage of STAGES) {
    const r = run('import', dir, stage, fixturePath(stage), '--skill', `novel-${stage}@test`);
    assert.equal(r.status, 0, `${stage}: ${r.stderr}`);
  }

  const lineage = run('lineage', dir, 'cut', DUKO.cut21, '--facet', 'storyboard');
  assert.equal(lineage.status, 0, lineage.stderr);
  assert.match(lineage.stdout, /"key": "C01"/);

  const stale = run('stale', dir);
  assert.deepEqual(JSON.parse(stale.stdout), []);

  const file = join(root, 'a.png');
  writeFileSync(file, 'png');
  const add = run('media', 'add', dir, file);
  assert.equal(add.status, 0, add.stderr);
  assert.equal(JSON.parse(run('media', 'verify', dir).stdout).ok, 1);
  rmSync(root, { recursive: true, force: true });
});

test('导入坏掉的剧本：退出码 1，stderr 逐条列出问题', () => {
  const root = mkdtempSync(join(tmpdir(), 'avp-cli-'));
  const dir = join(root, 'duko');
  run('init', dir, '--name', '渡口');
  run('import', dir, 'outline', fixturePath('outline'));
  const bad = loadFixture('script');
  bad.episodes[0].scenes[0].sceneId = 'S09';
  const file = join(root, 'bad.json');
  writeFileSync(file, JSON.stringify(bad));
  const r = run('import', dir, 'script', file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /处问题/);
  assert.match(r.stderr, /S09/);
  rmSync(root, { recursive: true, force: true });
});

test('参数错误给出中文提示', () => {
  assert.equal(run().status, 0, '无参数打印用法');
  const unknown = run('frobnicate');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /未知命令/);
  assert.match(run('lineage', '/tmp', 'shot', 'x').stderr, /不认识的 kind/);
  assert.match(run('import', '/tmp', 'novel', 'x.json').stderr, /不认识的 stage/);
  assert.match(run('init', '/tmp/x').stderr, /用法：init/);
  assert.match(run('init', '/tmp/x', '--name').stderr, /--name 后面缺少取值/);
  assert.match(run('stale', join(tmpdir(), 'avp-no-such-dir')).stderr, /不是项目目录/);
  assert.match(run('import', '/tmp', 'outline', join(tmpdir(), 'avp-no-such.json')).stderr, /读不了 .*avp-no-such\.json/);
});

test('节点协议：pack register → input → run（回放模型）→ runs → 转人工后 import --run 结案', () => {
  const root = mkdtempSync(join(tmpdir(), 'avp-cli-'));
  const dir = join(root, 'p');
  const here = dirname(fileURLToPath(import.meta.url));
  const replay = join(root, 'replay');
  mkdirSync(replay);
  const outline = loadFixture('outline');
  const { episodes, ...skeleton } = outline;
  const fence = (d: unknown) => `\`\`\`json\n${JSON.stringify(d)}\n\`\`\``;
  writeFileSync(join(replay, '1.txt'), fence({ ...skeleton, beats: skeleton.beats.map(({ episodeRef: _r, ...b }: Record<string, unknown>) => b) }));
  writeFileSync(join(replay, '2.txt'), fence({ episodes: episodes.map(({ id: _id, ...e }: Record<string, unknown>) => e) }));
  const manifest = join(root, 'pack.json');
  writeFileSync(manifest, JSON.stringify({ name: 'novel', requires: { major: 3 }, skills: [{ name: 'novel-outline', stage: 'outline', script: 'scripts/novel-outline.mjs', recipe: 'novel-outline' }] }));
  const synopsis = join(root, 'synopsis.txt');
  writeFileSync(synopsis, '民国年间，一条无名河上的老渡船……');

  assert.equal(run('init', dir, '--name', '渡口').status, 0);
  const reg = run('pack', 'register', dir, manifest, '--root', join(here, 'fixtures', 'skills'));
  assert.equal(reg.status, 0, reg.stderr);
  assert.deepEqual(JSON.parse(reg.stdout).mounted, [{ stage: 'outline', skill: 'novel-outline' }]);
  assert.equal(run('input', dir, synopsis, '--episodes', '6', '--seconds', '60', '--genre', '悬疑').status, 0);
  assert.equal(run('input', dir, synopsis, '--episodes', 'x', '--seconds', '60', '--genre', '悬疑').status, 1);

  const ok = run('run', dir, 'outline', '--model-cmd', `${process.execPath} ${join(here, 'support', 'replay-model.mjs')} ${replay}`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).status, 'passed');
  assert.match(ok.stderr, /▸ outline · novel-outline@3\.0\.0/);
  const runs = JSON.parse(run('runs', dir, '--id', '1').stdout);
  assert.deepEqual(runs.attempts.map((a: { step: string }) => a.step), ['skeleton', 'episodes:1-6']);

  // 第二次：模型输出始终不是 JSON → 转人工（退出码 2）→ 修好的文件 import --run 结案
  writeFileSync(join(replay, '.n'), '100');
  for (const n of [101, 102, 103]) writeFileSync(join(replay, `${n}.txt`), '不是 JSON');
  const bad = run('run', dir, 'outline', '--model-cmd', `${process.execPath} ${join(here, 'support', 'replay-model.mjs')} ${replay}`);
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /--run 2/);
  assert.equal(run('import', dir, 'script', fixturePath('outline'), '--run', '2').status, 1, '阶段不对时不导入');
  const fixed = run('import', dir, 'outline', fixturePath('outline'), '--run', '2');
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(JSON.parse(run('runs', dir, '--id', '2').stdout).status, 'resolved');
  rmSync(root, { recursive: true, force: true });
});

test('pack register：清单不是合法 JSON 时点名文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'avp-cli-'));
  const dir = join(root, 'p');
  run('init', dir, '--name', 'x');
  const bad = join(root, 'bad.json');
  writeFileSync(bad, '{ not json');
  const r = run('pack', 'register', dir, bad, '--root', root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 不是合法 JSON`));
  rmSync(root, { recursive: true, force: true });
});

test('模型与费用命令：models / preset / model / estimate / prices / cred（临时配置目录）', () => {
  const root = mkdtempSync(join(tmpdir(), 'avp-cli-'));
  const dir = join(root, 'p');
  const { DEEPSEEK_API_KEY: _ignored, ...base } = process.env;
  const env: NodeJS.ProcessEnv = { ...base, AVP_CONFIG_DIR: join(root, 'cfg') };
  const go = (args: string[], input?: string) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, ...(input !== undefined ? { input } : {}) });
  assert.equal(go(['init', dir, '--name', 'x']).status, 0);
  for (const stage of STAGES) assert.equal(go(['import', dir, stage, fixturePath(stage)]).status, 0);

  assert.ok(JSON.parse(go(['models', '--capability', 'video']).stdout).every((m: { capability: string }) => m.capability === 'video'));
  assert.equal(go(['models', '--capability', 'audio']).status, 1);
  assert.deepEqual(JSON.parse(go(['preset', 'list']).stdout).map((p: { name: string }) => p.name), ['budget', 'production']);
  assert.equal(JSON.parse(go(['preset', 'use', dir, 'production']).stdout).preset, 'production');
  assert.equal(JSON.parse(go(['model', 'set', dir, 'video:segment', 'minimax:MiniMax-H3-Lite', '--param', 'resolution=480P']).stdout).from, 'override');
  const shown = JSON.parse(go(['model', 'show', dir]).stdout);
  assert.equal(shown.nodes.find((n: { node: string }) => n.node === 'video:segment').model, 'minimax:MiniMax-H3-Lite');
  assert.equal(JSON.parse(go(['model', 'clear', dir, 'video:segment']).stdout).from, 'preset');
  assert.equal(go(['model', 'set', dir, 'video:segment', 'deepseek:deepseek-flash']).status, 1);

  const est = go(['estimate', dir, '--preset', 'all']);
  assert.equal(est.status, 0, est.stderr);
  assert.equal(JSON.parse(est.stdout).length, 2);
  assert.match(est.stderr, /合计/);
  assert.match(est.stderr, /仅供参考/);
  const prices = go(['prices', 'show', '--model', 'minimax:MiniMax-H3-Lite']);
  assert.match(prices.stderr, /480P.*video_second.*0\.025/);

  assert.equal(go(['cred', 'set', 'deepseek'], 'sk-test-abcd\n').status, 0);
  const listed = go(['cred', 'list']);
  assert.match(listed.stderr, /deepseek\s+····abcd（file）/);
  assert.doesNotMatch(listed.stdout + listed.stderr, /sk-test/);
  assert.equal(JSON.parse(go(['cred', 'rm', 'deepseek']).stdout).removed, true);
  assert.equal(go(['cred', 'set', 'nope']).status, 1);
  rmSync(root, { recursive: true, force: true });
});

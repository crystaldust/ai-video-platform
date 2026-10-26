// CLI 冒烟：真起一个 node 进程跑命令，看退出码和输出。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STAGES } from '../src/domain/types.ts';
import { fixturePath, loadFixture } from './helpers.ts';

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

  const lineage = run('lineage', dir, 'cut', 'E01-02.c1', '--facet', 'storyboard');
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

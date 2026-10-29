// 节点协议的单元测试：frontmatter、清单、脚本执行、注册与挂载、输入、输出解析、提示词、分批合并、命令行模型。
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractJson } from '../src/executor/json-output.ts';
import { buildPrompt } from '../src/executor/prompt.ts';
import { batches, mergeEpisodes, RECIPE_NAMES } from '../src/executor/recipes.ts';
import { parseViolations } from '../src/executor/run-node.ts';
import { CommandTextModel, parseCommand } from '../src/model/command-model.ts';
import { addInput, currentInput, validateParams } from '../src/repo/inputs.ts';
import { assertResolvable, createRun, finishRun } from '../src/repo/runs.ts';
import { currentMount, mountSkill, registerPack } from '../src/repo/skills.ts';
import { boundarySection, majorOf, parseFrontmatter } from '../src/skills/frontmatter.ts';
import { isContainedPath, parseManifest } from '../src/skills/manifest.ts';
import { probeCapabilities, runScript } from '../src/skills/script-runner.ts';
import { tempProject } from './helpers.ts';

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills');
const PACK_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs', 'novel.pack.json');

test('frontmatter：读出上游 skill 的名称、版本、描述与边界段', () => {
  const md = readFileSync(join(SKILLS, 'novel-outline', 'SKILL.md'), 'utf8');
  const fm = parseFrontmatter(md);
  assert.equal(fm.name, 'novel-outline');
  assert.equal(fm.version, '3.0.0');
  assert.equal(majorOf(fm.version), 3);
  assert.match(fm.description, /短剧大纲五件套/);
  assert.match(boundarySection(md), /^\*\*边界/);
  assert.equal(boundarySection('没有边界段'), '');
});

test('frontmatter：缺 frontmatter、缺 name、版本号不合法都报错', () => {
  assert.throws(() => parseFrontmatter('# 标题'), /缺少 frontmatter/);
  assert.throws(() => parseFrontmatter('---\nname: x\n'), /没有结束标记/);
  assert.throws(() => parseFrontmatter('---\nversion: 1.0.0\n---\n'), /缺少 name/);
  assert.throws(() => parseFrontmatter('---\nname: x\nversion: v1\n---\n'), /不是语义化版本号/);
});

test('清单：仓库自带的 novel 包能通过校验', () => {
  const m = parseManifest(JSON.parse(readFileSync(PACK_FILE, 'utf8')), RECIPE_NAMES);
  assert.equal(m.requiresMajor, 3);
  assert.equal(m.skills.length, 7);
  assert.deepEqual(m.skills.filter((s) => s.stage).map((s) => s.stage), ['outline', 'cast', 'art', 'script', 'staging', 'storyboard']);
});

test('清单：越界路径、未知配方、同阶段重复、缺配方逐条报出', () => {
  const bad = {
    name: 'bad',
    skills: [
      { name: 'a', stage: 'outline', script: '../x.mjs', recipe: 'novel-outline' },
      { name: 'b', stage: 'outline', script: null, recipe: 'nope' },
      { name: 'c', stage: 'script', script: null, recipe: null },
    ],
  };
  assert.throws(() => parseManifest(bad, RECIPE_NAMES), (e: Error) => /skill 目录内的相对路径/.test(e.message) && /recipe 不认识/.test(e.message) && /没有 recipe/.test(e.message));
  assert.throws(() => parseManifest({ name: 'x', skills: [{ name: 'a', stage: 'outline', script: null, recipe: 'single-pass' }, { name: 'b', stage: 'outline', script: null, recipe: 'single-pass' }] }, RECIPE_NAMES), /同一阶段只能挂一个/);
  assert.throws(() => parseManifest([], RECIPE_NAMES), /不是 JSON 对象/);
  assert.equal(isContainedPath('/abs/x.mjs'), false);
  assert.equal(isContainedPath('scripts/x.mjs'), true);
});

test('脚本执行：validate 不过返回 exit 1 与违规行；能力探测读 USAGE', async () => {
  const dir = join(SKILLS, 'novel-outline');
  const script = join(dir, 'scripts', 'novel-outline.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'avp-sr-'));
  writeFileSync(join(tmp, 'o.json'), JSON.stringify({ episodes: [] }));
  const r = await runScript(script, ['validate', join(tmp, 'o.json')], { cwd: tmp });
  assert.equal(r.code, 1);
  assert.ok(parseViolations(r.code, r.stdout, r.stderr).length > 0);
  assert.deepEqual(await probeCapabilities(script, dir), { seed: false, ids: true, validate: true, blocking: false });
  assert.deepEqual(await probeCapabilities(join(SKILLS, 'novel-script', 'scripts', 'novel-script.mjs'), dir), { seed: true, ids: true, validate: true, blocking: false });
  rmSync(tmp, { recursive: true, force: true });
});

test('脚本执行：超时会被杀掉并报错', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'avp-sr-'));
  writeFileSync(join(tmp, 'loop.mjs'), 'while (true) {}');
  await assert.rejects(runScript(join(tmp, 'loop.mjs'), [], { cwd: tmp, timeoutMs: 200 }), /超时/);
  rmSync(tmp, { recursive: true, force: true });
});

test('parseViolations：通过为空；没有可读行时给出命令摘要', () => {
  assert.deepEqual(parseViolations(0, '✓ 通过', ''), []);
  assert.deepEqual(parseViolations(1, '✗ 2 处违规：\n\n  甲\n  乙\n', ''), ['甲', '乙']);
  assert.match(parseViolations(2, '', '')[0] ?? '', /退出码 2/);
});

test('注册 novel 包：版本、能力、哈希入库，有阶段的 skill 自动挂载', async () => {
  const { project, cleanup } = tempProject();
  const pack = { name: 'novel', requires: { major: 3 }, skills: [
    { name: 'novel-outline', stage: 'outline', script: 'scripts/novel-outline.mjs', recipe: 'novel-outline' },
    { name: 'novel-script', stage: 'script', script: 'scripts/novel-script.mjs', recipe: 'novel-script' },
    { name: 'novel-missing', stage: 'art', script: 'scripts/novel-missing.mjs', recipe: 'single-pass' },
  ] };
  const r = await registerPack(project.db, pack, SKILLS, RECIPE_NAMES);
  assert.deepEqual(r.mounted.map((m) => m.stage), ['outline', 'script']);
  assert.equal(r.problems.length, 1, '副本里没有 novel-missing：记问题但不阻断');
  assert.match(r.problems[0] ?? '', /novel-missing：找不到/);
  const outline = currentMount(project.db, 'outline')!;
  assert.equal(outline.version, '3.0.0');
  assert.equal(outline.capabilities.ids, true);
  assert.match(outline.skillMdHash, /^[0-9a-f]{64}$/);
  cleanup();
});

test('注册：主版本太旧的 skill 挂不到依赖稳定 id 的阶段', async () => {
  const { project, cleanup } = tempProject();
  const root = mkdtempSync(join(tmpdir(), 'avp-skills-'));
  cpSync(join(SKILLS, 'novel-script'), join(root, 'novel-script'), { recursive: true });
  const md = join(root, 'novel-script', 'SKILL.md');
  writeFileSync(md, readFileSync(md, 'utf8').replace(/^version: .*$/m, 'version: 2.0.0'));
  const pack = { name: 'old', requires: { major: 3 }, skills: [{ name: 'novel-script', stage: 'script', script: 'scripts/novel-script.mjs', recipe: 'novel-script' }] };
  await assert.rejects(registerPack(project.db, pack, root, RECIPE_NAMES), /版本 2\.0\.0 太旧/);
  rmSync(root, { recursive: true, force: true });
  cleanup();
});

test('挂载：只能挂到 skill 声明的阶段；换挂载后当前挂载随之变化', async () => {
  const { project, cleanup } = tempProject();
  await registerPack(project.db, { name: 'p', skills: [{ name: 'prompt-only', stage: 'storyboard', script: null, recipe: 'single-pass' }] }, SKILLS, RECIPE_NAMES);
  assert.equal(currentMount(project.db, 'storyboard')?.name, 'prompt-only');
  assert.throws(() => mountSkill(project.db, 'outline', 'prompt-only'), /不能挂到 outline/);
  assert.throws(() => mountSkill(project.db, 'outline', 'nope'), /没有注册过/);
  await assert.rejects(registerPack(project.db, { name: 'p', skills: [{ name: 'novel-missing', stage: 'art', script: null, recipe: 'single-pass' }] }, SKILLS, RECIPE_NAMES), /没有一个 skill 能注册/);
  cleanup();
});

test('项目输入：参数逐项校验；只追加，最新一条生效', () => {
  const { project, cleanup } = tempProject();
  assert.throws(() => validateParams({ episodes: 0, seconds: 5, genre: ' ' }), (e: Error) => /集数/.test(e.message) && /单集时长/.test(e.message) && /题材/.test(e.message));
  assert.throws(() => addInput(project.db, { kind: 'synopsis', text: '  ', params: { episodes: 6, seconds: 60, genre: '悬疑' } }), /不能为空/);
  addInput(project.db, { kind: 'synopsis', text: '第一版', params: { episodes: 6, seconds: 60, genre: '悬疑' } });
  addInput(project.db, { kind: 'novel', text: '第二版', params: { episodes: 12, seconds: 90, genre: '民国' } });
  const cur = currentInput(project.db);
  assert.deepEqual([cur?.kind, cur?.text, cur?.params.episodes], ['novel', '第二版', 12]);
  cleanup();
});

test('extractJson：代码块 / 裸 JSON / 非对象 / 坏 JSON', () => {
  assert.deepEqual(extractJson('说明\n```json\n{"a":1}\n```\n```json\n{"b":2}\n```'), { ok: true, value: { a: 1 } });
  assert.deepEqual(extractJson('结果是 {"a": {"b": 2}} 。'), { ok: true, value: { a: { b: 2 } } });
  assert.equal(extractJson('```json\n[1,2]\n```').ok, false);
  assert.equal(extractJson('{"a":').ok, false);
  assert.equal(extractJson('没有 JSON').ok, false);
});

test('提示词：平台规则、边界、参数、上游、违规都在；空段不出现', () => {
  const p = buildPrompt({
    skillDescription: '写大纲',
    boundary: '**边界**：不写台词',
    task: '本遍做骨架',
    schema: '',
    params: { episodes: 6, seconds: 60, genre: '悬疑' },
    upstream: { outline: { a: 1 } },
    violations: ['第 1 集缺钩子'],
    outputSpec: '输出 JSON',
  });
  assert.match(p.system, /只输出一个 ```json 代码块/);
  assert.match(p.system, /【边界】/);
  assert.match(p.user, /总集数：6/);
  assert.match(p.user, /【上游 outline\.json】/);
  assert.match(p.user, /- 第 1 集缺钩子/);
  assert.doesNotMatch(p.user, /【数据结构】/);
});

test('分批与合并', () => {
  assert.deepEqual(batches(6, 10), [[1, 6]]);
  assert.deepEqual(batches(25, 10), [[1, 10], [11, 20], [21, 25]]);
  assert.deepEqual(batches(0, 10), []);
  assert.deepEqual(mergeEpisodes([{ ep: 2, v: 'a' }, { ep: 1 }], [{ ep: 2, v: 'b' }, 'x', { ep: 1.5 }]), [{ ep: 1 }, { ep: 2, v: 'b' }]);
});

test('命令行模型：提示词写进 stdin，stdout 是输出；非零退出报错', async () => {
  assert.deepEqual(parseCommand('  claude   -p '), ['claude', '-p']);
  assert.throws(() => parseCommand('  '), /不能为空/);
  const tmp = mkdtempSync(join(tmpdir(), 'avp-cm-'));
  const echo = join(tmp, 'echo.mjs');
  writeFileSync(echo, 'process.stdin.pipe(process.stdout)');
  const fail = join(tmp, 'fail.mjs');
  writeFileSync(fail, 'process.stderr.write("坏了"); process.exit(3)');
  const ok = await new CommandTextModel(`${process.execPath} ${echo}`).complete({ system: 'S', user: 'U' });
  assert.equal(ok.text, 'S\n\nU');
  await assert.rejects(new CommandTextModel(`${process.execPath} ${fail}`).complete({ system: 'S', user: 'U' }), /退出码 3：坏了/);
  await assert.rejects(new CommandTextModel('/no/such/bin').complete({ system: 'S', user: 'U' }), /失败/);
  rmSync(tmp, { recursive: true, force: true });
});

test('人工结案：只有同阶段、needs_human 的运行能结案', async () => {
  const { project, cleanup } = tempProject();
  await registerPack(project.db, { name: 'p', skills: [{ name: 'prompt-only', stage: 'storyboard', script: null, recipe: 'single-pass' }] }, SKILLS, RECIPE_NAMES);
  const skillId = currentMount(project.db, 'storyboard')!.id;
  const passed = createRun(project.db, { stage: 'storyboard', skillId, model: 'm', inputId: null, maxAttempts: 1 });
  finishRun(project.db, passed, { status: 'passed' });
  assert.throws(() => assertResolvable(project.db, passed, 'storyboard'), /只有 needs_human 的运行能人工结案/);
  const human = createRun(project.db, { stage: 'storyboard', skillId, model: 'm', inputId: null, maxAttempts: 1 });
  finishRun(project.db, human, { status: 'needs_human' });
  assert.throws(() => assertResolvable(project.db, human, 'script'), /不是 script/);
  assert.throws(() => assertResolvable(project.db, 999, 'storyboard'), /没有这个运行/);
  assert.doesNotThrow(() => assertResolvable(project.db, human, 'storyboard'));
  cleanup();
});

test('能力探测超时只记这一个 skill 的问题，其他 skill 照常注册', async () => {
  const { project, cleanup } = tempProject();
  const pack = { name: 'mixed', skills: [
    { name: 'hangs', stage: 'art', script: 'scripts/hangs.mjs', recipe: 'single-pass' },
    { name: 'prompt-only', stage: 'storyboard', script: null, recipe: 'single-pass' },
  ] };
  const r = await registerPack(project.db, pack, SKILLS, RECIPE_NAMES, { probeTimeoutMs: 300 });
  assert.deepEqual(r.registered.map((s) => s.name), ['prompt-only']);
  assert.match(r.problems.join('\n'), /hangs：探测脚本能力失败：.*超时/);
  assert.equal(currentMount(project.db, 'storyboard')?.name, 'prompt-only');
  cleanup();
});

test('重新注册升级后的同名 skill：挂载换到新注册的那份并报告；别的 skill 占着的阶段不动但提示', async () => {
  const { project, cleanup } = tempProject();
  const pack = { name: 'p', skills: [{ name: 'prompt-only', stage: 'storyboard', script: null, recipe: 'single-pass' }] };
  await registerPack(project.db, pack, SKILLS, RECIPE_NAMES);
  const before = currentMount(project.db, 'storyboard')!;
  const again = await registerPack(project.db, pack, SKILLS, RECIPE_NAMES);
  assert.deepEqual(again.remounted, [{ stage: 'storyboard', skill: 'prompt-only', from: '0.2.0', to: '0.2.0' }]);
  assert.notEqual(currentMount(project.db, 'storyboard')!.id, before.id, '挂到新注册的那一行');
  const other = await registerPack(project.db, { name: 'g', skills: [{ name: 'gated-storyboard', stage: 'storyboard', script: 'scripts/gated.mjs', recipe: 'single-pass' }] }, SKILLS, RECIPE_NAMES);
  assert.equal(currentMount(project.db, 'storyboard')!.name, 'prompt-only');
  assert.match(other.problems.join('\n'), /storyboard 仍挂着 prompt-only，没有换成 gated-storyboard/);
  cleanup();
});

test('人工结案：之后已有更新的运行通过时拒绝，免得旧修复盖掉新结果', async () => {
  const { project, cleanup } = tempProject();
  await registerPack(project.db, { name: 'p', skills: [{ name: 'prompt-only', stage: 'storyboard', script: null, recipe: 'single-pass' }] }, SKILLS, RECIPE_NAMES);
  const skillId = currentMount(project.db, 'storyboard')!.id;
  const old = createRun(project.db, { stage: 'storyboard', skillId, model: 'm', inputId: null, maxAttempts: 1 });
  finishRun(project.db, old, { status: 'needs_human' });
  const newer = createRun(project.db, { stage: 'storyboard', skillId, model: 'm', inputId: null, maxAttempts: 1 });
  finishRun(project.db, newer, { status: 'passed' });
  assert.throws(() => assertResolvable(project.db, old, 'storyboard'), new RegExp(`run ${newer} 已经通过`));
  cleanup();
});

test('extractJson：前面有别的代码块、字符串里含 ``` 时仍能取到 JSON', () => {
  const twoBlocks = '先说明：\n```text\n这是说明\n```\n```json\n{"ok": true}\n```';
  assert.deepEqual(extractJson(twoBlocks), { ok: true, value: { ok: true } });
  const untagged = '```\nnot json\n```\n```\n{"b": 1}\n```';
  assert.deepEqual(extractJson(untagged), { ok: true, value: { b: 1 } });
  const nested = '```json\n{"prompt": "镜头一\\n```\\n镜头二"}\n```';
  assert.deepEqual(extractJson(nested), { ok: true, value: { prompt: '镜头一\n```\n镜头二' } });
});

test('frontmatter：版本写在 metadata 下一层（novel-characters、character-refs 的写法）也能读到', () => {
  const md = ['---', 'name: novel-characters', 'description: |', '  拆角色', 'metadata:', '  license: Apache-2.0', '  version: 2.0.0', '---', ''].join('\n');
  assert.equal(parseFrontmatter(md).version, '2.0.0');
  const top = ['---', 'name: x', 'version: 3.0.0', 'metadata:', '  version: 9.9.9', '---', ''].join('\n');
  assert.equal(parseFrontmatter(top).version, '3.0.0', '顶层 version 优先');
});

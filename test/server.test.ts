// 本地服务：安全检查（Host、令牌、同源）、统一信封、静态托管，以及各页面的只读接口。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { importArtifact, ImportError } from '../src/import/import-artifact.ts';
import { createProject } from '../src/project.ts';
import { createPaidGate } from '../src/repo/paid-gates.ts';
import { HttpError, sendError } from '../src/server/http.ts';
import { DUKO, DUKO_BOOK, importAll, loadFixture } from './helpers.ts';
import { setupNovel } from './support/novel-pack.ts';
import { collectEvents, startHarness, testEstimate } from './support/server-harness.ts';

test('Host 不是本机地址：421；GET 不要令牌；变更请求缺令牌、令牌错、跨站来源都 403', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  assert.equal((await h.call('GET', '/api/projects')).status, 200);
  assert.deepEqual((await h.call('GET', '/api/projects')).body, { ok: true, data: [] }, '根目录不存在就是空列表');
  const evil = await h.call('GET', '/api/projects', { headers: { host: 'evil.example' } });
  assert.equal(evil.status, 421);
  assert.equal(evil.body.ok, false);
  assert.equal((await h.call('GET', '/api/projects', { headers: { host: `localhost:${h.server.port}` } })).status, 200);
  assert.equal((await h.call('POST', '/api/projects', { body: {}, token: false })).status, 403);
  assert.equal((await h.call('POST', '/api/projects', { body: {}, token: false, headers: { 'x-avp-token': 'wrong' } })).status, 403);
  assert.equal((await h.call('POST', '/api/projects', { body: {}, headers: { origin: 'http://evil.example' } })).status, 403);
  const withToken = await h.call('POST', '/api/projects', { body: {} });
  assert.equal(withToken.status, 400, '过了安全检查，才轮到参数校验');
  assert.match(withToken.body.error.message, /缺少 name/);
});

test('信封：没有的接口 404；坏 JSON 400；项目名带路径 400；没有的项目 404', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const missing = await h.call('GET', '/api/nope');
  assert.equal(missing.status, 404);
  assert.match(missing.body.error.message, /没有这个接口/);
  assert.equal((await h.call('GET', '/api/p/..%2Fetc/overview')).status, 400);
  assert.equal((await h.call('GET', '/api/p/nobody/overview')).status, 404);
  assert.equal((await h.call('POST', '/api/projects', { headers: { 'content-type': 'application/json' }, body: undefined })).status, 400);
});

test('错误分级：业务错误回消息，导入错误带逐条问题，意外错误只回通用消息并记日志', () => {
  const sent: { status: number; body: string }[] = [];
  const res = { writeHead: (status: number) => sent.push({ status, body: '' }), end: (b: string) => (sent.at(-1)!.body = b) } as never;
  const logs: string[] = [];
  sendError(res, new HttpError(409, '忙'), (l) => logs.push(l));
  sendError(res, new Error('集数不对'), (l) => logs.push(l));
  sendError(res, new ImportError(['甲', '乙']), (l) => logs.push(l));
  sendError(res, new TypeError('x is undefined at /secret/path'), (l) => logs.push(l));
  assert.deepEqual(sent.map((s) => s.status), [409, 400, 400, 500]);
  assert.deepEqual(JSON.parse(sent[2]!.body).error.problems, ['甲', '乙']);
  assert.doesNotMatch(sent[3]!.body, /secret/);
  assert.match(logs[0] ?? '', /secret/);
});

test('静态托管：index.html 注入令牌；前端路由回 index.html；不能读出前端目录', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'avp-static-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<html><head><title>x</title></head><body></body></html>');
  writeFileSync(join(dir, 'assets', 'a.js'), 'console.info(1)');
  writeFileSync(join(dir, '..', 'avp-outside.txt'), 'secret');
  const h = await startHarness({ staticDir: dir });
  t.after(() => h.close());
  const index = await h.call('GET', encodeURI('/p/渡口/overview'));
  assert.match(index.text, new RegExp(`<meta name="avp-token" content="${h.server.token}">`));
  assert.equal(index.headers['cache-control'], 'no-store');
  assert.match(String(index.headers['content-security-policy']), /script-src 'self'/);
  assert.equal(index.headers['x-frame-options'], 'DENY');
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  const js = await h.call('GET', '/assets/a.js');
  assert.equal(js.text, 'console.info(1)');
  assert.match(String(js.headers['content-type']), /javascript/);
  const escape = await h.call('GET', '/../avp-outside.txt');
  assert.doesNotMatch(escape.text, /secret/);
  assert.equal((await h.call('POST', '/index.html', { body: {} })).status, 405);
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(dir, '..', 'avp-outside.txt'), { force: true });
});

/** 项目根目录下建一个导入了渡口全套的项目（不跑模型）。 */
async function dukoProject(h: Awaited<ReturnType<typeof startHarness>>, name = '渡口') {
  const project = createProject(join(h.app.config.projectsRoot, name), name);
  await setupNovel(project);
  importAll(project);
  return project;
}

test('项目列表：渡口全套导入后文本 6/6；库比程序新的标「需要升级」', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  (await dukoProject(h)).close();
  const future = join(h.app.config.projectsRoot, '未来');
  mkdirSync(future, { recursive: true });
  const raw = new DatabaseSync(join(future, 'project.sqlite'));
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  const list = (await h.call('GET', '/api/projects')).body.data;
  const duko = list.find((p: { id: string }) => p.id === '渡口');
  assert.equal(duko.status, 'ok');
  assert.deepEqual(duko.text, { passed: 6, total: 6 });
  assert.equal(duko.headline.tone, 'ok');
  assert.equal(duko.head.params.episodes, 6);
  assert.equal(list.find((p: { id: string }) => p.id === '未来').status, 'needs_upgrade');
});

test('全貌：6 张阶段卡（质量门来自 skill 的 checkup）、分集表、估算按集拆开；改剧本后待处理与矩阵一致', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const project = await dukoProject(h);
  const url = encodeURI('/api/p/渡口/overview');
  let o = (await h.call('GET', url)).body.data;
  assert.deepEqual(o.stages.map((s: { state: string }) => s.state), ['passed', 'passed', 'passed', 'passed', 'passed', 'passed']);
  const outlineGates = o.stages[0].gates;
  assert.ok(outlineGates.total > 0 && outlineGates.passed === outlineGates.total, JSON.stringify(outlineGates));
  assert.equal(o.stages[1].gates.total, null, '角色卡 skill 没有 checkup，退回 validate');
  assert.deepEqual(o.stages[1].gates.failed, []);
  assert.equal(o.episodes.length, 6);
  const ep1 = o.episodes[0];
  assert.deepEqual([ep1.storyboard.state, ep1.storyboard.segments, ep1.staging.scenes], ['ok', 10, 2]);
  assert.ok(ep1.estimate.low > 0, '第 1 集有分镜，按集估得出来');
  assert.equal(o.episodes[1].estimate, null, '第 2 集还没有分镜');
  assert.equal(o.summary.conversationSteps, 0);
  assert.equal(o.summary.pending, 0);
  const keyframe = o.estimate.nodes.find((n: { node: string }) => n.node === 'image:keyframe');
  assert.deepEqual(keyframe.episodes.map((e: { ep: number }) => e.ep), [1]);

  const script = loadFixture('script');
  script.episodes[2].scenes[0].flow[0].action = '汽笛提前响了。';
  importArtifact(project, 'script', script);
  o = (await h.call('GET', url)).body.data;
  assert.equal(o.stages[4].state, 'stale');
  assert.equal(o.episodes[2].staging.state, 'stale');
  assert.equal(o.episodes[2].staging.reason, '剧本已变');
  assert.equal(o.summary.pending, o.pending.length);
  assert.deepEqual(o.pending.map((p: { stage: string; ep: number }) => [p.stage, p.ep]), [['staging', 3]]);
  project.close();
});

test('单集详情、角色与美术、Skill 包、模型与预设、付费确认单', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const project = await dukoProject(h);
  const gate = createPaidGate(project.db, { orchestrationId: null, estimate: testEstimate(project.db) });
  const get = async (path: string) => (await h.call('GET', encodeURI(`/api/p/渡口${path}`))).body;

  const ep = (await get(`/episodes/${DUKO.ep1}`)).data;
  assert.equal(ep.nav.next, DUKO.ep2);
  assert.equal(ep.nav.prev, null);
  assert.equal(ep.stats.segments, 10);
  assert.equal(ep.scenes[0].segments[0].label, 'E01-01');
  assert.equal(ep.scenes[0].segments[0].cuts[0].characters[0], '沈知微', '人物编号换成名字');
  assert.ok(ep.scenes[0].segments[0].cuts[0].beats.length > 0, '切带上认领的剧本节拍');
  assert.equal((await get('/episodes/3')).data.episode.id, DUKO.ep3, '集号也认');
  assert.equal((await h.call('GET', encodeURI('/api/p/渡口/episodes/99'))).status, 404);

  const cast = (await get('/cast')).data;
  assert.equal(cast.characters.length, 5);
  assert.equal(cast.characters[4].drawn, false, '功能角色不出图');
  assert.ok(cast.characters[0].usage.lines > 0);
  assert.equal(cast.art.filter((a: { kind: string }) => a.kind === 'prop').length, 2);

  const skills = (await get('/skills')).data;
  assert.equal(skills.mounts.find((m: { stage: string }) => m.stage === 'storyboard').skill.name, 'novel-storyboard');
  assert.equal(skills.packs[0].inUse, true);

  const models = (await get('/models')).data;
  assert.equal(models.presets.find((p: { current: boolean }) => p.current).name, 'budget');
  assert.equal(models.nodes.find((n: { node: string }) => n.node === 'video:segment').model, 'minimax:MiniMax-H3-Lite');
  assert.ok(models.credentials.every((c: { masked: string | null }) => c.masked === null), '临时配置目录里没有凭据');

  const g = (await get(`/gates/${gate.id}`)).data;
  assert.equal(g.gate.status, 'awaiting_confirmation');
  assert.deepEqual(g.episodes.map((e: { state: string }) => e.state), ['ok', 'missing', 'missing', 'missing', 'missing', 'missing']);
  assert.deepEqual(g.characters, ['沈知微', '陆行远', '老周', '胡二爷']);
  project.close();
});

test('新建项目并开跑：SSE 推出各阶段的运行与结束，编排 done，生成付费确认单；同项目再开任务 409', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const created = await h.call('POST', '/api/projects', { body: { name: '渡口', kind: 'novel', text: DUKO_BOOK, params: { episodes: 6, seconds: 120, genre: '悬疑', aspect: '9:16' }, preset: 'budget' } });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.body.data.job, null);
  // 先订阅再开跑，一个事件都不漏
  const events = collectEvents(h, encodeURI('/api/p/渡口/events'), (e) => e.type === 'job-end');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await h.call('POST', encodeURI('/api/p/渡口/go'), { body: {} })).body.data.kind, 'go');
  assert.equal((await h.call('POST', encodeURI('/api/p/渡口/go'), { body: {} })).status, 409);
  const got = await events;
  assert.equal(got[0]!.type, 'hello');
  const starts = got.filter((e) => e.type === 'run-run-start').map((e) => e['stage']);
  assert.deepEqual([...starts].sort(), ['art', 'cast', 'outline', 'script', 'staging', 'storyboard']);
  const end = got.at(-1)!;
  assert.equal(end['ok'], true, JSON.stringify(end));
  assert.equal((end['result'] as { status: string }).status, 'done');
  assert.ok(got.some((e) => e.type === 'paid-gate'));
  await h.app.jobs.settled('渡口');
  const o = (await h.call('GET', encodeURI('/api/p/渡口/overview'))).body.data;
  assert.equal(o.job, null);
  assert.equal(o.orchestration.status, 'done');
  assert.ok(o.log.length === 6 && o.log.every((r: { attempts: unknown[] }) => r.attempts.length > 0), '运行记录带每次尝试');
  assert.equal(o.project.params.aspect, '9:16');
  assert.equal((await h.call('POST', '/api/projects', { body: { name: '渡口', kind: 'novel', text: 'x', params: { episodes: 1, seconds: 60, genre: 'g' } } })).status, 409);
  const started = await h.call('POST', '/api/projects', { body: { name: '雾港', kind: 'synopsis', text: '民国年间的雾港', params: { episodes: 6, seconds: 60, genre: '悬疑' }, start: true } });
  assert.equal(started.body.data.job.kind, 'go', '「一键跑」：建好就开跑');
  await h.app.jobs.settled('雾港');
});

test('打回单集 → 需复核 → 保持现状；付费确认；换预设与节点模型；换挂载', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const project = await dukoProject(h);
  const gate = createPaidGate(project.db, { orchestrationId: null, estimate: testEstimate(project.db) });
  project.close();
  const p = (path: string) => encodeURI(`/api/p/渡口${path}`);

  assert.match((await h.call('POST', p('/reject'), { body: { stage: 'art', episode: '3', note: 'x' } })).body.error.message, /整份负责/);
  assert.match((await h.call('POST', p('/reject'), { body: { stage: 'script', note: '  ' } })).body.error.message, /缺少 note/);
  const job = await h.call('POST', p('/reject'), { body: { stage: 'script', episode: '3', note: '汽笛提前' } });
  assert.equal(job.body.data.kind, 'reject');
  await h.app.jobs.settled('渡口');
  // 假模型原样交回第 3 集：没有改动，下游不需要复核
  let o = (await h.call('GET', p('/overview'))).body.data;
  assert.equal(o.stages[3].lastRun.status, 'passed');

  await h.app.withProject('渡口', (pr) => {
    const script = loadFixture('script');
    script.episodes[2].scenes[0].flow[0].action = '汽笛提前响了。';
    importArtifact(pr, 'script', script);
  });
  o = (await h.call('GET', p('/overview'))).body.data;
  assert.equal(o.pending.length, 1);
  const kept = await h.call('POST', p('/review'), { body: { stage: 'staging', episode: '3', note: '看过了' } });
  assert.equal(kept.status, 200, kept.text);
  assert.equal((await h.call('GET', p('/overview'))).body.data.pending.length, 0);

  const bad = await h.call('POST', p(`/gates/${gate.id}`), { body: { action: 'confirm', selection: { 'video:segment': ['ep_zzzzzzzz'] } } });
  assert.match(bad.body.error.message, /没有这些集的估算/);
  const ok = await h.call('POST', p(`/gates/${gate.id}`), { body: { action: 'confirm', selection: { 'video:segment': [DUKO.ep1], 'image:character-refs': true }, budgetCap: 50 } });
  assert.equal(ok.body.data.status, 'confirmed');
  assert.equal(ok.body.data.budgetCap, 50);

  assert.equal((await h.call('POST', p('/models'), { body: { action: 'preset', preset: 'production' } })).status, 200);
  assert.equal((await h.call('POST', p('/models'), { body: { action: 'set', node: 'text:art', model: 'deepseek:deepseek-v4-pro' } })).status, 200);
  const models = (await h.call('GET', p('/models'))).body.data;
  assert.equal(models.presets.find((x: { current: boolean }) => x.current).name, 'production');
  assert.equal(models.nodes.find((n: { node: string }) => n.node === 'text:art').overridden, true);
  assert.match((await h.call('POST', p('/models'), { body: { action: 'set', node: 'video:segment', model: 'deepseek:deepseek-flash' } })).body.error.message, /能力|capability|视频|video/);
  assert.equal((await h.call('POST', p('/models'), { body: { action: 'clear', node: 'text:art' } })).status, 200);

  assert.match((await h.call('POST', p('/mount'), { body: { stage: 'outline', skill: 'novel-script' } })).body.error.message, /不能挂到 outline/);
  assert.equal((await h.call('POST', p('/mount'), { body: { stage: 'script', skill: 'novel-script' } })).status, 200);
});

test('cli serve：启动打印地址、没给 --skills 提示不能新建；SIGTERM 正常退出；skills 目录不存在报错', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'avp-serve-'));
  const child = spawn(process.execPath, [cli, 'serve', '--port', '0', '--open', 'no', '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  await new Promise<void>((resolve, reject) => {
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.includes('页面上不能新建项目')) resolve();
    });
    child.on('exit', () => reject(new Error(`serve 提前退出：${err}`)));
  });
  assert.match(err, /短剧工坊：http:\/\/127\.0\.0\.1:\d+\//);
  const code = await new Promise<number | null>((resolve) => {
    child.removeAllListeners('exit');
    child.on('exit', (c) => resolve(c));
    child.kill('SIGTERM');
  });
  assert.equal(code, 0);
  const bad = spawn(process.execPath, [cli, 'serve', '--open', 'no', '--skills', join(root, 'nope')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let badErr = '';
  bad.stderr.on('data', (d: Buffer) => (badErr += d.toString()));
  assert.equal(await new Promise((r) => bad.on('exit', r)), 1);
  assert.match(badErr, /skills 根目录不存在/);
  rmSync(root, { recursive: true, force: true });
});

test('进程中断留下的 running 编排与运行：打开全貌时收尾，页面不会卡在运行中', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const project = await dukoProject(h);
  // 模拟另一个已经死掉的进程留下的记录
  project.db.exec(`INSERT INTO orchestration (mode, status, pid, started_at) VALUES ('all', 'running', 999999, '2026-10-29T00:00:00Z')`);
  const skill = (project.db.prepare(`SELECT skill_id FROM stage_mount WHERE stage = 'outline' ORDER BY id DESC LIMIT 1`).get() as { skill_id: number }).skill_id;
  project.db.exec(`INSERT INTO node_run (stage, skill_id, model, status, max_attempts, pid, started_at) VALUES ('outline', ${skill}, 'm', 'running', 3, 999999, '2026-10-29T00:00:00Z')`);
  project.close();
  const o = (await h.call('GET', encodeURI('/api/p/渡口/overview'))).body.data;
  assert.equal(o.orchestration.status, 'failed');
  assert.equal(o.stages[0].lastRun.status, 'failed');
  assert.notEqual(o.stages[0].state, 'running');
});

test('付费确认：上限给了却不是正数 400（不会静默变成不设上限）；坏的 URL 编码 400', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const project = await dukoProject(h);
  const gate = createPaidGate(project.db, { orchestrationId: null, estimate: testEstimate(project.db) });
  project.close();
  const path = encodeURI(`/api/p/渡口/gates/${gate.id}`);
  for (const budgetCap of [null, 'abc', 0, -3]) {
    const r = await h.call('POST', path, { body: { action: 'confirm', selection: {}, budgetCap } });
    assert.equal(r.status, 400, `budgetCap=${String(budgetCap)}`);
    assert.match(r.body.error.message, /单次上限要是正数/);
  }
  assert.equal((await h.call('GET', '/api/p/%zz/head')).status, 400);
});

test('新建项目中途失败：删掉这次建的目录，同名可以再建', async (t) => {
  const { existsSync } = await import('node:fs');
  // skills 根目录是空的：建好项目目录后注册 skill 包失败
  const empty = mkdtempSync(join(tmpdir(), 'avp-empty-skills-'));
  const h = await startHarness({ skillsRoot: empty });
  t.after(() => h.close());
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const body = { name: '雾港', kind: 'synopsis', text: '雾港', params: { episodes: 1, seconds: 60, genre: 'g' } };
  const failed = await h.call('POST', '/api/projects', { body });
  assert.equal(failed.status, 400);
  assert.match(failed.body.error.message, /没有一个 skill 能注册/);
  assert.equal(existsSync(join(h.app.config.projectsRoot, '雾港')), false, '半个项目被删掉');
  const bad = await h.call('POST', '/api/projects', { body: { ...body, preset: 'nope' } });
  assert.equal(bad.status, 400);
  assert.equal(existsSync(join(h.app.config.projectsRoot, '雾港')), false, '预设不对时连目录都不建');
});

test('质量门缓存：同一份同时请求只跑一次；上游变了重新跑', async () => {
  const { stageGates } = await import('../src/server/views/checkup.ts');
  const { readdirSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'avp-gates-'));
  const project = createProject(join(root, 'p'), 'p');
  await setupNovel(project);
  importAll(project);
  const [a, b] = [stageGates(project, 'script'), stageGates(project, 'script')];
  assert.equal(a, b, '同时请求共用一次运行');
  assert.deepEqual(await a, { total: 11, passed: 11, failed: [] });
  const dirs = () => readdirSync(join(project.dir, '.cache', 'checkup')).filter((d) => d.startsWith('script-')).length;
  assert.equal(dirs(), 1);
  const outline = loadFixture('outline');
  outline.characters[0].arc = `${outline.characters[0].arc}（改）`;
  importArtifact(project, 'outline', outline);
  await stageGates(project, 'script');
  assert.equal(dirs(), 2, '大纲变了，剧本的门按新上游重跑');
  project.close();
  rmSync(root, { recursive: true, force: true });
});

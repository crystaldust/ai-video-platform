// 页面上的付费生成：确认后自动开跑（后台任务、SSE 推 gen-task）、已有任务时只确认、停止（只在两次提交之间）与继续、
// 预算停下后继续也不超、服务启动时恢复只查询不提交、凭据缺失的报错不带 key 也不留下「提交中」、重新查询的限制。
// 供应商全是假的（harness 默认注入），碰不到真供应商。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProject, type Project } from '../src/project.ts';
import { createPaidGate } from '../src/repo/paid-gates.ts';
import { listTasks, type TaskRow } from '../src/repo/tasks.ts';
import { importAll } from './helpers.ts';
import { setupNovel } from './support/novel-pack.ts';
import { collectEvents, fakeGenerate, startHarness, testEstimate, type Harness } from './support/server-harness.ts';

const ID = '渡口';
const p = (path: string) => encodeURI(`/api/p/${ID}${path}`);
const REFS = { 'image:character-refs': true };

async function setup(h: Harness): Promise<number> {
  const project = createProject(join(h.app.config.projectsRoot, ID), ID);
  await setupNovel(project);
  importAll(project);
  const gate = createPaidGate(project.db, { orchestrationId: null, estimate: testEstimate(project.db) });
  project.close();
  return gate.id;
}

const tasks = (h: Harness): Promise<TaskRow[]> => h.app.withProject(ID, (pr: Project) => listTasks(pr.db));

async function waitFor(what: string, cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等不到：${what}`);
}

/** 慢一点的假供应商：查 n 次才完成，两轮之间真的等几毫秒，测试才有机会在中途停。 */
function slow(polls: number) {
  const g = fakeGenerate({ pollsToFinish: polls }, { pollsToFinish: polls });
  return { ...g, deps: { ...g.deps, sleep: () => new Promise<void>((r) => setTimeout(r, 3)) } };
}

test('确认后自动开跑：返回 started，后台跑完全部入库，SSE 收到 gen-task 与 job-end', async (t) => {
  const g = fakeGenerate();
  const h = await startHarness({ generate: g.deps });
  t.after(() => h.close());
  const gateId = await setup(h);
  const events = collectEvents(h, p('/events'), (e) => e.type === 'job-end');
  await waitFor('SSE 挂上', () => h.app.bus.subscribers(ID) > 0);
  const r = await h.call('POST', p(`/gates/${gateId}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.started, true);
  assert.equal(r.body.data.gate.status, 'confirmed');
  await h.app.jobs.settled(ID);
  const all = await tasks(h);
  assert.equal(all.length, 20);
  assert.ok(all.every((x) => x.status === 'collected'));
  assert.equal(g.img.submits.length, 20);
  const got = await events;
  assert.ok(got.some((e) => e.type === 'job-start' && e['kind'] === 'generate' && e['gateId'] === gateId));
  assert.ok(got.some((e) => e.type === 'gen-task' && e['status'] === 'collected' && e['gateId'] === gateId));
  const end = got.find((e) => e.type === 'job-end')!;
  assert.equal(end['ok'], true);
  assert.equal((end['result'] as { currency: string }).currency, 'CNY');
});

test('已有后台任务时确认：照样确认，started: false 并说明；停止只对生成有效', async (t) => {
  const g = slow(40);
  const h = await startHarness({ generate: g.deps });
  t.after(() => h.close());
  const first = await setup(h);
  await h.call('POST', p(`/gates/${first}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  const second = await h.app.withProject(ID, (pr) => createPaidGate(pr.db, { orchestrationId: null, estimate: testEstimate(pr.db) }).id);
  const r = await h.call('POST', p(`/gates/${second}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  assert.equal(r.body.data.started, false);
  assert.equal(r.body.data.gate.status, 'confirmed');
  assert.match(r.body.data.reason, /继续生成/);
  assert.equal((await h.call('POST', p('/generate'), { body: { action: 'continue', gateId: second } })).status, 409, '同一项目只跑一个');
  assert.equal((await h.call('POST', p('/generate'), { body: { action: 'stop' } })).status, 200);
  await h.app.jobs.settled(ID);
  assert.equal((await h.call('POST', p('/generate'), { body: { action: 'stop' } })).status, 409, '没有在跑的就不能停');
});

test('停止：在两次提交之间停下，已提交的留着；继续之后全部入库，每条只提交一次', async (t) => {
  const g = slow(15);
  const h = await startHarness({ generate: g.deps });
  t.after(() => h.close());
  const gateId = await setup(h);
  await h.call('POST', p(`/gates/${gateId}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  await waitFor('有任务提交了', () => g.img.submits.length > 0);
  const stop = await h.call('POST', p('/generate'), { body: { action: 'stop' } });
  assert.deepEqual(stop.body.data, { stopping: true });
  await h.app.jobs.settled(ID);
  const mid = await tasks(h);
  assert.ok(mid.some((x) => x.status === 'planned'), '停下时还有没提交的');
  assert.ok(!mid.some((x) => x.status === 'submitting'), '没有卡在提交中');
  const cont = await h.call('POST', p('/generate'), { body: { action: 'continue', gateId } });
  assert.equal(cont.status, 200, cont.text);
  await h.app.jobs.settled(ID);
  const end = await tasks(h);
  assert.ok(end.every((x) => x.status === 'collected'));
  assert.equal(g.img.submits.length, end.length, '没有重复提交');
});

test('预算停下：继续之后也不超上限、不多提交', async (t) => {
  const g = fakeGenerate();
  const h = await startHarness({ generate: g.deps });
  t.after(() => h.close());
  const gateId = await setup(h);
  await h.call('POST', p(`/gates/${gateId}`), { body: { action: 'confirm', selection: REFS, budgetCap: 0.5 } });
  await h.app.jobs.settled(ID);
  const after = g.img.submits.length;
  assert.ok(after > 0 && after < 20, `只提交了上限内的（${after}）`);
  await h.call('POST', p('/generate'), { body: { action: 'continue', gateId } });
  await h.app.jobs.settled(ID);
  assert.equal(g.img.submits.length, after);
  const spent = (await tasks(h)).reduce((a, x) => a + (x.costActual ?? 0), 0);
  assert.ok(spent <= 0.5 + 1e-9, `已花 ${spent} 不超过上限`);
});

test('服务启动时恢复：只查询、下载在途的，不提交新的；没有要恢复的什么都不做', async (t) => {
  const g = slow(15);
  const h = await startHarness({ generate: g.deps });
  t.after(() => h.close());
  const gateId = await setup(h);
  await h.app.resumeInterrupted();
  assert.equal(h.app.jobs.current(ID), null, '还没有任务：不开恢复');
  await h.call('POST', p(`/gates/${gateId}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  await waitFor('有任务提交了', () => g.img.submits.length > 0);
  await h.call('POST', p('/generate'), { body: { action: 'stop' } });
  await h.app.jobs.settled(ID);
  const submitted = (await tasks(h)).filter((x) => x.status === 'submitted' || x.status === 'running').map((x) => x.id);
  assert.ok(submitted.length > 0, '停下时有在途的');
  const before = g.img.submits.length;
  await h.app.resumeInterrupted();
  assert.equal(h.app.jobs.current(ID)?.kind, 'resume');
  await h.app.jobs.settled(ID);
  assert.equal(g.img.submits.length, before, '恢复不提交');
  const now = await tasks(h);
  for (const id of submitted) assert.equal(now.find((x) => x.id === id)!.status, 'collected');
  assert.ok(now.some((x) => x.status === 'planned'), '没提交的还是 planned');
});

test('凭据缺失：job-end 报怎么配，不带 key；任务停在 planned，不留「提交中」', async (t) => {
  const h = await startHarness({ generate: undefined });
  t.after(() => h.close());
  const gateId = await setup(h);
  const events = collectEvents(h, p('/events'), (e) => e.type === 'job-end');
  await waitFor('SSE 挂上', () => h.app.bus.subscribers(ID) > 0);
  await h.call('POST', p(`/gates/${gateId}`), { body: { action: 'confirm', selection: REFS } });
  await h.app.jobs.settled(ID);
  const end = (await events).find((e) => e.type === 'job-end')!;
  assert.equal(end['ok'], false);
  assert.match(String(end['message']), /没有 dashscope 的凭据：.*cred set dashscope/);
  const all = await tasks(h);
  assert.ok(all.length > 0 && all.every((x) => x.status === 'planned'), all.map((x) => x.status).join(','));
});

test('重新查询：没有这个任务 404；计划中的 400；有后台任务时 409；在途的查一次', async (t) => {
  const g = slow(15);
  const h = await startHarness({ generate: g.deps });
  t.after(() => h.close());
  const gateId = await setup(h);
  assert.equal((await h.call('POST', p('/tasks/1/requery'))).status, 404);
  assert.equal((await h.call('POST', p('/tasks/abc/requery'))).status, 400);
  await h.call('POST', p(`/gates/${gateId}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  await waitFor('有任务提交了', () => g.img.submits.length > 0);
  assert.equal((await h.call('POST', p('/tasks/1/requery'))).status, 409);
  await h.call('POST', p('/generate'), { body: { action: 'stop' } });
  await h.app.jobs.settled(ID);
  const all = await tasks(h);
  const planned = all.find((x) => x.status === 'planned')!;
  assert.equal((await h.call('POST', p(`/tasks/${planned.id}/requery`))).status, 400);
  const live = all.find((x) => x.status === 'submitted' || x.status === 'running')!;
  const r = await h.call('POST', p(`/tasks/${live.id}/requery`));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.id, live.id);
  assert.equal(g.img.submits.length, all.filter((x) => x.providerTaskId).length, '重新查询不提交');
});

test('素材接口：200 带 MIME 与长缓存；Range 206；越界 416；不存在 404；库里路径被改到 media/ 外 404；编号不对 400', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const gateId = await setup(h);
  await h.call('POST', p(`/gates/${gateId}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  await h.app.jobs.settled(ID);
  const view = (await h.call('GET', p('/tasks'))).body.data;
  const mediaId = view.characters[0].views[0].task.mediaId as number;
  assert.ok(mediaId > 0);
  const full = await h.call('GET', p(`/media/${mediaId}`));
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'image/png');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.match(String(full.headers['cache-control']), /immutable/);
  assert.equal(full.headers['x-content-type-options'], 'nosniff');
  assert.match(full.text, /^bytes of https:\/\/fake\//);
  const part = await h.call('GET', p(`/media/${mediaId}`), { headers: { range: 'bytes=0-4' } });
  assert.equal(part.status, 206);
  assert.equal(part.text, 'bytes');
  assert.equal(part.headers['content-range'], `bytes 0-4/${full.text.length}`);
  const tail = await h.call('GET', p(`/media/${mediaId}`), { headers: { range: 'bytes=-3' } });
  assert.equal(tail.text, full.text.slice(-3));
  assert.equal((await h.call('GET', p(`/media/${mediaId}`), { headers: { range: `bytes=${full.text.length + 10}-` } })).status, 416);
  assert.equal((await h.call('GET', p('/media/9999'))).status, 404);
  assert.equal((await h.call('GET', p('/media/1.0'))).status, 400);
  assert.equal((await h.call('GET', p('/media/-1'))).status, 400);
  await h.app.withProject(ID, (pr) => pr.db.prepare("UPDATE media_file SET rel_path = '../project.sqlite' WHERE id = ?").run(mediaId));
  const out = await h.call('GET', p(`/media/${mediaId}`));
  assert.equal(out.status, 404);
  assert.doesNotMatch(out.text, /sqlite|\.\./, '不说原因');
});

test('parseRange：单段、开放结尾、后缀、越界、看不懂的', async () => {
  const { parseRange } = await import('../src/server/media-route.ts');
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=2-', 10), { start: 2, end: 9 });
  assert.deepEqual(parseRange('bytes=5-100', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.deepEqual(parseRange('bytes=-40', 10), { start: 0, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'bad');
  assert.equal(parseRange('bytes=5-2', 10), 'bad');
  assert.equal(parseRange('bytes=-0', 10), 'bad');
  assert.equal(parseRange(undefined, 10), null);
  assert.equal(parseRange('bytes=0-1,3-4', 10), null, '多段不支持：回整个文件');
  assert.equal(parseRange('items=0-1', 10), null);
});

test('任务页：确认单摘要；按角色 × 5 视图分组；新确认单跳过的视图带沿用的那张；详情有提示词、参考图与事件；全貌带进度', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  assert.equal((await h.call('GET', p('/tasks'))).status, 404, '没有项目');
  const first = await setup(h);
  const empty = (await h.call('GET', p('/tasks'))).body.data;
  assert.deepEqual([empty.gates.length, empty.gate], [0, null], '还没有已确认的：空状态');
  await h.call('POST', p(`/gates/${first}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  await h.app.jobs.settled(ID);
  const second = await h.app.withProject(ID, (pr) => createPaidGate(pr.db, { orchestrationId: null, estimate: testEstimate(pr.db) }).id);
  const gv = (await h.call('GET', p(`/gates/${second}`))).body.data;
  assert.deepEqual(gv.planErrors, {});
  assert.equal(gv.skipByNode['image:character-refs'].count, 20, '弹窗：20 张都出过，会跳过');
  assert.ok(gv.skipByNode['image:character-refs'].cny > 0);
  await h.call('POST', p(`/gates/${second}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  await h.app.jobs.settled(ID);

  const v = (await h.call('GET', p('/tasks'))).body.data;
  assert.deepEqual(v.gates.map((g: { id: number }) => g.id), [second, first], '新的在前');
  assert.equal(v.gate.id, second);
  assert.equal(v.gate.total, 0, '全部跳过：没建任务');
  assert.equal(v.characters.length, 4);
  assert.deepEqual(v.characters[0].views.map((c: { view: string }) => c.view), ['front-full', 'face-front', 'side-full', 'back-full', 'face-45']);
  const reused = v.characters[0].views[0];
  assert.equal(reused.task, null, '第二张没建锚点任务');
  assert.equal(reused.reuseOf.gateId, first, '沿用第一张的');
  assert.ok(reused.reuseOf.mediaId > 0, '能显示出过的那张图');
  const old = (await h.call('GET', p(`/tasks?gate=${first}`))).body.data;
  assert.equal(old.gate.total, 20);
  assert.equal(old.gate.counts.collected, 20);
  assert.ok(old.gate.spent > 0);
  const anchor = old.characters[0].views[0];
  assert.equal(anchor.task.status, 'collected');
  assert.equal(anchor.reuseOf, null);
  assert.equal((await h.call('GET', p('/tasks?gate=999'))).status, 404);
  assert.equal((await h.call('GET', p('/tasks?gate=x'))).status, 400);

  const side = old.characters[0].views[2].task;
  const d = (await h.call('GET', p(`/tasks/${side.id}`))).body.data;
  assert.ok(d.prompt.length > 20);
  assert.equal(d.planDiffers, false);
  assert.equal(d.refs.length, 1);
  assert.equal(d.refs[0].task.id, anchor.task.id, '参考图是锚点');
  assert.deepEqual(d.events.map((e: { status: string }) => e.status), ['planned', 'submitting', 'submitted', 'succeeded', 'collected']);
  assert.equal((await h.call('GET', p('/tasks/999'))).status, 404);

  const o = (await h.call('GET', p('/overview'))).body.data;
  assert.equal(o.generation.gateId, first, '最近一张有任务的');
  assert.deepEqual([o.generation.total, o.generation.done, o.generation.failed, o.generation.running], [20, 20, 0, false]);
  assert.deepEqual(o.generation.byNode.map((n: { node: string }) => n.node), ['image:character-refs']);
});

test('重新查询和后台任务互斥：占着锁时开生成 409；别的网站来取素材 403；符号链接指到 media/ 外 404', async (t) => {
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const h = await startHarness();
  t.after(() => h.close());
  const gateId = await setup(h);
  let release!: () => void;
  const held = h.app.jobs.exclusive(ID, '重新查询任务 1', () => new Promise<void>((r) => (release = r)));
  assert.throws(() => h.app.jobs.generate(ID, gateId), /已有任务在跑/);
  assert.equal((await h.call('POST', p('/tasks/1/requery'))).status, 409, '重新查询之间也互斥');
  assert.equal((await h.call('POST', p('/generate'), { body: { action: 'continue' } })).status, 400, '没给 gateId');
  release();
  await held;
  assert.equal(h.app.jobs.current(ID), null, '放开了');

  const second = await h.app.withProject(ID, (pr) => createPaidGate(pr.db, { orchestrationId: null, estimate: testEstimate(pr.db) }).id);
  await h.call('POST', p(`/gates/${second}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  await h.app.jobs.settled(ID);
  const mediaId = (await h.call('GET', p('/tasks'))).body.data.characters[0].views[0].task.mediaId as number;
  assert.equal((await h.call('GET', p(`/media/${mediaId}`), { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await h.call('GET', p(`/media/${mediaId}`), { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
  const dir = join(h.app.config.projectsRoot, ID);
  mkdirSync(join(dir, 'media', 'zz'), { recursive: true });
  symlinkSync(join(dir, 'project.sqlite'), join(dir, 'media', 'zz', 'link.png'));
  await h.app.withProject(ID, (pr) => pr.db.prepare("UPDATE media_file SET rel_path = 'media/zz/link.png' WHERE id = ?").run(mediaId));
  assert.equal((await h.call('GET', p(`/media/${mediaId}`))).status, 404);
});

test('角色卡缺出图提示词（旧项目没重跑角色阶段）：弹窗按节点报计划错；硬确认了后台失败，任务页、全貌都说清楚原因；修好后继续生成就没有了', async (t) => {
  const { importArtifact } = await import('../src/import/import-artifact.ts');
  const { loadFixture } = await import('./helpers.ts');
  const h = await startHarness();
  t.after(() => h.close());
  const gateId = await setup(h);
  const cast = loadFixture('cast');
  await h.app.withProject(ID, (pr) => importArtifact(pr, 'cast', { ...cast, characters: cast.characters.map((c: Record<string, unknown>) => ({ ...c, characterRefs: undefined })) }));
  const gv = (await h.call('GET', p(`/gates/${gateId}`))).body.data;
  assert.match(gv.planErrors['image:character-refs'], /没有出图提示词：先重跑角色阶段/);
  assert.equal(gv.planErrors['image:keyframe'], undefined, '关键帧不受影响');

  await h.call('POST', p(`/gates/${gateId}`), { body: { action: 'confirm', selection: REFS, budgetCap: 12 } });
  await h.app.jobs.settled(ID);
  const v = (await h.call('GET', p('/tasks'))).body.data;
  assert.equal(v.gate.total, 0);
  assert.match(v.gate.error, /先重跑角色阶段/);
  const o = (await h.call('GET', p('/overview'))).body.data;
  assert.equal(o.generation.gateId, gateId, '没任务也显示这张');
  assert.match(o.generation.error, /先重跑角色阶段/);

  // 服务重启（失败记录没了）：没任务时预览计划，照样说得出原因
  const fresh = { ...h.app.genContext(ID), failure: null };
  const { tasksView } = await import('../src/server/views/generation.ts');
  assert.match((await h.app.withProject(ID, (pr) => tasksView(pr, fresh))).gate!.error!, /先重跑角色阶段/);

  await h.app.withProject(ID, (pr) => importArtifact(pr, 'cast', cast));
  await h.call('POST', p('/generate'), { body: { action: 'continue', gateId } });
  await h.app.jobs.settled(ID);
  const after = (await h.call('GET', p('/tasks'))).body.data;
  assert.equal(after.gate.error, null);
  assert.equal(after.gate.counts.collected, 20);
});

test('关键帧计划不出来：视频也不能勾，原因带上关键帧的；失败过后全部出完就不再提旧的错', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const gateId = await setup(h);
  // 分镜画幅改成不支持的：关键帧、视频都计划不出来，角色参考图不受影响
  const { importArtifact } = await import('../src/import/import-artifact.ts');
  const { loadFixture } = await import('./helpers.ts');
  const board = loadFixture('storyboard');
  await h.app.withProject(ID, (pr) => importArtifact(pr, 'storyboard', { ...board, aspectRatio: '4:3' }));
  const gv = (await h.call('GET', p(`/gates/${gateId}`))).body.data;
  assert.match(gv.planErrors['image:keyframe'], /画幅 4:3 不支持/);
  assert.match(gv.planErrors['video:segment'], /要先有关键帧.*画幅 4:3 不支持/);
  assert.equal(gv.planErrors['image:character-refs'], undefined);

  await h.app.withProject(ID, (pr) => importArtifact(pr, 'storyboard', board));
  await h.call('POST', p(`/gates/${gateId}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  await h.app.jobs.settled(ID);
  const ctx = { ...h.app.genContext(ID), failure: { gateId, message: '以前的错', at: new Date().toISOString() } };
  const { tasksView, generationProgress } = await import('../src/server/views/generation.ts');
  const v = await h.app.withProject(ID, (pr) => tasksView(pr, ctx));
  assert.equal(v.gate!.error, null, '全部出完了，不提旧的错');
  assert.equal((await h.app.withProject(ID, (pr) => generationProgress(pr.db, ctx)))!.error, null);
});

test('已确认、还没开跑、能计划出来的确认单：全貌和任务页都算「待开始」并给出要建几条，不当成「都生成过了」', async (t) => {
  const g = slow(15);
  const h = await startHarness({ generate: g.deps });
  t.after(() => h.close());
  const gateId = await setup(h);
  // 模拟「确认时有别的任务在跑，没开跑」：直接改库为已确认，不触发生成
  const { decidePaidGate } = await import('../src/repo/paid-gates.ts');
  await h.app.withProject(ID, (pr) => decidePaidGate(pr.db, gateId, { status: 'confirmed', selection: REFS, budgetCap: 12 }));
  const o = (await h.call('GET', p('/overview'))).body.data;
  assert.ok(o.generation, '全貌要显示这张确认单');
  assert.equal(o.generation.gateId, gateId);
  assert.equal(o.generation.error, null);
  assert.equal(o.generation.toCreate, 20, '开跑会建 20 条');
  assert.deepEqual(o.generation.selected, ['image:character-refs']);
  const v = (await h.call('GET', p('/tasks'))).body.data;
  assert.equal(v.gate.total, 0);
  assert.equal(v.gate.toCreate, 20);
  // 开跑之后就不再是「待开始」
  await h.call('POST', p('/generate'), { body: { action: 'continue', gateId } });
  await h.app.jobs.settled(ID);
  const after = (await h.call('GET', p('/tasks'))).body.data;
  assert.equal(after.gate.toCreate, null);
  assert.equal(after.gate.counts.collected, 20);
});

test('同样的输入都生成过的新确认单：没有要建的，不算「待开始」，全貌退回显示有任务的那张', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const first = await setup(h);
  await h.call('POST', p(`/gates/${first}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  await h.app.jobs.settled(ID);
  const second = await h.app.withProject(ID, (pr) => createPaidGate(pr.db, { orchestrationId: null, estimate: testEstimate(pr.db) }).id);
  const { decidePaidGate } = await import('../src/repo/paid-gates.ts');
  await h.app.withProject(ID, (pr) => decidePaidGate(pr.db, second, { status: 'confirmed', selection: REFS, budgetCap: 12 }));
  const o = (await h.call('GET', p('/overview'))).body.data;
  assert.equal(o.generation.gateId, first);
  assert.equal(o.generation.toCreate, null);
  const v = (await h.call('GET', p('/tasks'))).body.data;
  assert.equal(v.gate.id, second);
  assert.equal(v.gate.toCreate, 0, '都生成过了：要建 0 条');
});

test('开新确认单：没有等待确认的就按当前估算开一张；已有等待的就返回那张；需复核的集也能开；在跑时 409', async (t) => {
  const g = slow(15);
  const h = await startHarness({ generate: g.deps });
  t.after(() => h.close());
  const first = await setup(h);
  // 已有等待确认的：不另开
  const same = await h.call('POST', p('/gates'));
  assert.equal(same.status, 200, same.text);
  assert.equal(same.body.data.id, first);
  assert.equal(same.body.data.created, false);
  // 用掉它（确认后在跑）：在跑时开新单 409
  await h.call('POST', p(`/gates/${first}`), { body: { action: 'confirm', selection: REFS, budgetCap: 50 } });
  assert.equal((await h.call('POST', p('/gates'))).status, 409);
  await h.call('POST', p('/generate'), { body: { action: 'stop' } });
  await h.app.jobs.settled(ID);
  // 让第 1 集分镜需复核
  const { importArtifact } = await import('../src/import/import-artifact.ts');
  const { loadFixture } = await import('./helpers.ts');
  await h.app.withProject(ID, (pr) => {
    const script = loadFixture('script');
    script.episodes[0].scenes[0].flow[0].action = '汽笛提前响了。';
    importArtifact(pr, 'script', script);
  });
  const r = await h.call('POST', p('/gates'));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.created, true);
  const gid = r.body.data.id as number;
  assert.ok(gid > first);
  const gv = (await h.call('GET', p(`/gates/${gid}`))).body.data;
  assert.equal(gv.gate.status, 'awaiting_confirmation');
  assert.equal(gv.gate.orchestrationId, null);
  assert.ok(gv.episodes.some((e: { state: string }) => e.state === 'stale'), '需复核的集照样列出、标 stale');
  assert.equal((await h.call('GET', p('/overview'))).body.data.gate.id, gid, '全貌看到这张等待确认的');
});

test('开新确认单：估算失败回 400 并说原因', async (t) => {
  const h = await startHarness({ estimate: () => { throw new Error('价格表里没有 qwen-image-3.0'); } });
  t.after(() => h.close());
  const project = createProject(join(h.app.config.projectsRoot, ID), ID);
  await setupNovel(project);
  importAll(project);
  project.close();
  const r = await h.call('POST', p('/gates'));
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /估算失败.*价格表里没有/);
});

test('开新确认单：别的进程（命令行 go）在跑编排时 409，不按跑到一半的估算开单', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await setup(h);
  const { startOrchestration } = await import('../src/repo/orchestrations.ts');
  // 模拟另一个还活着的进程开的编排：pid 用父进程的
  await h.app.withProject(ID, (pr) => {
    const oid = startOrchestration(pr.db, 'all');
    pr.db.prepare('UPDATE orchestration SET pid = ? WHERE id = ?').run(process.ppid, oid);
    pr.db.prepare("UPDATE paid_gate SET status = 'cancelled'").run();
  });
  const r = await h.call('POST', p('/gates'));
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /文本阶段正在跑/);
});

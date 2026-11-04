// 变更类操作：一键跑、打回、复核确认、付费确认（确认后开跑）、继续 / 停止生成、重新查询、换预设与节点模型、换挂载、注册 skill 包、拉价格。
// 跑模型的操作开后台任务立即返回；其余同步完成。所有变更请求都要令牌（server.ts 统一检查）。
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { isStage, type Stage } from '../../domain/types.ts';
import { RECIPE_NAMES } from '../../executor/recipes.ts';
import { isNode } from '../../model/capabilities.ts';
import { acknowledge } from '../../orchestrate/review-matrix.ts';
import { checkReject, resolveEpisode } from '../../orchestrate/revisions.ts';
import { requeryTask } from '../../generate/manage.ts';
import { refreshPriceCache } from '../../pricing/openrouter.ts';
import { listOrchestrations } from '../../repo/orchestrations.ts';
import { getPaidGate } from '../../repo/paid-gates.ts';
import { getTask } from '../../repo/tasks.ts';
import { clearNodeModel, setNodeModel, usePreset } from '../../repo/models.ts';
import { dismissRevision, revisionDismissed } from '../../repo/revisions.ts';
import { mountSkill, registerPack } from '../../repo/skills.ts';
import { HttpError, optStr, readBody, str } from '../http.ts';
import { route, type Route } from '../route.ts';
import { decideGate, openGate } from '../views/gates.ts';
import { docOf, episodesIn } from '../views/common.ts';
import { estimateProject } from '../../estimate/estimate.ts';
import { gateId, taskId } from './views.ts';

/** 能重新查询的：提交过、还没结束（含查询放弃了的）、结果未知、成功了但没下载下来。 */
const REQUERYABLE: ReadonlySet<string> = new Set(['submitted', 'running', 'unknown', 'succeeded']);

const stageOf = (raw: unknown): Stage => {
  if (!isStage(raw)) throw new HttpError(400, `不认识的阶段：${String(raw)}`);
  return raw;
};

const stringRecord = (x: unknown): Record<string, string> => {
  if (x === undefined || x === null) return {};
  if (typeof x !== 'object' || Array.isArray(x) || !Object.values(x).every((v) => typeof v === 'string')) throw new HttpError(400, 'params 应该是字符串到字符串的对象');
  return x as Record<string, string>;
};

export const ACTION_ROUTES: readonly Route[] = [
  route('POST', '/api/p/:id/go', async ({ app, params, req }) => {
    const id = params['id']!;
    const body = await readBody(req);
    const mode = body['mode'] ?? 'all';
    if (mode !== 'all' && mode !== 'only-stale') throw new HttpError(400, 'mode 只能是 all 或 only-stale');
    const only = body['only'] === undefined ? undefined : stageOf(body['only']);
    const fresh = body['fresh'];
    if (fresh !== undefined && typeof fresh !== 'boolean') throw new HttpError(400, 'fresh 应该是 true 或 false');
    if (fresh && only === undefined) throw new HttpError(400, '整份重写只能针对单个阶段（配合 only）');
    await app.withProject(id, () => null);
    return app.jobs.go(id, mode, only, fresh);
  }),
  route('POST', '/api/p/:id/reject', async ({ app, params, req }) => {
    const id = params['id']!;
    const body = await readBody(req);
    const stage = stageOf(body['stage']);
    const episode = optStr(body, 'episode');
    const checked = await app.withProject(id, (p) => {
      const c = checkReject(p.db, stage, { note: str(body, 'note'), ...(episode ? { episode } : {}) });
      // 集号给任务说明用（「打回分镜（第 02 集）」），集 id 人看不懂
      const ep = c.episode ? episodesIn(docOf(p.db, 'outline')).find((e) => e['id'] === c.episode)?.['ep'] : undefined;
      return { ...c, epNo: typeof ep === 'number' ? ep : undefined };
    });
    return app.jobs.reject(id, stage, checked.note, checked.episode ?? undefined, checked.epNo);
  }),
  route('POST', '/api/p/:id/revisions/:rid/dismiss', async ({ app, params }) => {
    const rid = Number(params['rid']);
    if (!Number.isSafeInteger(rid) || rid < 1 || String(rid) !== params['rid']) throw new HttpError(400, '打回意见编号应该是正整数');
    return app.withProject(params['id']!, (p) => {
      const dismissed = revisionDismissed(p.db, rid);
      if (dismissed === null) throw new HttpError(404, `没有这条打回意见：${rid}`);
      if (dismissed) throw new HttpError(409, '这条打回意见已经放弃了');
      dismissRevision(p.db, rid);
      return { ok: true };
    });
  }),
  route('POST', '/api/p/:id/review', async ({ app, params, req }) => {
    const body = await readBody(req);
    const stage = stageOf(body['stage']);
    const episode = optStr(body, 'episode');
    return app.withProject(params['id']!, (p) => acknowledge(p.db, stage, episode ? resolveEpisode(p.db, episode) : null, optStr(body, 'note') ?? ''));
  }),
  // 开确认单：没有等待确认的就按当前估算开一张；有后台任务在跑时不开（跑完再估算才准）
  route('POST', '/api/p/:id/gates', ({ app, params }) => {
    const id = params['id']!;
    const busy = app.jobs.current(id);
    if (busy) throw new HttpError(409, `这个项目已有任务在跑（${busy.detail}），等它结束再开确认单`);
    return app.withProject(id, (p) => {
      // 别的进程（命令行 go）在跑编排：本进程的任务锁看不到，按库里的编排状态挡（withProject 已经收尾了死掉的）
      if (listOrchestrations(p.db).at(-1)?.status === 'running') throw new HttpError(409, '文本阶段正在跑（可能是命令行），等它结束再开确认单');
      return openGate(p, () => (app.config.estimate ? app.config.estimate(p.db) : estimateProject(p.db, app.config.presetDirs ? { presetDirs: app.config.presetDirs } : {})));
    });
  }),
  // 确认后直接开跑付费生成；项目已有后台任务时只确认，返回 started: false 和原因（结束后到生成任务页点继续生成）
  route('POST', '/api/p/:id/gates/:gid', async ({ app, params, req }) => {
    const id = params['id']!;
    const body = await readBody(req);
    const gate = await app.withProject(id, (p) => decideGate(p, gateId(params['gid']), { action: str(body, 'action'), selection: body['selection'], budgetCap: body['budgetCap'] }));
    if (gate.status !== 'confirmed') return { gate, started: false };
    const busy = app.jobs.current(id);
    if (busy) return { gate, started: false, reason: `当前在跑「${busy.detail}」：等它结束后到生成任务页点「继续生成」` };
    app.jobs.generate(id, gate.id);
    return { gate, started: true };
  }),
  // 继续生成（预算停了、停止过、确认时有别的任务在跑）或停止
  route('POST', '/api/p/:id/generate', async ({ app, params, req }) => {
    const id = params['id']!;
    const body = await readBody(req);
    const action = str(body, 'action');
    if (action === 'stop') return app.jobs.stop(id);
    if (action !== 'continue') throw new HttpError(400, 'action 只能是 continue 或 stop');
    if (body['gateId'] === undefined) throw new HttpError(400, '继续生成要给 gateId（哪张确认单）');
    const gid = gateId(String(body['gateId']));
    await app.withProject(id, (p) => {
      const gate = getPaidGate(p.db, gid);
      if (!gate) throw new HttpError(404, `没有这张付费确认单：${gid}`);
      if (gate.status !== 'confirmed') throw new HttpError(400, `确认单 #${gid} 还没确认（${gate.status}），先在全貌上确认`);
    });
    return app.jobs.generate(id, gid);
  }),
  // 重新查询（不花钱）：只查询、下载，不提交
  route('POST', '/api/p/:id/tasks/:tid/requery', async ({ app, params }) => {
    const id = params['id']!;
    const tid = taskId(params['tid']);
    // 同步占住项目锁再开始：和后台生成互斥，免得同一个任务被两边一起查询、下载入库
    return app.jobs.exclusive(id, `重新查询任务 ${tid}`, () => app.withProject(id, async (p) => {
      const task = getTask(p.db, tid);
      if (!task) throw new HttpError(404, `没有这个任务：${tid}`);
      if (!REQUERYABLE.has(task.status)) throw new HttpError(400, `任务 ${tid} 是「${task.status}」，不用重新查询（只有提交过、还没结束或结果未知、没下载下来的可以）`);
      const after = await requeryTask(p, tid, app.generateDeps());
      return { id: after.id, status: after.status, error: after.error };
    }));
  }),
  route('POST', '/api/p/:id/models', async ({ app, params, req }) => {
    const body = await readBody(req);
    const action = str(body, 'action');
    return app.withProject(params['id']!, (p) => {
      if (action === 'preset') return usePreset(p.db, str(body, 'preset'), app.config.presetDirs), { ok: true };
      const node = str(body, 'node');
      if (!isNode(node)) throw new HttpError(400, `不认识的节点：${node}`);
      if (action === 'set') return setNodeModel(p.db, node, { model: str(body, 'model'), params: stringRecord(body['params']) }), { ok: true };
      if (action === 'clear') return clearNodeModel(p.db, node), { ok: true };
      throw new HttpError(400, 'action 只能是 preset / set / clear');
    });
  }),
  route('POST', '/api/p/:id/mount', async ({ app, params, req }) => {
    const body = await readBody(req);
    const packId = body['packId'] === undefined ? undefined : Number(body['packId']);
    return app.withProject(params['id']!, (p) => mountSkill(p.db, stageOf(body['stage']), str(body, 'skill'), packId));
  }),
  route('POST', '/api/p/:id/packs', async ({ app, params, req }) => {
    const body = await readBody(req);
    const manifestPath = resolve(str(body, 'manifest'));
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      // 不回显解析错误：Node 的 JSON 报错会带出文件内容片段
      throw new HttpError(400, `读不了清单或不是合法 JSON：${manifestPath}`);
    }
    return app.withProject(params['id']!, (p) => registerPack(p.db, manifest, resolve(str(body, 'root')), RECIPE_NAMES));
  }),
  route('POST', '/api/prices/refresh', async () => {
    const r = await refreshPriceCache();
    return { updated: r.entries.length, problems: r.problems, path: r.path };
  }),
];

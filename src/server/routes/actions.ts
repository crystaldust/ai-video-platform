// 变更类操作：一键跑、打回、复核确认、付费确认、换预设与节点模型、换挂载、注册 skill 包、拉价格。
// 跑模型的操作开后台任务立即返回；其余同步完成。所有变更请求都要令牌（server.ts 统一检查）。
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { isStage, type Stage } from '../../domain/types.ts';
import { RECIPE_NAMES } from '../../executor/recipes.ts';
import { isNode } from '../../model/capabilities.ts';
import { acknowledge } from '../../orchestrate/review-matrix.ts';
import { checkReject, resolveEpisode } from '../../orchestrate/revisions.ts';
import { refreshPriceCache } from '../../pricing/openrouter.ts';
import { clearNodeModel, setNodeModel, usePreset } from '../../repo/models.ts';
import { dismissRevision, revisionDismissed } from '../../repo/revisions.ts';
import { mountSkill, registerPack } from '../../repo/skills.ts';
import { HttpError, optStr, readBody, str } from '../http.ts';
import { route, type Route } from '../route.ts';
import { decideGate } from '../views/gates.ts';
import { gateId } from './views.ts';

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
    const checked = await app.withProject(id, (p) => checkReject(p.db, stage, { note: str(body, 'note'), ...(episode ? { episode } : {}) }));
    return app.jobs.reject(id, stage, checked.note, checked.episode ?? undefined);
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
  route('POST', '/api/p/:id/gates/:gid', async ({ app, params, req }) => {
    const body = await readBody(req);
    return app.withProject(params['id']!, (p) => decideGate(p, gateId(params['gid']), { action: str(body, 'action'), selection: body['selection'], budgetCap: body['budgetCap'] }));
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

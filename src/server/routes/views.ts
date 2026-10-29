// 各页面的只读数据与进度事件流。
import { route, type Route } from '../route.ts';
import { HttpError } from '../http.ts';
import { castView } from '../views/cast.ts';
import { projectHead } from '../views/common.ts';
import { episodeDetail } from '../views/episode.ts';
import { gateView } from '../views/gates.ts';
import { modelsView } from '../views/models.ts';
import { overview } from '../views/overview.ts';
import { skillsView } from '../views/skills.ts';

const gateId = (raw: string | undefined): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `确认单编号不对：${String(raw)}`);
  return n;
};

export const VIEW_ROUTES: readonly Route[] = [
  // 侧栏的项目头：轻量，不跑质量门、不估算
  route('GET', '/api/p/:id/head', ({ app, params }) => app.withProject(params['id']!, (p) => ({ ...projectHead(p, params['id']!), job: app.jobs.current(params['id']!) }))),
  route('GET', '/api/p/:id/overview', ({ app, params }) => app.withProject(params['id']!, (p) => overview(app, p, params['id']!))),
  route('GET', '/api/p/:id/episodes/:ep', ({ app, params }) => app.withProject(params['id']!, (p) => episodeDetail(p, params['id']!, params['ep']!))),
  route('GET', '/api/p/:id/cast', ({ app, params }) => app.withProject(params['id']!, (p) => castView(p, params['id']!))),
  route('GET', '/api/p/:id/skills', ({ app, params }) => app.withProject(params['id']!, (p) => skillsView(p, params['id']!))),
  route('GET', '/api/p/:id/models', ({ app, params }) => app.withProject(params['id']!, (p) => modelsView(app, p, params['id']!))),
  route('GET', '/api/p/:id/gates/:gid', ({ app, params }) => app.withProject(params['id']!, (p) => gateView(p, gateId(params['gid'])))),
  // SSE：先确认项目存在，再把连接挂上事件总线；首条事件带当前任务，页面据此决定显示运行中还是全貌
  route('GET', '/api/p/:id/events', async ({ app, params, res }) => {
    const id = params['id']!;
    await app.withProject(id, () => null);
    app.bus.subscribe(id, res, { type: 'hello', job: app.jobs.current(id) });
    return undefined;
  }),
];

export { gateId };

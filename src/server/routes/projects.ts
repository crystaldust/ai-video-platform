// 项目列表、新建项目、服务配置。
import { route, type Route } from '../route.ts';
import { readBody, str } from '../http.ts';
import { displayPath, listProjects, newProject } from '../views/projects.ts';
import { readFileSync } from 'node:fs';
import { loadPresets } from '../../presets/presets.ts';

/** 新建项目会注册的 skill 包：名字、说明、有阶段的 skill。清单读不了就是 null。 */
function packSummary(path: string): { name: string; description: string; stages: string[] } | null {
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; description?: string; skills?: { name: string; stage: string | null }[] };
    return { name: m.name ?? '', description: m.description ?? '', stages: (m.skills ?? []).filter((x) => x.stage).map((x) => x.name.replace(/^novel-/, '')) };
  } catch {
    return null;
  }
}

export const PROJECT_ROUTES: readonly Route[] = [
  route('GET', '/api/config', ({ app }) => ({
    projectsRoot: displayPath(app.config.projectsRoot),
    canCreate: app.config.skillsRoot !== null,
    pack: packSummary(app.config.packManifest),
    presets: loadPresets(app.config.presetDirs).map((p) => ({ name: p.name, title: p.title, description: p.description })),
  })),
  route('GET', '/api/projects', ({ app }) => listProjects(app)),
  route('POST', '/api/projects', async ({ app, req }) => {
    const body = await readBody(req);
    const created = await newProject(app, {
      name: str(body, 'name'),
      kind: str(body, 'kind') as 'synopsis' | 'novel',
      text: str(body, 'text'),
      params: body['params'],
      ...(typeof body['preset'] === 'string' ? { preset: body['preset'] } : {}),
    });
    // 「一键跑完文本阶段」：建好就开跑
    const job = body['start'] === true ? app.jobs.go(created.id, 'all') : null;
    return { ...created, job };
  }),
];

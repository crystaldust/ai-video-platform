// E2E 用的本地服务：真实的服务与前端构建产物，模型换成吐渡口样例的假模型（每次调用慢一点，好看到运行中状态），
// 项目根目录是临时目录，估算只读仓库内置价格。不出网、不花钱。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../../src/server/app.ts';
import { startServer } from '../../src/server/server.ts';
import { fenced, RoutedTextModel } from '../../test/support/scripted-model.ts';
import { dukoAnswer } from '../../test/support/duko-model.ts';
import { loadFixture } from '../../test/helpers.ts';
import { PRESET_DIRS, testEstimate } from '../../test/support/server-harness.ts';
import { ROOT, SKILLS } from '../../test/support/novel-pack.ts';

const PORT = Number(process.env['E2E_PORT'] ?? 5199);
const DELAY_MS = 120;

/** 打回剧本时按意见改第一拍（假模型原样交回的话，下游不会出现需复核） */
function answer(user: string): string | undefined {
  if (user.includes('【作者意见') && user.includes('补全 scenes')) {
    const range = /第 (\d+)–(\d+) 集/.exec(user);
    const [a, b] = range ? [Number(range[1]), Number(range[2])] : [1, 99];
    const episodes = loadFixture('script').episodes.filter((e: { ep: number }) => e.ep >= a && e.ep <= b);
    for (const e of episodes) e.scenes[0].flow[0].action = `（按意见改）${e.scenes[0].flow[0].action}`;
    return fenced({ episodes });
  }
  return dukoAnswer({ system: '', user });
}

const model = new RoutedTextModel((req) => answer(req.user));
const slow = { id: model.id, complete: async (req: Parameters<typeof model.complete>[0]) => (await new Promise((r) => setTimeout(r, DELAY_MS)), model.complete(req)) };

const app = new App({
  projectsRoot: mkdtempSync(join(tmpdir(), 'avp-e2e-')),
  packManifest: join(ROOT, 'packs', 'novel.pack.json'),
  skillsRoot: SKILLS,
  staticDir: join(ROOT, 'web', 'dist'),
  log: (l) => process.stderr.write(`${l}\n`),
  modelFor: () => slow,
  estimate: testEstimate,
  run: { prices: null },
  credentials: { env: {}, dir: '/nonexistent-avp' },
  presetDirs: PRESET_DIRS,
});
const server = await startServer(app, { port: PORT });
process.stderr.write(`e2e server ${server.url}\n`);

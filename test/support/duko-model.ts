// 测试用：按提示词作答、吐渡口样例的模型。像一个「守规矩」的模型：已有的 id 原样保留，
// 分镜每场第一段照抄提示词里给的开场走位句。并发跑几个阶段时也能答对（按内容路由，不按顺序）。
import type { TextRequest } from '../../src/model/text-model.ts';
import { loadFixture } from '../helpers.ts';
import { fenced, promptSection, RoutedTextModel } from './scripted-model.ts';

type Doc = Record<string, any>;

/** 【只写这几集】第 a–b 集 → [a, b]；没有就是全部。 */
function range(user: string): [number, number] {
  const m = (promptSection(user, '只写这几集') ?? '').match(/第 (\d+)–(\d+) 集/);
  return m ? [Number(m[1]), Number(m[2])] : [1, Number.MAX_SAFE_INTEGER];
}
const inRange = (user: string) => {
  const [a, b] = range(user);
  return (x: { ep: number }) => x.ep >= a && x.ep <= b;
};

/** 【开场走位…】段：sceneRef → 走位句 */
function openings(user: string): Map<string, string> {
  const body = promptSection(user, '开场走位') ?? '';
  return new Map(body.split('\n').flatMap((l) => (/^sc_\w+：/.test(l) ? [[l.slice(0, l.indexOf('：')), l.slice(l.indexOf('：') + 1)] as [string, string]] : [])));
}

/** 分镜：每场第一段的 blocking 前面加上开场走位句；carry=false 时不加（模拟没照抄）。 */
export function storyboardEpisodes(user: string, carry = true): Doc[] {
  const lines = openings(user);
  return loadFixture('storyboard').episodes.filter(inRange(user)).map((ep: Doc) => {
    const seen = new Set<string>();
    return {
      ...ep,
      segments: ep.segments.map((seg: Doc) => {
        const first = !seen.has(seg.sceneRef);
        seen.add(seg.sceneRef);
        const line = lines.get(seg.sceneRef);
        return first && line && carry ? { ...seg, blocking: `${line}${seg.blocking}` } : seg;
      }),
    };
  });
}

/** 原创更夫的提示词：要和其他角色的写得不一样（validate 查雷同）。 */
const WATCHMAN = {
  image: 'A gaunt night watchman of a 1930s Jiangnan river ferry, Chinese, lifting an oiled-paper lantern on a bamboo pole, wooden clapper at his belt, patched quilted jacket, face half lost in fog',
  voice: 'A thin, carrying tenor that calls the hours across water; flat, rhythmic, almost chanting, with long pauses between the clapper strokes',
};

const draftName = (user: string): string | null => (promptSection(user, '这个角色的骨架') ?? '').match(/"name": "([^"]+)"/)?.[1] ?? null;

/** 各阶段各一遍的标准回答；认不出来的请求返回 undefined。 */
export function dukoAnswer(req: TextRequest): string | undefined {
  const u = req.user;
  const out = promptSection(u, '输出') ?? '';
  if (out.includes('outline.json 的骨架')) {
    const { episodes: _e, ...rest } = loadFixture('outline');
    return fenced({ ...rest, beats: rest.beats.map(({ episodeRef: _r, ...b }: Doc) => b) });
  }
  if (out.includes('每集写 ep（集号）')) return fenced({ episodes: loadFixture('outline').episodes.filter(inRange(u)) });
  if (out.includes('补全 scenes')) return fenced({ episodes: loadFixture('script').episodes.filter(inRange(u)) });
  if (out.includes('这一个角色的完整角色卡')) {
    // 大纲比原著样例多一个原创的功能角色（C05 更夫）：拿最后一张卡改成他，引文留空
    const name = draftName(u);
    const cards = loadFixture('cast').characters;
    const last = cards.at(-1);
    const card = cards.find((c: Doc) => c.name === name) ?? {
      ...last,
      name,
      aliases: [],
      importance: 'minor',
      persona: { ...last.persona, evidence: [], relationships: [] },
      image: { ...last.image, prompt: WATCHMAN.image, sheet: `Single character model sheet. ${WATCHMAN.image}`, promptLocal: '民国江南渡口的守夜更夫，提着油纸灯笼' },
      voice: { ...last.voice, prompt: WATCHMAN.voice },
    };
    return fenced(card);
  }
  if (out.includes('{"summary"')) return fenced({ summary: loadFixture('cast').summary });
  if (out.includes('{"scenes": [...]}：骨架里的每个场景')) return fenced({ scenes: loadFixture('art').scenes });
  if (out.includes('{"props"')) return fenced({ props: loadFixture('art').props });
  if (out.includes('{"locations"')) return fenced({ locations: loadFixture('staging').locations });
  if (out.includes('给 places 里每个人填')) return fenced({ scenes: loadFixture('staging').scenes.filter(inRange(u)) });
  if (out.includes('每切写 beatIds')) return fenced({ episodes: storyboardEpisodes(u) });
  return undefined;
}

/** override 先答（返回 undefined 就交给标准回答），用来模拟违规、修复。 */
export const dukoModel = (override?: (req: TextRequest, n: number) => string | undefined): RoutedTextModel =>
  new RoutedTextModel((req, n) => override?.(req, n) ?? dukoAnswer(req));

/** 渡口原文（角色卡的引文要逐字对得上它）。 */
export { DUKO_BOOK } from '../helpers.ts';

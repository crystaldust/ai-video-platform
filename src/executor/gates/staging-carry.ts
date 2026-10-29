// staging-carry 平台门：分镜每一场第一段的 blocking 必须照抄站位给出的开场走位句。
// 走位句由 novel-staging 的 blocking 命令按站位写出（每场一行「场次标签\t走位句」，顺序同 staging.json 的 scenes），
// 平台把它和 sceneRef 对上，再逐场检查——这一段原本是分镜自己编的，人看不到、改不动。
import { listOf, type Check } from '../recipe-kit.ts';

/** 比较前去掉所有空白：模型常在中文句子里多加或少加空格、换行。 */
const squash = (s: string): string => s.replace(/\s+/g, '');

/** blocking 命令的输出 → 场次 id（sceneRef）→ 开场走位句。行数和站位场次数对不上就报错（输出格式变了）。 */
export function parseBlocking(stdout: string, staging: unknown): Map<string, string> {
  const scenes = listOf(staging, 'scenes');
  const lines = stdout.split('\n').filter((l) => l.trim());
  if (lines.length !== scenes.length) throw new Error(`novel-staging blocking 输出 ${lines.length} 行，站位有 ${scenes.length} 场，对不上`);
  const out = new Map<string, string>();
  lines.forEach((line, i) => {
    const tab = line.indexOf('\t');
    const ref = scenes[i]!['sceneRef'];
    if (tab < 0) throw new Error(`novel-staging blocking 第 ${i + 1} 行没有制表符：${line}`);
    if (typeof ref === 'string') out.set(ref, line.slice(tab + 1).trim());
  });
  return out;
}

/** 每个有站位的场次，在分镜里的第一段的 blocking 要包含开场走位句；分镜没写到的场次不查。 */
export function stagingCarryViolations(storyboard: unknown, opening: ReadonlyMap<string, string>): string[] {
  const seen = new Set<string>();
  const violations: string[] = [];
  for (const ep of listOf(storyboard, 'episodes')) {
    for (const seg of listOf(ep, 'segments')) {
      const ref = seg['sceneRef'];
      if (typeof ref !== 'string' || seen.has(ref)) continue;
      seen.add(ref);
      const line = opening.get(ref);
      if (!line) continue;
      const blocking = typeof seg['blocking'] === 'string' ? seg['blocking'] : '';
      if (squash(blocking).includes(squash(line))) continue;
      const id = typeof seg['id'] === 'string' ? `段 ${seg['id']}` : `场次 ${ref} 的第一段`;
      violations.push(`${id}的 blocking 没有照抄站位的开场走位：『${line}』（场次 ${ref} 第一段的 blocking 要以这句开头）`);
    }
  }
  return violations;
}

export const stagingCarryCheck = (opening: ReadonlyMap<string, string>): Check => ({
  name: 'staging-carry',
  run: async (doc) => stagingCarryViolations(doc, opening),
});

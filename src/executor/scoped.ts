// 只重跑几集：配方交回的是只含这几集的文档，导入时只对这几集负责（其他集不退役、引用不重钉）；
// 产物版本库里存的仍要是整份文档——下游拿它当上游。这里把这几集并回当前的整份文档。
import type { Stage } from '../domain/types.ts';
import { isDoc, listOf, type Doc } from './recipe-kit.ts';

const num = (x: unknown): number => (Number.isInteger(x) ? (x as number) : Number.MAX_SAFE_INTEGER);
const byEp = (a: Doc, b: Doc): number => num(a['ep']) - num(b['ep']);
const byEpScene = (a: Doc, b: Doc): number => byEp(a, b) || num(a['scene']) - num(b['scene']);

/** 按 key 合并：part 里有的替换 full 里同 key 的，新的追加在后。 */
function mergeBy(full: readonly Doc[], part: readonly Doc[], key: string): Doc[] {
  const incoming = new Map(part.map((x) => [x[key], x]));
  const kept = full.map((x) => incoming.get(x[key]) ?? x);
  const known = new Set(full.map((x) => x[key]));
  return [...kept, ...part.filter((x) => !known.has(x[key]))];
}

/** 剧本、分镜按集 id 换集；站位按集号换场次（一集里删掉的场次跟着消失），认图按地点合并。 */
export function mergeScoped(stage: Stage, full: unknown, part: Doc): Doc {
  if (!isDoc(full)) return part;
  if (stage === 'script' || stage === 'storyboard') {
    return { ...full, episodes: mergeBy(listOf(full, 'episodes'), listOf(part, 'episodes'), 'id').sort(byEp) };
  }
  if (stage === 'staging') {
    const eps = new Set(listOf(part, 'scenes').map((s) => s['ep']));
    const scenes = [...listOf(full, 'scenes').filter((s) => !eps.has(s['ep'])), ...listOf(part, 'scenes')].sort(byEpScene);
    return { ...full, locations: mergeBy(listOf(full, 'locations'), listOf(part, 'locations'), 'sceneId'), scenes };
  }
  throw new Error(`${stage} 是整份负责的，不能只重跑其中几集`);
}

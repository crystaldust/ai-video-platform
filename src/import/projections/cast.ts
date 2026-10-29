// cast.json → 人物的角色卡侧面。卡片没有 id，按名字或别名对上大纲人物；
// 对不上就拒绝，不猜——大纲是人物清单的权威来源。
import type { EntityDraft, Projection, ProjectionContext } from '../../domain/types.ts';
import { arrayField, coverAll, entity, finish, isRecord, notObject, str, type Problems } from '../projection.ts';

type Match = { key: string } | { ambiguous: string } | null;

function matchKey(card: Record<string, unknown>, ctx: ProjectionContext): Match {
  const aliases = Array.isArray(card['aliases']) ? card['aliases'] : [];
  const names = [card['name'], ...aliases].map(str).filter(Boolean);
  for (const name of names) {
    if (ctx.ambiguousNames.has(name)) return { ambiguous: name };
    const key = ctx.characterKeyByName.get(name);
    if (key) return { key };
  }
  return null;
}

export function projectCast(doc: unknown, ctx: ProjectionContext): Projection {
  if (!isRecord(doc)) return notObject('cast.json');
  const problems: Problems = [];
  const entities = arrayField(doc, 'characters', problems, 'cast ').flatMap((card, i): EntityDraft[] => {
    if (!isRecord(card)) {
      problems.push(`角色卡第 ${i + 1} 张不是对象`);
      return [];
    }
    const label = str(card['name']) || `第 ${i + 1} 张`;
    const match = matchKey(card, ctx);
    if (!match) {
      problems.push(`cast 里的「${label}」在大纲人物表里找不到（先导入 outline，或检查名字）`);
      return [];
    }
    if ('ambiguous' in match) {
      problems.push(`cast 里的「${label}」按名字「${match.ambiguous}」匹配，但大纲里有重名人物，无法确定是谁`);
      return [];
    }
    // title 留空：显示名以大纲为准
    return [entity('character', match.key, '', 'cast', card)];
  });
  return finish(entities, [], problems, coverAll('cast', ['character']));
}

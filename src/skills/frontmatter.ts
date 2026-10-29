// SKILL.md 的 frontmatter 只读需要的几项：name、version、description。
// 不引入 YAML 解析器：skill 的 frontmatter 是固定写法（顶层标量 + `description: |` 块），按行读足够，也不会执行任何东西。

export interface SkillFrontmatter {
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

const FENCE = '---';

function frontmatterLines(md: string): string[] {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) throw new Error('SKILL.md 缺少 frontmatter（第一行应为 ---）');
  const end = lines.indexOf(FENCE, 1);
  if (end < 0) throw new Error('SKILL.md 的 frontmatter 没有结束标记 ---');
  return lines.slice(1, end);
}

const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, '$2');

export function parseFrontmatter(md: string): SkillFrontmatter {
  const lines = frontmatterLines(md);
  const scalar = (key: string): string => {
    const line = lines.find((l) => l.startsWith(`${key}:`));
    return line ? unquote(line.slice(key.length + 1)) : '';
  };
  const descIndex = lines.findIndex((l) => l.startsWith('description:'));
  let description = descIndex >= 0 ? unquote(lines[descIndex]!.slice('description:'.length)) : '';
  if (description === '|' || description === '>') {
    // 块标量：取紧随其后的缩进行
    const block: string[] = [];
    for (const l of lines.slice(descIndex + 1)) {
      if (l.trim() && !/^\s/.test(l)) break;
      block.push(l.trim());
    }
    description = block.join('\n').trim();
  }
  const name = scalar('name');
  const version = scalar('version');
  if (!name) throw new Error('SKILL.md 的 frontmatter 缺少 name');
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`SKILL.md（${name}）的 version 不是语义化版本号：${version || '（空）'}`);
  return { name, version, description };
}

export const majorOf = (version: string): number => Number(version.split('.')[0]);

/** 「边界（不做的事）」段：交给模型的系统提示里要带上，防止越界产出。没有就返回空串。 */
export function boundarySection(md: string): string {
  const paragraphs = md.split(/\n\s*\n/);
  return paragraphs.find((p) => p.trimStart().startsWith('**边界'))?.trim() ?? '';
}

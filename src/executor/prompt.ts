// 提示词装配：系统提示 = 平台规则 + skill 的描述与「边界」段；用户提示 = 本遍任务 + 数据结构 + 参数 + 上游 + 骨架 + 违规。
// SKILL.md 是写给交互式 agent 的，不整份塞给模型：每一遍只给它对应的 pass 参考文件。
import type { InputParams } from '../repo/inputs.ts';

export interface PromptParts {
  /** 来自 SKILL.md frontmatter */
  readonly skillDescription: string;
  /** SKILL.md 的「边界（不做的事）」段 */
  readonly boundary: string;
  /** 本遍任务说明（pass 参考文件全文，或单遍配方时的 SKILL.md 正文） */
  readonly task: string;
  /** 数据结构（schema.md 全文） */
  readonly schema: string;
  readonly params?: InputParams | undefined;
  /** 原文 / 梗概 */
  readonly source?: string | undefined;
  /** 上游产物：阶段名 → JSON */
  readonly upstream?: Readonly<Record<string, unknown>> | undefined;
  /** 本遍额外的材料（如同批其他角色、每场的开场走位句） */
  readonly sections?: readonly { readonly title: string; readonly body: string }[] | undefined;
  /** 打回时作者的意见，原文照抄 */
  readonly note?: string | undefined;
  /** 改这一版：这一遍对应的当前版本（打回或上游变了重跑时给），不是从空白重写 */
  readonly base?: unknown;
  /** seed 骨架或当前要修复的整份 JSON */
  readonly draft?: unknown;
  readonly draftLabel?: string | undefined;
  /** 只写这几集 */
  readonly range?: string | undefined;
  /** 上一次的违规，原文照抄 */
  readonly violations?: readonly string[] | undefined;
  /** 额外的输出要求（比如只输出某几个字段） */
  readonly outputSpec: string;
}

export const PLATFORM_RULES = [
  '你是一个 skill 的执行者，由程序调用，不和人对话。',
  '只输出一个 ```json 代码块，代码块之外不要写任何文字。',
  '不要输出任何 id 字段（集、场次、节拍、段、切的 id 由程序分配），已有的 id 原样保留。',
  '只依据给到的材料，不要凭书名或常识脑补内容。',
].join('\n');

const section = (title: string, body: string): string => `【${title}】\n${body.trim()}`;
const json = (x: unknown): string => JSON.stringify(x, null, 2);

export function buildPrompt(p: PromptParts): { system: string; user: string } {
  const system = [PLATFORM_RULES, p.skillDescription && section('skill 简介', p.skillDescription), p.boundary && section('边界', p.boundary)]
    .filter(Boolean)
    .join('\n\n');
  const blocks = [
    section('本遍任务', p.task),
    p.schema && section('数据结构', p.schema),
    p.params && section('项目参数', `总集数：${p.params.episodes}\n单集目标时长：${p.params.seconds} 秒\n题材：${p.params.genre}`),
    p.source && section('原文', p.source),
    ...Object.entries(p.upstream ?? {}).map(([stage, doc]) => section(`上游 ${stage}.json`, json(doc))),
    ...(p.sections ?? []).map((s) => section(s.title, s.body)),
    p.note && section('作者意见（这次重写要落实的修改）', p.note),
    p.base !== undefined && section('底稿（当前版本：在它上面改，意见没说到的地方保持不变）', json(p.base)),
    p.draft !== undefined && section(p.draftLabel ?? '骨架', json(p.draft)),
    p.range && section('只写这几集', p.range),
    p.violations?.length && section('上一次的违规（逐条修正，其余内容不要动）', p.violations.map((v) => `- ${v}`).join('\n')),
    section('输出', p.outputSpec),
  ];
  return { system, user: blocks.filter((b): b is string => typeof b === 'string' && b.length > 0).join('\n\n') };
}

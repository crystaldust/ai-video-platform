// 角色卡 → character-refs 的分层字段（intake）→ 各视图的出图提示词，存进角色卡的 characterRefs。
// 提示词由 character-refs 的脚本拼（取景在前、派生视图只带一句一致性清单、写实画风层与反向词），平台不自己拼：
// 模型只填字段；intake-check 校验，不过就带违规重问；过了用 new 建资产，再用 prompt 逐个视图取。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VIEW_ORDER } from '../generate/prompts.ts';
import { describeFailure } from '../skills/script-runner.ts';
import { isDoc, omit, parseViolations, type AskParts, type Companion, type Doc, type RecipeContext } from './recipe-kit.ts';

export const REFS_SKILL = 'character-refs';
/** 画风统一用写实照片（character-refs 的 realistic-photo 预设）；按项目选画风不在本阶段 */
export const REFS_LOOK = '写实';
export const MAX_INTAKE_TRIES = 3;

/** 一次运行取一次：character-refs 本身、拆字段的任务说明、intake 模板。 */
export interface RefsKit {
  readonly refs: Companion;
  readonly task: string;
  readonly template: string;
}

const PASS_NOTE = [
  '这是角色阶段的一遍：把「角色卡」一节里的这个角色拆成 character-refs 的 intake（结构见「数据结构」一节，规则见上文）。',
  '外形以 persona.appearance 为准；image.prompt 是给整版设定图写的，带景别、背景、光、镜头，只当外形参考——景别、背景、光、镜头、画风都不要写进字段，那些由脚本按视图加。',
  '不问用户：年龄、性别、年代从角色卡和故事背景推，source 写 inferred。',
  '手里不拿东西（道具归美术），配饰可以挂在身上。',
].join('\n');

const OUTPUT_SPEC =
  '只输出这个角色的 intake（一个 JSON 对象）：name 照抄角色卡；lang 写 zh；_说明 不要输出；' +
  'outfit.details 只用 hair / neck / sleeve / feet 四个默认槽位；en 只写英文，不写人名和画风词。';

export async function refsKit(ctx: RecipeContext): Promise<RefsKit> {
  const refs = ctx.companion(REFS_SKILL);
  if (!refs) throw new Error(`没有注册 ${REFS_SKILL}：角色图提示词要由它生成（pack register 重新注册 novel 包）`);
  const template = await refs.run(['intake-template']);
  if (template.code !== 0) throw new Error(describeFailure(`${REFS_SKILL} intake-template`, template));
  return { refs, task: `${refs.readFile('references/intake.md')}\n\n${PASS_NOTE}`, template: template.stdout };
}

/** 拼进运行目录文件名的角色键：大纲没给 id 时退回角色名，只留字母、数字、_ 和 -，免得带出路径。 */
const fileKey = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_');

const cardBody = (card: Doc): string => JSON.stringify({ name: card['name'], persona: card['persona'], image: card['image'] }, null, 2);

/** 问模型要 intake，intake-check 不过就带违规重问；返回过了校验的 intake 和它在运行目录里的路径。 */
async function checkedIntake(ctx: RecipeContext, kit: RefsKit, id: string, card: Doc, base: unknown): Promise<{ intake: Doc; path: string }> {
  const parts: AskParts = { task: kit.task, schema: kit.template, sections: [{ title: '角色卡', body: cardBody(card) }], base, outputSpec: OUTPUT_SPEC };
  let violations: string[] = [];
  let last: Doc | undefined;
  for (let i = 0; i < MAX_INTAKE_TRIES; i++) {
    const asked = last
      ? await ctx.ask(`refs:${id}:repair`, { ...parts, sections: [...parts.sections!, { title: '上一次的违规（逐条修正，其余内容不要动）', body: violations.map((v) => `- ${v}`).join('\n') }], draft: last, draftLabel: '上一次的 intake' })
      : await ctx.ask(`refs:${id}`, parts);
    // 名字以角色卡为准（只进文件名，不进提示词）
    const intake: Doc = { ...omit(asked, ['_说明']), name: card['name'] };
    const path = ctx.writeWork(`intake-${fileKey(id)}.json`, intake);
    const r = await kit.refs.run(['intake-check', path]);
    // 不过校验时 stderr 首行是「✗ N 处问题」；没有这一行就是脚本自己出错了，不拿去问模型
    if (r.code !== 0 && !r.stderr.includes('✗')) throw new Error(describeFailure(`${REFS_SKILL} intake-check`, r));
    violations = parseViolations(r.code, r.stdout, r.stderr);
    if (!violations.length) return { intake, path };
    last = intake;
  }
  throw new Error(`角色「${String(card['name'])}」的 intake 改了 ${MAX_INTAKE_TRIES} 次还没过 ${REFS_SKILL} 的校验：\n${violations.join('\n')}`);
}

async function run(kit: RefsKit, args: readonly string[]): Promise<string> {
  const r = await kit.refs.run(args);
  if (r.code !== 0) throw new Error(describeFailure(`${REFS_SKILL} ${args[0]}`, r));
  return r.stdout;
}

/** 这个角色的 characterRefs：skill 版本、画风、intake、5 个视图的提示词（与 VIEW_ORDER 一致）。 */
export async function characterRefsFor(ctx: RecipeContext, kit: RefsKit, id: string, card: Doc, base?: unknown): Promise<Doc> {
  const { intake, path } = await checkedIntake(ctx, kit, id, card, base);
  const out = join(dirname(path), `refs-${fileKey(id)}`);
  await run(kit, ['new', path, '--out', out, '--look', REFS_LOOK]);
  // 子目录名是 skill 用 safeName 改写过的角色名，不自己拼
  const [sub] = readdirSync(out);
  if (!sub) throw new Error(`${REFS_SKILL} new 没有在 ${out} 下建出资产`);
  const assetPath = join(out, sub, 'asset.json');
  const asset = JSON.parse(readFileSync(assetPath, 'utf8')) as Doc;
  const outfit = isDoc(asset['outfits']) && isDoc(asset['outfits']['default']) ? asset['outfits']['default'] : {};
  const views: Doc = {};
  for (const view of VIEW_ORDER) {
    const p = JSON.parse(await run(kit, ['prompt', assetPath, view])) as Doc;
    views[view] = { prompt: p['text'], negative: p['negative'], ratio: p['ratio'], refs: p['refs'] };
  }
  return { skill: `${REFS_SKILL}@${kit.refs.version}`, look: isDoc(outfit['look']) ? outfit['look']['id'] : null, intake, views };
}

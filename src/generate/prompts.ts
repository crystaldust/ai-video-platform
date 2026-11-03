// 付费生成的提示词与参考图取舍。
// 角色参考图的提示词不在这里拼：角色阶段由 character-refs 生成（取景、一致性清单、写实画风层），存在角色卡的 characterRefs，
// 计划只读它（见 planner.ts）。这里只留视图顺序：正面全身是锚点、纯文生图，其余视图都只参考锚点。
// 关键帧照 novel-storyboard 的 references/frame.md：开头说明每张参考图是谁，再接切的 frame，然后写实画风句，最后固定的收尾句。

export const VIEW_ORDER = ['front-full', 'face-front', 'side-full', 'back-full', 'face-45'] as const;
export type CharacterView = (typeof VIEW_ORDER)[number];
export const ANCHOR_VIEW: CharacterView = 'front-full';

export type Ratio = '2:3' | '4:5' | '1:1' | '9:16' | '16:9';
const RATIOS: readonly string[] = ['2:3', '4:5', '1:1', '9:16', '16:9'];
export const isRatio = (x: unknown): x is Ratio => typeof x === 'string' && RATIOS.includes(x);

/** 关键帧的写实画风句：与角色图同一套写实照片（character-refs 的 realistic-photo），不写焦距——景别由 frame 定。不写 photorealistic：它会把画面往 CG 渲染带。 */
export const KEYFRAME_STYLE =
  'A real photograph, a still from a live-action period drama, not a render: natural true-to-life colors and white balance, ' +
  'natural skin texture that fits each person\'s age, no beauty filter, real fabric with natural creases, subtle film grain.';

/** 关键帧反向词：character-refs 写实预设的 neg（scripts/looks.mjs 的 REALISTIC，逐字照抄）+ 画面缺陷。 */
export const KEYFRAME_NEGATIVE =
  'CGI, 3D render, digital painting, illustration, anime, airbrushed skin, smooth plastic skin, waxy skin, doll face, ' +
  'beauty filter, overly symmetrical face, oversharpened, HDR, glossy, over-saturated, flat lighting, porcelain skin, big anime eyes, ' +
  'text, watermark, border, deformed hands, extra fingers, extra limbs';

export const FRAME_CLOSING = 'No text, no watermark, no borders — a single clean full-bleed frame.';

/** 关键帧：先说明每张参考图是谁（按挂的顺序），再接切的 frame、写实画风句，最后是 frame.md 规定的收尾句。 */
export function keyframePrompt(frame: string, refNames: readonly string[]): string {
  const intro = refNames.map((n, i) => `参考图 ${i + 1} 是「${n}」的角色设定图（正面全身），画面里的${n}长相、发型、服装都照它。`).join('');
  return `${intro ? `${intro}\n\n` : ''}${frame.trim()}\n\n${KEYFRAME_STYLE} ${FRAME_CLOSING}`;
}

/**
 * 关键帧挂哪些角色锚点：按切里出场顺序，有锚点的才挂，最多 max 张（Qwen-Image 3.0 上限 3）。
 * 没锚点的（missing）、挂不下的（dropped）都返回，写进计划输入，界面上标「计划与实际不一致」。
 */
export function pickRefs(characters: readonly string[], anchors: ReadonlyMap<string, string>, max: number): { used: string[]; missing: string[]; dropped: string[] } {
  const used: string[] = [];
  const missing: string[] = [];
  const dropped: string[] = [];
  for (const id of new Set(characters)) {
    if (!anchors.has(id)) missing.push(id);
    else if (used.length < max) used.push(id);
    else dropped.push(id);
  }
  return { used, missing, dropped };
}

/**
 * 百炼「宽*高」：1k 档约一百万像素、2k 档约两三百万像素（3.0 按输出像素 2250000 分档计价），
 * 都是 16 的倍数、总像素在 512² 到 2048² 之间。
 */
const SIZES: Readonly<Record<Ratio, Readonly<Record<'1k' | '2k', string>>>> = {
  '2:3': { '1k': '832*1248', '2k': '1344*2016' },
  '4:5': { '1k': '896*1120', '2k': '1440*1792' },
  '1:1': { '1k': '1024*1024', '2k': '1536*1536' },
  '9:16': { '1k': '720*1280', '2k': '1152*2048' },
  '16:9': { '1k': '1280*720', '2k': '2048*1152' },
};

export function sizeFor(ratio: Ratio, tier: '1k' | '2k'): string {
  const size = SIZES[ratio]?.[tier];
  if (!size) throw new Error(`不支持的画幅：${ratio}`);
  return size;
}

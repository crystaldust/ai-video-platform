// 付费生成的提示词与参考图取舍。
// 角色参考图照 character-refs（scripts/core.mjs 的 VIEWS）：正面全身是锚点、纯文生图，其余视图都只参考锚点——
// 一致性来自「同一张锚点」。这里是平台内的一份常量（方案 A），skill 改了视图要手动同步（backlog #29）。
// 关键帧照 novel-storyboard 的 references/frame.md：开头说明每张参考图是谁，再接切的 frame，最后固定的收尾句。

export const VIEW_ORDER = ['front-full', 'face-front', 'side-full', 'back-full', 'face-45'] as const;
export type CharacterView = (typeof VIEW_ORDER)[number];
export const ANCHOR_VIEW: CharacterView = 'front-full';

export type Ratio = '2:3' | '4:5' | '1:1' | '9:16' | '16:9';

interface ViewSpec {
  readonly ratio: Ratio;
  readonly label: string;
  /** 挂锚点当参考（锚点自己不挂） */
  readonly usesAnchor: boolean;
  readonly framing: string;
  readonly negative: string;
}

const SAME = 'Keep the same person as the reference image: same face, hairstyle, clothing, colours and proportions.';
const BASE_NEG = 'text, watermark, border, multiple people, extra limbs, deformed hands, props, scenery, colored background, oversaturated colors';
const FACE_NEG = `${BASE_NEG}, waist, torso, arms, hands, full body, legs, feet, wide shot, medium shot`;

export const CHARACTER_VIEWS: Readonly<Record<CharacterView, ViewSpec>> = {
  'front-full': {
    ratio: '2:3',
    label: '正面全身（锚点）',
    usesAnchor: false,
    framing: 'Full-body front view: the person stands straight and faces the camera squarely, shoulders, hips and feet square to the camera, arms relaxed at the sides, the whole figure from head to feet visible and centered, with margin above the head and below the feet. Plain light grey studio background, soft even lighting.',
    negative: `${BASE_NEG}, cropped feet, cropped head, three-quarter view, turned body, head turned to the side, dynamic pose`,
  },
  'face-front': {
    ratio: '4:5',
    label: '正脸大头照',
    usesAnchor: true,
    framing: `Zoom in to an extreme close-up head-and-shoulders portrait, passport-photo framing, facing the camera squarely; the nose is on the vertical centre line and both ears are equally visible. ${SAME}`,
    negative: `${FACE_NEG}, three-quarter view, head turned to the side, profile, tilted head`,
  },
  'side-full': {
    ratio: '2:3',
    label: '侧面 90°（面朝右）',
    usesAnchor: true,
    framing: `Full-body side profile: the whole body and the head face the right edge of the image, looking straight ahead to the right, not at the camera. Head to feet in frame. ${SAME}`,
    negative: `${BASE_NEG}, frontal view, looking at camera, cropped feet`,
  },
  'back-full': {
    ratio: '2:3',
    label: '背面',
    usesAnchor: true,
    framing: `Full-body back view: the person faces away from the camera, the back of the head and the whole back visible, head to feet in frame. ${SAME}`,
    negative: `${BASE_NEG}, face, frontal view, cropped feet`,
  },
  'face-45': {
    ratio: '4:5',
    label: '45° 大头照（面朝左）',
    usesAnchor: true,
    framing: `Zoom in to an extreme close-up head-and-shoulders portrait, passport-photo framing, with the head and shoulders turned about 45 degrees toward the left side of the image: a three-quarter view. ${SAME}`,
    negative: `${FACE_NEG}, frontal face, looking at camera, symmetrical face`,
  },
};

/** 角色某个视图的提示词：角色卡的外形描述（cast.json 的 image.prompt，不含版面指令）+ 视图取景。 */
export function characterViewPrompt(appearance: string, view: CharacterView): { prompt: string; negativePrompt: string; ratio: Ratio } {
  if (!appearance.trim()) throw new Error('角色卡的外形描述是空的（cast.json 的 image.prompt）');
  const spec = CHARACTER_VIEWS[view];
  return { prompt: `${appearance.trim()}\n\n${spec.framing}`, negativePrompt: spec.negative, ratio: spec.ratio };
}

export const FRAME_CLOSING = 'No text, no watermark, no borders — a single clean full-bleed frame.';

/** 关键帧：先说明每张参考图是谁（按挂的顺序），再接切的 frame，最后是 frame.md 规定的收尾句。 */
export function keyframePrompt(frame: string, refNames: readonly string[]): string {
  const intro = refNames.map((n, i) => `参考图 ${i + 1} 是「${n}」的角色设定图（正面全身），画面里的${n}长相、发型、服装都照它。`).join('');
  return `${intro ? `${intro}\n\n` : ''}${frame.trim()}\n\n${FRAME_CLOSING}`;
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

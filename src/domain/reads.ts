// 下游实际读上游的哪些字段：需复核按这些字段的内容判断，不按版本号（backlog #34）。
// 分镜写作和修复喂给模型的切片也从这里取——改这里的切片，就是改需复核的规则；
// 下游开始读新字段时，必须加到这里，否则那个字段变了不会标需复核。
import { canonicalJson } from './hash.ts';
import type { Facet } from './types.ts';

type Doc = Record<string, unknown>;

export const isDoc = (x: unknown): x is Doc => typeof x === 'object' && x !== null && !Array.isArray(x);
const only = (doc: Doc, keys: readonly string[]): Doc => Object.fromEntries(keys.flatMap((k) => (doc[k] === undefined ? [] : [[k, doc[k]]])));
const omit = (doc: Doc, keys: readonly string[]): Doc => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));

/** 人设里进画面的部分（性格、动机、关系等不进画面）。 */
export const PERSONA_KEYS: readonly string[] = ['gender', 'ageRange', 'identity', 'appearance'];
/** 分镜读角色卡：名字和别名（分镜门查提示词人名）、一句话、人设的画面部分。不读 image、voice、characterRefs。 */
export const STORYBOARD_CAST_KEYS: readonly string[] = ['id', 'name', 'aliases', 'oneLiner'];
/** 分镜读道具时不看的出图字段。 */
export const STORYBOARD_PROP_OMIT: readonly string[] = ['image', 'usage', 'relatedScenes', 'carriedBy'];
/** 分镜读场景卡时不看的出图字段。只用于喂模型的切片：分镜对场景卡没有引用，场景卡改了不会标分镜需复核（#34 之前也一样）。 */
export const STORYBOARD_SCENE_OMIT: readonly string[] = ['image', 'usage'];

export const storyboardCastCard = (card: Doc): Doc => ({ ...only(card, STORYBOARD_CAST_KEYS), persona: only(isDoc(card['persona']) ? card['persona'] : {}, PERSONA_KEYS) });
export const storyboardProp = (prop: Doc): Doc => omit(prop, STORYBOARD_PROP_OMIT);
export const storyboardScene = (scene: Doc): Doc => omit(scene, STORYBOARD_SCENE_OMIT);

type View = (payload: Doc) => Doc;

/** 键：下游侧面/身份/上游侧面。没列出的引用看整份 payload。 */
const VIEWS: Readonly<Partial<Record<string, View>>> = {
  'storyboard/cast/cast': storyboardCastCard,
  'storyboard/prop/art': storyboardProp,
};

/** 下游（fromFacet，以 role 身份）读到的上游（toFacet）那一部分；没声明的、或 payload 不是对象，原样返回。 */
export function readView(fromFacet: Facet, role: string, toFacet: Facet, payload: unknown): unknown {
  const view = VIEWS[`${fromFacet}/${role}/${toFacet}`];
  return view && isDoc(payload) ? view(payload) : payload;
}

/** 需复核原因里字段的中文名（backlog #38）。查不到的原样写键名。 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  // 角色卡
  name: '名字', aliases: '别名', oneLiner: '一句话', importance: '重要度', persona: '人设',
  gender: '性别', ageRange: '年龄段', identity: '身份', appearance: '外貌', personality: '性格', temperament: '气质',
  motivation: '动机', arc: '弧光', relationships: '关系', evidence: '原文依据',
  image: '出图提示词', voice: '音色', characterRefs: '出图参考',
  // 美术：道具、场景
  scale: '尺度', summary: '概述', anchors: '外观锚点', states: '状态变体', relatedScenes: '出现场景', carriedBy: '携带者', usage: '用法',
  primary: '主场景', lighting: '光照',
  // 剧本场次
  characters: '出场角色', props: '道具', flow: '节拍',
  // 大纲分集
  synopsis: '梗概', hook: '钩子', suspense: '悬念', sceneIds: '场景', characterIds: '角色', propIds: '道具', crowdPlan: '群演安排',
  role: '定位', tier: '分档', from: '出处',
  // 站位
  cast: '在场人物', places: '站位点', extras: '群演', extrasWhere: '群演位置', why: '理由',
  // 分镜段
  sceneRef: '场次', cuts: '分镜', h3Prompt: '视频提示词', blocking: '调度', soundscape: '声音', music: '音乐',
};

const labelOf = (key: string): string => FIELD_LABELS[key] ?? key;
const differs = (a: unknown, b: unknown): boolean => canonicalJson(a) !== canonicalJson(b);
/** 键的并集：b 的键在前，a 独有的在后。 */
const unionKeys = (a: Doc, b: Doc): string[] => [...Object.keys(b), ...Object.keys(a).filter((k) => !(k in b))];

/**
 * 两份读取视图里不同的字段（中文名，去重）。两边该键都是对象时再往下比一层，记子键；只下一层。
 * 两边不都是对象时返回空，由调用方写「内容有变」。
 */
export function changedFields(a: unknown, b: unknown): string[] {
  if (!isDoc(a) || !isDoc(b)) return [];
  const labels = unionKeys(a, b)
    .filter((k) => differs(a[k], b[k]))
    .flatMap((k) => {
      const x = a[k];
      const y = b[k];
      if (!isDoc(x) || !isDoc(y)) return [labelOf(k)];
      return unionKeys(x, y).filter((s) => differs(x[s], y[s])).map(labelOf);
    });
  return [...new Set(labels)];
}

/** 上游在原因里叫什么：有名字用名字，集写「第 N 集」，其余 null（调用方用编号）。 */
export function entityName(payload: unknown): string | null {
  if (!isDoc(payload)) return null;
  const name = payload['name'];
  if (typeof name === 'string' && name) return name;
  return typeof payload['ep'] === 'number' ? `第 ${payload['ep']} 集` : null;
}

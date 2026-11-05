// 下游实际读上游的哪些字段：需复核按这些字段的内容判断，不按版本号（backlog #34）。
// 分镜写作和修复喂给模型的切片也从这里取——改这里的切片，就是改需复核的规则；
// 下游开始读新字段时，必须加到这里，否则那个字段变了不会标需复核。
import type { Facet } from './types.ts';

type Doc = Record<string, unknown>;

const isDoc = (x: unknown): x is Doc => typeof x === 'object' && x !== null && !Array.isArray(x);
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

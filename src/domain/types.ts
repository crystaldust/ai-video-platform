// 项目数据层的领域词汇：对象类型、阶段、侧面，以及投影的中间形态。
// 用 `as const` 数组 + 派生联合类型代替 enum——Node 类型剥离只支持可擦除语法。

export const ENTITY_KINDS = ['episode', 'character', 'location', 'prop', 'beat', 'script_scene', 'segment', 'cut'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** 产出 JSON 的 skill 阶段，导入顺序即上下游顺序。 */
export const STAGES = ['outline', 'cast', 'art', 'script', 'staging', 'storyboard'] as const;
export type Stage = (typeof STAGES)[number];

/*
 * 侧面：哪一阶段为一个对象写了内容。同一个场景 S01 被大纲、美术、站位分别描述，
 * 各自独立版本化，"改了美术不影响大纲"才能成立。第一版与 stage 一一对应；
 * 单列成类型，是为了以后人工编辑、图片阶段这类非 skill 来源也能写侧面。
 */
export const FACETS = STAGES;
export type Facet = Stage;

export const isEntityKind = (x: unknown): x is EntityKind => (ENTITY_KINDS as readonly unknown[]).includes(x);
export const isStage = (x: unknown): x is Stage => (STAGES as readonly unknown[]).includes(x);
export const isFacet = isStage;

export interface EntityRef {
  readonly kind: EntityKind;
  readonly key: string;
}

export interface FacetRef extends EntityRef {
  readonly facet: Facet;
}

/** 投影产出的一个对象侧面，尚未写库。 */
export interface EntityDraft extends FacetRef {
  readonly title: string;
  readonly payload: unknown;
}

/** 投影产出的一条引用，目标侧面按 toFacets 顺序取第一个已存在的。 */
export interface RefDraft {
  readonly from: FacetRef;
  readonly role: string;
  readonly to: EntityRef;
  readonly toFacets: readonly Facet[];
  readonly optional: boolean;
  /** 给人看的定位文字（如「第 1 集第 2 场」），用于拼 problem。 */
  readonly where: string;
}

/*
 * 覆盖范围：这份产物对哪些 (kind, facet) 负完整责任。范围内、库里还有效、
 * 但这次没出现的对象会被退役。剧本、分镜可能按集分批写，所以只对文档里出现的集负责。
 */
export interface Coverage {
  readonly kind: EntityKind;
  readonly facet: Facet;
  readonly episodes: readonly number[] | 'all';
}

export interface Projection {
  readonly entities: readonly EntityDraft[];
  readonly refs: readonly RefDraft[];
  readonly covers: readonly Coverage[];
  readonly problems: readonly string[];
}

export interface ProjectionContext {
  /** 大纲人物名 → C 编号；cast 卡片没有 id，只能靠它对上。 */
  readonly characterKeyByName: ReadonlyMap<string, string>;
  /** 大纲里不止一个人用的名字：拿它匹配会对错人，宁可拒绝。 */
  readonly ambiguousNames: ReadonlySet<string>;
}

export type ProjectFn = (doc: unknown, ctx: ProjectionContext) => Projection;

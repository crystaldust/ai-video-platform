// 阶段依赖图：数据，不写死在流程里。needs 是硬依赖（没有就不能跑，上游没过就阻断）；
// optional 是有就带上的上游——分层只看 needs，所以角色、美术、剧本同层并发。
import { STAGES, type Stage } from '../domain/types.ts';

export interface StageDeps {
  readonly needs: readonly Stage[];
  readonly optional: readonly Stage[];
}

export const STAGE_DEPS: Readonly<Record<Stage, StageDeps>> = {
  outline: { needs: [], optional: [] },
  cast: { needs: ['outline'], optional: [] },
  art: { needs: ['outline'], optional: ['cast'] },
  script: { needs: ['outline'], optional: ['art'] },
  staging: { needs: ['script', 'art'], optional: ['outline'] },
  storyboard: { needs: ['script', 'staging'], optional: ['outline', 'cast', 'art'] },
};

/**
 * 拓扑分层：每层里的阶段互不依赖，可以并发。只排给定的阶段；不在里面的上游视为已就绪。
 * 结果按 STAGES 的顺序稳定输出。有环就报错（依赖图写错了）。
 */
export function layers(stages: readonly Stage[] = STAGES, deps: Readonly<Record<Stage, StageDeps>> = STAGE_DEPS): Stage[][] {
  const pending = new Set(stages);
  const out: Stage[][] = [];
  while (pending.size) {
    const ready = STAGES.filter((s) => pending.has(s) && deps[s].needs.every((n) => !pending.has(n)));
    if (!ready.length) throw new Error(`阶段依赖有环：${[...pending].join('、')}`);
    for (const s of ready) pending.delete(s);
    out.push(ready);
  }
  return out;
}

/** 直接或间接硬依赖 stage 的所有阶段（不含它自己），按 STAGES 顺序。 */
export function downstreamOf(stage: Stage, deps: Readonly<Record<Stage, StageDeps>> = STAGE_DEPS): Stage[] {
  const found = new Set<Stage>();
  const visit = (s: Stage): void => {
    for (const d of STAGES) {
      if (!found.has(d) && deps[d].needs.includes(s)) {
        found.add(d);
        visit(d);
      }
    }
  };
  visit(stage);
  return STAGES.filter((s) => found.has(s));
}

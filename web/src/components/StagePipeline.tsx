// 阶段流水线：6 个文本阶段卡 + 付费阶段条（加锁，先确认再生成；数字来自估算）。
// 有已确认、有任务的确认单时，付费条换成生成进度（设计稿「全貌视图 · 生成中」），整条点进生成任务页。
import { ChevronRight, CircleAlert, Hourglass, Loader, Lock, Play, RotateCcw } from 'lucide-react';
import { Link } from 'react-router';
import { attemptState, callNo, yuan, yuanRange } from '../format.ts';
import type { GenerationProgress, LogRun, NodeEstimate, ProjectEstimate, StageCard, StageState } from '../types.ts';
import { gatePhase, remedyFor, type Remedy } from '../generation.ts';
import { Badge, Button, type Tone } from './ui.tsx';
import s from './overview.module.css';

const STATE: Record<StageState, { label: string; tone: Tone }> = {
  passed: { label: '通过', tone: 'ok' },
  stale: { label: '需复核', tone: 'warn' },
  failed: { label: '失败', tone: 'err' },
  needs_human: { label: '未通过', tone: 'err' },
  running: { label: '运行中', tone: 'run' },
  waiting: { label: '等待', tone: 'idle' },
};

type CardData = StageCard & { gates: { total: number | null; passed: number | null; failed: readonly string[] } | null };

/** 卡片底部一行：在跑时说进度，没过说原因，通过了说质量门。 */
function footLine(card: CardData, run: LogRun | undefined, deps: string): string {
  if (card.state === 'running' && run) {
    const last = run.attempts.at(-1);
    const n = callNo(run.attempts);
    if (!last) return '开始运行';
    const state = attemptState(last);
    if (state === 'running') return `${last.step} · 第 ${n} 次调用 · 等模型返回`;
    return state === 'err' ? `第 ${n} 次调用 · 上次 ${last.violations.length} 处违规` : `${last.step} 通过 · 第 ${n} 次调用`;
  }
  if (card.state === 'waiting') return deps;
  if (card.state === 'needs_human' || card.state === 'failed') return `尝试 ${card.lastRun?.attempts ?? 0} 次 · ${card.lastRun?.error ?? '没过'}`;
  const g = card.gates;
  const gates = g ? (g.total !== null ? `质量门 ${g.passed}/${g.total}` : g.failed.length ? `${g.failed.length} 处违规` : '质量门通过') : '质量门 —';
  return card.state === 'stale' ? `${gates} · ${card.stale} 处需复核` : gates;
}

/** 能整份查看的文本产物：阶段卡上给「查看」链到大纲与剧本页（相对当前项目） */
const READABLE: Record<string, string> = { outline: 'story?tab=outline', script: 'story?tab=script' };

const WAITING: Record<string, string> = { outline: '等梗概', cast: '等大纲', art: '等大纲', script: '等大纲', staging: '等剧本和美术', storyboard: '等剧本和站位' };

function StageCardView({ card, index, run }: { card: CardData; index: number; run: LogRun | undefined }) {
  const st = STATE[card.state];
  return (
    <div className={`${s.stage} ${s[`stage-${card.state}`] ?? ''}`} data-testid={`stage-${card.stage}`}>
      <div className={s.stageHead}>
        <b>
          {String(index + 1).padStart(2, '0')} {card.title}
        </b>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <span className={s.stageSkill}>
        {card.skill?.split('@')[0] ?? '未挂载'}
        {READABLE[card.stage] && card.artifactV !== null ? (
          <Link to={READABLE[card.stage]!} className={s.stageLink}>
            查看
          </Link>
        ) : null}
      </span>
      <span className={`${s.stageFoot} ${card.state === 'running' ? s.stageFootRun : ''}`}>{footLine(card, run, WAITING[card.stage] ?? '')}</span>
    </div>
  );
}

const PAID: readonly { node: string; title: string; unit: (n: NodeEstimate) => string }[] = [
  { node: 'image:character-refs', title: '07 角色参考图', unit: (n) => `${n.usage.find((u) => u.unit === 'image')?.qty.low ?? 0} 张` },
  { node: 'image:keyframe', title: '08 关键帧', unit: (n) => `${n.usage.find((u) => u.unit === 'image')?.qty.low ?? 0} 张` },
  { node: 'video:segment', title: '09 视频', unit: (n) => `${n.usage.find((u) => u.unit === 'video_second')?.qty.low ?? 0} 秒` },
];

const cny = (r: { low: number; high: number } | null, fx: number) => (r ? { low: r.low * fx, high: r.high * fx } : null);

/** 确认单没出图（计划不出来、后台失败）：红色的付费条，说原因；能一键补救的给按钮（设计稿「全貌视图 · 生成没开始」）。 */
function PaidFailed({ g, onRemedy }: { g: GenerationProgress; onRemedy: ((r: Remedy) => void) | undefined }) {
  const remedy = remedyFor(g.error);
  const started = g.total > 0;
  const firstUnfinished = g.byNode.find((n) => n.done < n.total)?.node;
  return (
    <div className={`${s.paid} ${s.paidFail}`} role="alert" aria-label={`确认单 #${g.gateId} 没有出图`}>
      <div className={s.paidHead}>
        <b style={{ color: 'var(--err)' }}>
          <CircleAlert size={12} /> 确认单 #{g.gateId} · {started ? '出错停下' : '没开始'}
        </b>
        <small>
          {g.spent > 0 ? `已花 ${yuan(g.spent)}` : '没花钱'} · 上限 {g.cap === null ? '不设' : yuan(g.cap, 0)}
        </small>
      </div>
      <div className={s.paidRow}>
        {PAID.map((p, i) => {
          const n = g.byNode.find((x) => x.node === p.node);
          // 没建任务：计划从角色参考图开始，错标在它上面；建了任务：只标第一个没出完的节点，原因只说一遍
          const failedHere = !started ? i === 0 : p.node === firstUnfinished;
          return (
            <span key={p.node} style={{ display: 'contents' }}>
              {i > 0 ? <ChevronRight size={12} className={s.arrow} /> : null}
              <span className={`${s.paidNode} ${failedHere ? s.paidNodeFail : ''}`}>
                <span className={s.paidLine}>
                  <b style={failedHere ? undefined : { color: 'var(--text-3)' }}>{p.title}</b>
                  <em style={failedHere ? { color: 'var(--err)' } : undefined}>{n ? `${n.done}/${n.total}${n.failed ? ` · 失败 ${n.failed}` : ''}` : failedHere ? '计划不出来' : '—'}</em>
                </span>
                {failedHere ? <span className={s.paidError}>{g.error}</span> : null}
              </span>
            </span>
          );
        })}
      </div>
      {remedy && onRemedy ? (
        <Button variant="primary" onClick={() => onRemedy(remedy)}>
          <RotateCcw size={13} /> {remedy.label}
        </Button>
      ) : null}
    </div>
  );
}

/** 确认单确认了还没开跑（设计稿「全貌视图 · 待开始」）：说会建几条、上限，给「开始生成」。 */
function PaidPending({ g, onStart, startDisabled }: { g: GenerationProgress; onStart: ((gateId: number) => void) | undefined; startDisabled: boolean | undefined }) {
  return (
    <div className={`${s.paid} ${s.paidLive}`} aria-label={`确认单 #${g.gateId} 待开始`}>
      <div className={s.paidHead}>
        <b style={{ color: 'var(--accent)' }}>
          <Hourglass size={12} /> 确认单 #{g.gateId} · 待开始
        </b>
        <small>
          会建 {g.toCreate} 条 · 上限 {g.cap === null ? '不设' : yuan(g.cap, 0)}
        </small>
      </div>
      <div className={s.paidRow}>
        {PAID.map((p, i) => {
          const picked = g.selected.includes(p.node as GenerationProgress['selected'][number]);
          return (
            <span key={p.node} style={{ display: 'contents' }}>
              {i > 0 ? <ChevronRight size={12} className={s.arrow} /> : null}
              <span className={`${s.paidNode} ${picked ? s.paidNodeLive : ''}`}>
                <span className={s.paidLine}>
                  <b style={picked ? undefined : { color: 'var(--text-3)' }}>{p.title}</b>
                  <em>{picked ? '待开始' : '这次没勾选'}</em>
                </span>
              </span>
            </span>
          );
        })}
      </div>
      {onStart ? (
        <Button variant="primary" disabled={startDisabled} title={startDisabled ? '有任务在跑，等它结束' : undefined} onClick={() => onStart(g.gateId)}>
          <Play size={13} /> 开始生成
        </Button>
      ) : null}
    </div>
  );
}

/** 生成进度条：每个付费节点一格，进度条、完成数、失败数；这次没勾的灰着。 */
function PaidProgress({ g }: { g: GenerationProgress }) {
  return (
    <Link to="tasks" className={`${s.paid} ${s.paidLive}`} aria-label={`确认单 #${g.gateId} 生成进度，点开看任务`}>
      <div className={s.paidHead}>
        <b style={{ color: 'var(--accent)' }}>
          {g.running ? <Loader size={12} /> : <Lock size={12} />} 确认单 #{g.gateId} · {g.running ? '生成中' : g.done === g.total ? '已完成' : '已停'}
        </b>
        <small>
          已花 {yuan(g.spent)} / 上限 {g.cap === null ? '不设' : yuan(g.cap, 0)}
        </small>
      </div>
      <div className={s.paidRow}>
        {PAID.map((p, i) => {
          const n = g.byNode.find((x) => x.node === p.node);
          return (
            <span key={p.node} style={{ display: 'contents' }}>
              {i > 0 ? <ChevronRight size={12} className={s.arrow} /> : null}
              <span className={`${s.paidNode} ${n ? s.paidNodeLive : ''}`}>
                <span className={s.paidLine}>
                  <b style={n ? undefined : { color: 'var(--text-3)' }}>{p.title}</b>
                  <em>{n ? `${n.done}/${n.total}${n.failed ? ` · 失败 ${n.failed}` : ''}` : '这次没勾选'}</em>
                </span>
                {n ? (
                  <span className={s.paidTrack} aria-hidden>
                    <i style={{ width: `${n.total ? (n.done / n.total) * 100 : 0}%` }} />
                  </span>
                ) : null}
              </span>
            </span>
          );
        })}
      </div>
    </Link>
  );
}

/** 还没有确认单在跑：加锁的付费条，数字来自估算。 */
function PaidEstimate({ estimate, estimateError }: { estimate: ProjectEstimate | null; estimateError: string | null }) {
  return (
    <div className={s.paid}>
      <div className={s.paidHead}>
        <b>
          <Lock size={12} /> 付费阶段 · 先确认再生成
        </b>
        <small>{estimate ? `${estimate.preset} 预设 · 价格仅供参考` : (estimateError ?? '还不能估算')}</small>
      </div>
      <div className={s.paidRow}>
        {PAID.map((p, i) => {
          const n = estimate?.nodes.find((x) => x.node === p.node);
          return (
            <span key={p.node} style={{ display: 'contents' }}>
              {i > 0 ? <ChevronRight size={12} className={s.arrow} /> : null}
              <span className={s.paidNode}>
                <b>{p.title}</b>
                <span className={s.paidModel}>{n?.model.split(':')[1] ?? ''}</span>
                <em>{n && estimate ? `${yuanRange(cny(n.cost, estimate.fx.usdToCny), 0)} · ${p.unit(n)}` : '—'}</em>
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function StagePipeline({ stages, log, estimate, estimateError, generation, onRemedy, onStart, startDisabled }: { stages: readonly CardData[]; log: readonly LogRun[]; estimate: ProjectEstimate | null; estimateError: string | null; generation?: GenerationProgress | null; onRemedy?: (r: Remedy) => void; onStart?: (gateId: number) => void; startDisabled?: boolean }) {
  const phase = generation ? gatePhase(generation) : null;
  return (
    <section className={s.pipeline} aria-label="阶段">
      <div className={s.stages}>
        {stages.map((card, i) => (
          <span key={card.stage} style={{ display: 'contents' }}>
            {i > 0 ? <ChevronRight size={12} className={s.arrow} /> : null}
            <StageCardView card={card} index={i} run={log.findLast((r) => r.stage === card.stage)} />
          </span>
        ))}
      </div>
      {generation && phase === 'failed' ? (
        <PaidFailed g={generation} onRemedy={onRemedy} />
      ) : generation && phase === 'pending' ? (
        <PaidPending g={generation} onStart={onStart} startDisabled={startDisabled} />
      ) : generation ? (
        <PaidProgress g={generation} />
      ) : (
        <PaidEstimate estimate={estimate} estimateError={estimateError} />
      )}
    </section>
  );
}

// 阶段流水线：6 个文本阶段卡 + 付费阶段条（加锁，先确认再生成；数字来自估算）。
import { ChevronRight, Lock } from 'lucide-react';
import { Link } from 'react-router';
import { attemptState, callNo, yuanRange } from '../format.ts';
import type { LogRun, NodeEstimate, ProjectEstimate, StageCard, StageState } from '../types.ts';
import { Badge, type Tone } from './ui.tsx';
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

export function StagePipeline({ stages, log, estimate, estimateError }: { stages: readonly CardData[]; log: readonly LogRun[]; estimate: ProjectEstimate | null; estimateError: string | null }) {
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
    </section>
  );
}

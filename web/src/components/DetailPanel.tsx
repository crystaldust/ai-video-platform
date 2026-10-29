// 全貌右侧面板：选中的待处理项（需复核 / 未通过）或某一集——为什么、影响范围、三个操作、附意见打回、下一项。
import { ArrowRight, Clapperboard, MapPin, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError, projectPath } from '../api.ts';
import { epLabel } from '../format.ts';
import type { EpisodeRow, PendingItem, Stage } from '../types.ts';
import { Button } from './ui.tsx';
import s from './overview.module.css';

const STAGE_TITLE: Record<string, string> = { outline: '大纲', cast: '角色', art: '美术', script: '剧本', staging: '站位', storyboard: '分镜' };
const PER_EPISODE: Stage[] = ['script', 'staging', 'storyboard'];

export interface PanelProps {
  readonly projectId: string;
  readonly item: PendingItem | null;
  readonly episode: EpisodeRow | null;
  readonly next: PendingItem | null;
  readonly busy: boolean;
  onNext(item: PendingItem): void;
  onClose(): void;
  /** 操作完成后：刷新全貌并提示 */
  onDone(message: string): void;
  onError(e: ApiError): void;
}

function RejectForm({ projectId, episode, defaultStage, busy, onDone, onError }: { projectId: string; episode: EpisodeRow | null; defaultStage: Stage } & Pick<PanelProps, 'busy' | 'onDone' | 'onError'>) {
  const stages: Stage[] = episode ? PER_EPISODE : ['outline', 'cast', 'art', 'script', 'staging', 'storyboard'];
  const [stage, setStage] = useState<Stage>(stages.includes(defaultStage) ? defaultStage : stages[0]!);
  const [note, setNote] = useState('');
  const submit = async () => {
    try {
      await api.post(projectPath(projectId, '/reject'), { stage, note, ...(episode ? { episode: episode.id } : {}) });
      setNote('');
      onDone(`已打回${episode ? `第 ${epLabel(episode.ep)} 集的` : ''}${STAGE_TITLE[stage]}，正在重跑`);
    } catch (e) {
      onError(e as ApiError);
    }
  };
  const downstream = stage === 'script' ? '站位、分镜' : stage === 'staging' ? '分镜' : stage === 'storyboard' ? '' : '下游';
  return (
    <>
      <div className={s.rejectHead}>
        <span className={s.sectionTitle}>附意见打回</span>
        <span className={s.filters}>
          {stages.map((st) => (
            <button key={st} type="button" className={s.chip} aria-pressed={st === stage} onClick={() => setStage(st)}>
              {STAGE_TITLE[st]}
            </button>
          ))}
        </span>
      </div>
      <textarea className={s.note} aria-label="打回意见" placeholder="例如：汽笛要压在陆行远掏砚之前，给胡二爷一个特写" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className={s.rejectFoot}>
        <span>
          {episode ? `只重跑第 ${epLabel(episode.ep)} 集的${STAGE_TITLE[stage]}` : `重跑整个${STAGE_TITLE[stage]}`}
          {downstream ? `，${downstream}自动标为需复核` : ''}
        </span>
        <Button variant="dark" disabled={!note.trim() || busy} onClick={() => void submit()}>
          打回重跑
        </Button>
      </div>
    </>
  );
}

function StaleBody({ projectId, item, episode, busy, onDone, onError }: { item: PendingItem; episode: EpisodeRow | null } & Pick<PanelProps, 'projectId' | 'busy' | 'onDone' | 'onError'>) {
  const navigate = useNavigate();
  const keep = async () => {
    try {
      await api.post(projectPath(projectId, '/review'), { stage: item.stage, ...(item.episode ? { episode: item.episode } : {}), note: '在全貌上确认保持现状' });
      onDone('已标记为复核过，保持现状');
    } catch (e) {
      onError(e as ApiError);
    }
  };
  const rerun = async () => {
    try {
      await api.post(projectPath(projectId, '/go'), { mode: 'only-stale' });
      onDone('开始重跑需复核的部分');
    } catch (e) {
      onError(e as ApiError);
    }
  };
  const targets = [...new Set(item.reasons.map((r) => `${r.to.key} · ${STAGE_TITLE[r.to.facet]} v${r.pinnedV} → v${r.currentV}`))];
  return (
    <>
      <div className={`${s.why} ${s['why-warn']}`}>
        <span className={s.whyTitle} style={{ color: 'var(--warn)' }}>
          为什么要复核
        </span>
        <span>{item.detail}。</span>
        {targets.slice(0, 3).map((t) => (
          <small key={t}>{t}</small>
        ))}
        {targets.length > 3 ? <small>…另 {targets.length - 3} 处</small> : null}
      </div>
      <div className={s.impact}>
        <span className={s.sectionTitle}>影响范围</span>
        <div>
          <MapPin size={15} /> 需复核的阶段
          <b>{STAGE_TITLE[item.stage]}</b>
        </div>
        <div>
          <Clapperboard size={15} /> 引用旧版本的对象
          <b>{new Set(item.reasons.map((r) => `${r.from.kind}/${r.from.key}`)).size} 个</b>
        </div>
        <div>
          <ShieldCheck size={15} /> 已生成素材
          <b>无，不会重复付费</b>
        </div>
      </div>
      <div className={s.actions}>
        <Button variant="primary" block disabled={busy} onClick={() => void rerun()}>
          <RefreshCw size={14} /> 只重跑需复核的部分
        </Button>
        <div className={s.actionsRow}>
          {episode ? (
            <Button block onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/ep/${episode.id}`)}>
              查看这一集
            </Button>
          ) : (
            <span />
          )}
          <Button block disabled={busy} onClick={() => void keep()}>
            保持现状，标记已复核
          </Button>
        </div>
      </div>
    </>
  );
}

function FailedBody({ projectId, item, busy, onDone, onError }: { item: PendingItem } & Pick<PanelProps, 'projectId' | 'busy' | 'onDone' | 'onError'>) {
  const rerun = async () => {
    try {
      await api.post(projectPath(projectId, '/go'), { only: item.stage });
      onDone(`开始重跑${STAGE_TITLE[item.stage]}`);
    } catch (e) {
      onError(e as ApiError);
    }
  };
  return (
    <>
      <div className={`${s.why} ${s['why-err']}`}>
        <span className={s.whyTitle} style={{ color: 'var(--err)' }}>
          {item.kind === 'needs_human' ? '重试用尽仍有违规' : '运行失败'}
        </span>
        <span>{item.detail || '没有记下原因'}</span>
        {item.runId ? <small>run {item.runId}</small> : null}
      </div>
      <p className={s.muted}>
        人工接管：最后一版在项目目录 runs/{item.runId}/out/ 下，改好后用命令行 <span className="mono">import &lt;项目&gt; {item.stage} &lt;文件&gt; --run {item.runId}</span> 结案。也可以直接重跑或附意见打回。
      </p>
      <Button variant="primary" block disabled={busy} onClick={() => void rerun()}>
        <RefreshCw size={14} /> 重跑{STAGE_TITLE[item.stage]}
      </Button>
    </>
  );
}

export function DetailPanel(p: PanelProps) {
  const { item, episode, next } = p;
  const kicker = item ? `${item.ep ? `第 ${epLabel(item.ep)} 集 · ` : ''}${item.kind === 'stale' ? '需复核' : item.kind === 'needs_human' ? '未通过' : '失败'}` : episode ? `第 ${epLabel(episode.ep)} 集` : '待你处理';
  const title = item ? (episode?.hook ?? item.title) : (episode?.hook ?? '没有需要你处理的事');
  const tone = item?.kind === 'stale' ? 'var(--warn)' : item ? 'var(--err)' : 'var(--accent)';
  return (
    <aside className={s.panel} aria-label="详情">
      <div className={s.panelHead}>
        <div>
          <div className={s.kicker} style={{ color: tone }}>
            {kicker}
          </div>
          <h2 className={s.panelTitle}>{title}</h2>
        </div>
        {item || episode ? (
          <button type="button" className={s.iconBtn} aria-label="关闭" onClick={p.onClose}>
            <X size={16} />
          </button>
        ) : null}
      </div>
      {item?.kind === 'stale' ? <StaleBody {...p} item={item} episode={episode} /> : null}
      {item && item.kind !== 'stale' ? <FailedBody {...p} item={item} /> : null}
      {!item && episode ? (
        <p className={s.muted}>
          这一集没有待处理的地方。{' '}
          <Link to={`/p/${encodeURIComponent(p.projectId)}/ep/${episode.id}`} style={{ color: 'var(--accent)' }}>
            查看分镜 →
          </Link>
        </p>
      ) : null}
      {!item && !episode ? <p className={s.muted}>各阶段都通过了，也没有需要复核的地方。点左边任意一集查看，或附意见打回整个阶段。</p> : null}
      <div className={s.divider} />
      <RejectForm key={`${episode?.id ?? '-'}|${item?.stage ?? '-'}`} projectId={p.projectId} episode={episode} defaultStage={item?.stage ?? 'storyboard'} busy={p.busy} onDone={p.onDone} onError={p.onError} />
      {next ? (
        <button type="button" className={`${s.next} ${next.kind === 'stale' ? s.nextWarn : ''}`} onClick={() => p.onNext(next)}>
          <b>
            下一项 · {next.title}
            <ArrowRight size={14} />
          </b>
          {next.detail}
        </button>
      ) : null}
    </aside>
  );
}

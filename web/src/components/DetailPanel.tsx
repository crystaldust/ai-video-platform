// 全貌右侧面板：选中的待处理项（需复核 / 未通过）或某一集——为什么、影响范围、三个操作、附意见打回、下一项。
import { ArrowRight, Clapperboard, MapPin, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError, projectPath } from '../api.ts';
import { epLabel } from '../format.ts';
import { rejectChoices, rejectScope, STAGE_TITLE } from '../reject.ts';
import { rerunRequest } from '../rerun.ts';
import { dismissPath, repeatRejectBody, revisionLabel } from '../revision.ts';
import type { EpisodeRow, PendingItem, Stage, StageCard } from '../types.ts';
import { Button } from './ui.tsx';
import s from './overview.module.css';

export interface PanelProps {
  readonly projectId: string;
  readonly item: PendingItem | null;
  readonly episode: EpisodeRow | null;
  readonly next: PendingItem | null;
  readonly busy: boolean;
  /** 阶段卡：哪些阶段有产物（没有的打回不了） */
  readonly stages: readonly StageCard[];
  readonly totalEpisodes: number;
  onNext(item: PendingItem): void;
  onClose(): void;
  /** 操作完成后：刷新全貌并提示 */
  onDone(message: string): void;
  onError(e: ApiError): void;
}

type RejectProps = { projectId: string; episode: EpisodeRow | null; preferred: readonly Stage[] } & Pick<PanelProps, 'busy' | 'stages' | 'totalEpisodes' | 'onDone' | 'onError'>;

function RejectForm({ projectId, episode, preferred, busy, stages: cards, totalEpisodes, onDone, onError }: RejectProps) {
  const choices = rejectChoices({ cards, perEpisode: Boolean(episode), preferred });
  const [picked, setStage] = useState<Stage | null>(choices.initial);
  const [note, setNote] = useState('');
  // 选中的阶段后来没了产物（极少见）就退回默认
  const stage = picked && choices.stages.some((x) => x.stage === picked && x.enabled) ? picked : choices.initial;
  const scope = stage ? rejectScope({ stage, episode: episode?.ep ?? null, totalEpisodes }) : null;
  const submit = async () => {
    if (!stage) return;
    if (scope?.confirm && !window.confirm(scope.confirm)) return;
    try {
      await api.post(projectPath(projectId, '/reject'), { stage, note, ...(episode ? { episode: episode.id } : {}) });
      setNote('');
      onDone(`已打回${episode ? `第 ${epLabel(episode.ep)} 集的` : ''}${STAGE_TITLE[stage]}，正在重跑`);
    } catch (e) {
      onError(e as ApiError);
    }
  };
  const downstream = stage === 'script' ? '站位、分镜' : stage === 'staging' ? '分镜' : stage === 'storyboard' || !stage ? '' : '下游';
  return (
    <>
      <div className={s.rejectHead}>
        <span className={s.sectionTitle}>附意见打回</span>
        <span className={s.filters}>
          {choices.stages.map(({ stage: st, enabled }) => (
            <button key={st} type="button" className={s.chip} aria-pressed={st === stage} disabled={!enabled} title={enabled ? undefined : `${STAGE_TITLE[st]}还没有产物，没什么可打回的`} onClick={() => setStage(st)}>
              {STAGE_TITLE[st]}
            </button>
          ))}
        </span>
      </div>
      <textarea className={s.note} aria-label="打回意见" placeholder="例如：汽笛要压在陆行远掏砚之前，给胡二爷一个特写" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className={s.rejectFoot}>
        <span style={scope?.warn ? { color: 'var(--warn)', fontWeight: 600 } : undefined}>
          {scope ? scope.text : '还没有能打回的产物'}
          {scope && downstream ? `，${downstream}自动标为需复核` : ''}
        </span>
        <Button variant="dark" disabled={!stage || !note.trim() || busy} onClick={() => void submit()}>
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
  const [fresh, setFresh] = useState(false);
  const rerun = async () => {
    const req = rerunRequest(item.stage, fresh);
    if (req.confirm && !window.confirm(req.confirm)) return;
    try {
      await api.post(projectPath(projectId, '/go'), req.body);
      onDone(`开始${fresh ? '整份重写' : '重跑'}${STAGE_TITLE[item.stage]}`);
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
      {item.upstream ? <UpstreamHint item={item} upstream={item.upstream} /> : null}
      <Button variant={item.upstream ? undefined : 'primary'} block disabled={busy} onClick={() => void rerun()}>
        <RefreshCw size={14} /> 重跑{STAGE_TITLE[item.stage]}
      </Button>
      <label className={s.muted}>
        <input type="checkbox" checked={fresh} disabled={busy} onChange={(e) => setFresh(e.target.checked)} /> 不沿用之前写好的集，整份重写
      </label>
    </>
  );
}

/** 打回过、运行却没跑完：意见没有落实。可以带同样的意见再打回，或放弃这条意见。 */
function RevisionBlock({ projectId, stage, revision, busy, onDone, onError }: { stage: Stage; revision: NonNullable<PendingItem['revision']> } & Pick<PanelProps, 'projectId' | 'busy' | 'onDone' | 'onError'>) {
  const where = revisionLabel(stage, revision);
  const act = async (path: string, body: unknown, message: string) => {
    try {
      await api.post(projectPath(projectId, path), body);
      onDone(message);
    } catch (e) {
      onError(e as ApiError);
    }
  };
  return (
    <div className={`${s.why} ${s['why-warn']}`}>
      <span className={s.whyTitle} style={{ color: 'var(--warn)' }}>
        这次打回的意见还没落实
      </span>
      <span>{revision.note}</span>
      <small>{where}的重跑没有跑完，这条意见没有用上。</small>
      <div className={s.actionsRow}>
        <Button block disabled={busy} onClick={() => void act('/reject', repeatRejectBody(stage, revision), `已带同样的意见再打回${where}，正在重跑`)}>
          带同样意见再打回
        </Button>
        <Button block disabled={busy} onClick={() => void act(dismissPath(revision.id), {}, '已放弃这条打回意见')}>
          放弃这条意见
        </Button>
      </div>
    </div>
  );
}

/** 上游按当前门不过：下游重跑多少遍都过不了，指明先打回哪一阶段、哪一集。 */
function UpstreamHint({ item, upstream }: { item: PendingItem; upstream: NonNullable<PendingItem['upstream']> }) {
  const where = `${STAGE_TITLE[upstream.stage]}${upstream.ep ? `第 ${epLabel(upstream.ep)} 集` : ''}`;
  return (
    <div className={`${s.why} ${s['why-warn']}`}>
      <span className={s.whyTitle} style={{ color: 'var(--warn)' }}>
        先改上游的{where}
      </span>
      <span>
        {where}按当前质量门不过，{STAGE_TITLE[item.stage]}照着它重跑多半还是过不了。在下面附意见打回{where}（已帮你选好），跑完再重跑{STAGE_TITLE[item.stage]}。
      </span>
    </div>
  );
}

/** 已有产物按当前 skill 的门不过：多半是 skill 升级、门变严了，旧产物不会自己重查。 */
function GateBody({ item }: { item: PendingItem }) {
  const where = `${item.ep ? `第 ${epLabel(item.ep)} 集的` : ''}${STAGE_TITLE[item.stage]}`;
  return (
    <>
      <div className={`${s.why} ${s['why-err']}`}>
        <span className={s.whyTitle} style={{ color: 'var(--err)' }}>
          按当前质量门不过
        </span>
        <span>{item.detail}</span>
      </div>
      <p className={s.muted}>这一版是在旧规则下通过的；挂载的 skill 后来门变严了，已有产物不会自己重查。下游照着它跑会一直卡住——在下面附意见打回{where}，把这一处改掉。</p>
    </>
  );
}

const KICKER: Record<PendingItem['kind'], string> = { stale: '需复核', needs_human: '未通过', failed: '失败', gate: '门不过', revision: '打回没落实' };

export function DetailPanel(p: PanelProps) {
  const { item, episode, next } = p;
  const kicker = item ? `${item.ep ? `第 ${epLabel(item.ep)} 集 · ` : ''}${KICKER[item.kind]}` : episode ? `第 ${epLabel(episode.ep)} 集` : '待你处理';
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
      {item?.kind === 'gate' ? <GateBody item={item} /> : null}
      {item && (item.kind === 'needs_human' || item.kind === 'failed') ? <FailedBody key={`${item.stage}|${item.runId ?? '-'}`} {...p} item={item} /> : null}
      {item?.revision ? <RevisionBlock {...p} stage={item.stage} revision={item.revision} /> : null}
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
      <RejectForm
        key={`${episode?.id ?? '-'}|${item?.stage ?? '-'}|${item?.upstream?.stage ?? '-'}`}
        projectId={p.projectId}
        episode={episode}
        preferred={[...(item?.upstream ? [item.upstream.stage] : []), item?.stage ?? 'storyboard']}
        busy={p.busy}
        stages={p.stages}
        totalEpisodes={p.totalEpisodes}
        onDone={p.onDone}
        onError={p.onError}
      />
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

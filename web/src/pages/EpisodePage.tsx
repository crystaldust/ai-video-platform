// 单集详情：左边场次与段，中间选中段的切（关键帧位、画面 / 台词时间轴、视频提示词），右边选中切的详情。
// 剧本、分镜在跑时边写边显示：已写好的集先出来（标草稿），收到进度事件就刷新。
import { ChevronLeft, ChevronRight, Image, MapPin, Package, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { api, ApiError, projectPath, useApi, useReloadOnProgress } from '../api.ts';
import { Badge, Button, cardClass, ErrorView, Loading, PageHead, useToast } from '../components/ui.tsx';
import { epLabel, seconds } from '../format.ts';
import type { CutView, EpisodeDetail, SegmentView } from '../types.ts';
import o from '../components/overview.module.css';
import s from './EpisodePage.module.css';

const SIZE: Record<string, string> = { 'extreme-wide': '大远景', wide: '全景', medium: '中景', close: '特写', 'extreme-close': '大特写' };

/** 「剧集与分镜」入口：直接进第 1 集。 */
export function EpisodesIndex() {
  return <Navigate to="../ep/1" relative="path" replace />;
}

function Timeline({ seg, cut, onPick }: { seg: SegmentView; cut: CutView | null; onPick: (c: CutView) => void }) {
  const total = Math.max(seg.seconds, 1);
  const pct = (sec: number) => `${(sec / total) * 100}%`;
  return (
    <div className={s.timeline}>
      <span>画面</span>
      <div className={s.track}>
        {seg.cuts.map((c, i) => (
          <button key={c.id} type="button" className={`${s.slot} ${c.id === cut?.id ? s.slotOn : ''}`} style={{ width: pct(c.seconds) }} onClick={() => onPick(c)}>
            #{i + 1}
          </button>
        ))}
      </div>
      <span>台词</span>
      <div className={s.track}>
        {seg.cuts.map((c) => {
          const line = c.beats.find((b) => b.kind === 'line');
          return (
            <span key={c.id} className={`${s.slot} ${line ? s.slotLine : s.slotEmpty}`} style={{ width: pct(c.seconds) }} title={line ? `${line.speaker}「${line.text}」` : undefined}>
              {line ? `${line.speaker}「${line.text}」` : ''}
            </span>
          );
        })}
      </div>
      <span />
      <div className={s.ticks}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <span key={t}>{Math.round(total * t)}s</span>
        ))}
      </div>
    </div>
  );
}

function CutDetail({ cut, index, projectId, episodeId, onDone, onError }: { cut: CutView; index: number; projectId: string; episodeId: string; onDone: (m: string) => void; onError: (e: ApiError) => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const copy = async () => {
    await navigator.clipboard.writeText(cut.frame);
    onDone('分镜图提示词已复制');
  };
  const reject = async () => {
    try {
      await api.post(projectPath(projectId, '/reject'), { stage: 'storyboard', episode: episodeId, note: `切 ${cut.id}（#${index + 1}）：${note}` });
      onDone('已打回这一集的分镜，正在重跑');
      setRejecting(false);
      setNote('');
    } catch (e) {
      onError(e as ApiError);
    }
  };
  const refs = [...cut.characters.map((n) => ({ n, k: '角色' })), ...cut.props.map((n) => ({ n, k: '道具' }))];
  return (
    <aside className={`${cardClass} ${s.detail}`} aria-label="切详情">
      <div>
        <h3>
          切 #{index + 1} · {cut.start.toFixed(2)}–{(cut.start + cut.seconds).toFixed(2)} 秒
        </h3>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {cut.id}
        </span>
      </div>
      <dl className={s.kv}>
        <dt>景别</dt>
        <dd>{SIZE[cut.size] ?? cut.size}</dd>
        <dt>运镜</dt>
        <dd>{cut.camera}</dd>
        <dt>镜头</dt>
        <dd>{cut.lens || '—'}</dd>
        <dt>视线</dt>
        <dd>{cut.eyeline || '—'}</dd>
      </dl>
      <h4>画面</h4>
      <p className={s.text}>{cut.frame}</p>
      <h4>认领的剧本节拍</h4>
      {cut.beats.map((b) => (
        <div key={b.id} className={s.beat}>
          <small>
            {b.id} · {b.kind === 'line' ? `台词 · ${b.speaker}` : '动作'}
          </small>
          {b.text}
        </div>
      ))}
      <h4>参考图</h4>
      <div className={s.refs}>
        {refs.map((r) => (
          <div key={`${r.k}${r.n}`} className={s.ref}>
            <div>
              <Image size={14} />
            </div>
            {r.n}
            <small>{r.k} · 待生成</small>
          </div>
        ))}
      </div>
      {rejecting ? (
        <>
          <textarea className={o.note} aria-label="这一切的修改意见" placeholder="例如：改成特写，镜头推到砚台的缺角" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className={s.detailActions}>
            <Button onClick={() => setRejecting(false)}>取消</Button>
            <Button variant="dark" disabled={!note.trim()} onClick={() => void reject()}>
              打回这一集的分镜
            </Button>
          </div>
        </>
      ) : (
        <div className={s.detailActions}>
          <Button onClick={() => void copy()}>复制提示词</Button>
          <Button variant="dark" onClick={() => setRejecting(true)}>
            附意见打回这一切
          </Button>
        </div>
      )}
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={o.metric}>
      <small>{label}</small>
      <b style={{ fontSize: 15, fontFamily: 'var(--font)', fontWeight: 600 }}>{value}</b>
    </div>
  );
}

export function EpisodePage() {
  const { id = '', ep = '' } = useParams();
  const d = useApi<EpisodeDetail>(projectPath(id, `/episodes/${encodeURIComponent(ep)}`));
  const [segId, setSegId] = useState<string | null>(null);
  const [cutId, setCutId] = useState<string | null>(null);
  const [toast, notify] = useToast();
  useReloadOnProgress(id, d.reload);
  if (d.error) return <ErrorView error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading what="读取这一集" />;
  const data = d.data;
  const segments = data.scenes.flatMap((sc) => sc.segments);
  const seg = segments.find((g) => g.id === segId) ?? segments[0] ?? null;
  const scene = data.scenes.find((sc) => sc.segments.includes(seg!));
  const cut = seg?.cuts.find((c) => c.id === cutId) ?? seg?.cuts[0] ?? null;
  const base = `/p/${encodeURIComponent(id)}`;
  const wide = data.project.params?.aspect !== '9:16';
  const rerun = async () => {
    try {
      await api.post(projectPath(id, '/go'), { mode: 'only-stale' });
      notify('开始重跑需复核的部分，进度在全貌页');
    } catch (e) {
      notify((e as ApiError).message, 'err');
    }
  };
  return (
    <>
      <PageHead
        title={
          <>
            <span className={s.crumbs}>
              <Link to={`${base}/episodes`}>剧集与分镜</Link> <ChevronRight size={12} /> 第 {epLabel(data.episode.ep)} 集
            </span>
            {data.episode.hook || `第 ${data.episode.ep} 集`}
          </>
        }
        actions={
          <>
            <span className={s.nav}>
              <Link to={`${base}/ep/${data.nav.prev ?? ''}`} className={data.nav.prev ? '' : s.navOff} aria-label="上一集">
                <ChevronLeft size={13} />
              </Link>
              <span>
                {epLabel(data.nav.index)} / {epLabel(data.nav.total)}
              </span>
              <Link to={`${base}/ep/${data.nav.next ?? ''}`} className={data.nav.next ? '' : s.navOff} aria-label="下一集">
                <ChevronRight size={13} />
              </Link>
            </span>
            <Button disabled title="投产包导出在剪辑与导出阶段（Phase 7）">
              <Package size={14} /> 导出 H3 投产包
            </Button>
            <Button variant="primary" disabled={!data.stale.length} onClick={() => void rerun()}>
              <RefreshCw size={14} /> 只重跑需复核的部分
            </Button>
          </>
        }
      />
      {data.stale.length ? (
        <div className={s.banner}>
          <TriangleAlert size={15} color="var(--warn)" />
          {data.stale.map((x) => `${x.title}需复核：${x.reasons[0]}${x.reasons.length > 1 ? ` 等 ${x.reasons.length} 处` : ''}`).join('；')}。已生成素材：无。
        </div>
      ) : null}
      {data.draft.script || data.draft.storyboard ? (
        <div className={`${s.banner} ${s.bannerDraft}`} role="status">
          <RefreshCw size={15} color="var(--accent)" />
          生成中：这一集的{[data.draft.script && '剧本', data.draft.storyboard && '分镜'].filter(Boolean).join('、')}是刚写好的草稿，还没过质量门，阶段跑完后可能还会修改。
        </div>
      ) : null}
      <div className={s.stats}>
        <Stat label="时长" value={`${seconds(data.stats.seconds)}${data.stats.target ? ` / 目标 ${data.stats.target} 秒` : ''}`} />
        <Stat label="场次" value={String(data.stats.scenes)} />
        <Stat label="段" value={String(data.stats.segments)} />
        <Stat label="切" value={String(data.stats.cuts)} />
        <Stat label="钩子兑现" value={data.stats.hookBeat ? `第 ${data.stats.hookBeat} 拍` : '—'} />
      </div>
      {segments.length === 0 ? (
        <div className={cardClass} style={{ padding: 32, textAlign: 'center', color: 'var(--text-2)' }}>
          这一集还没有分镜。{data.scenes.length ? `剧本有 ${data.scenes.length} 场；分镜写到这一集后这里就会出现段与切（运行中边写边显示）。` : '剧本也还没有写到这一集。'}
        </div>
      ) : (
        <div className={s.body}>
          <nav className={`${cardClass} ${s.tree}`} aria-label="场次与段">
            <span className={s.treeTitle}>场次与段</span>
            {data.scenes.map((sc) => (
              <div key={sc.id}>
                <div className={s.scene}>
                  <b>
                    场 {sc.n} · {sc.location}
                    {sc.changed ? <span className={s.changed}>已改</span> : null}
                  </b>
                  <small>{sc.lighting}</small>
                </div>
                {sc.segments.map((g) => (
                  <button key={g.id} type="button" className={s.seg} aria-current={g.id === seg?.id} onClick={() => (setSegId(g.id), setCutId(null))}>
                    <span style={{ color: sc.changed ? 'var(--warn)' : 'var(--ok)' }}>●</span>
                    {g.label}
                    <small>
                      {Math.round(g.seconds)} 秒 · {g.cuts.length} 切
                    </small>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          {seg ? (
            <section className={`${cardClass} ${s.center}`} aria-label="段">
              <div className={s.segHead}>
                <div>
                  <b>{seg.label}</b>
                  <span>
                    场 {scene?.n} · {scene?.location} · 一次视频生成
                  </span>
                  <small>
                    {seg.id} · {Math.round(seg.seconds)} 秒 · {seg.cuts.length} 切
                  </small>
                </div>
                {scene?.changed ? <Badge tone="warn">基于旧剧本</Badge> : <Badge tone="ok">当前剧本</Badge>}
              </div>
              {seg.blocking ? (
                <div className={s.blocking}>
                  <MapPin size={14} style={{ flex: 'none', marginTop: 3 }} />
                  <span>
                    {seg.opening ? '开场走位（照抄站位）：' : '走位：'}
                    {seg.blocking}
                  </span>
                </div>
              ) : null}
              <div className={s.cuts}>
                {seg.cuts.map((c, i) => (
                  <button key={c.id} type="button" className={s.cut} aria-current={c.id === cut?.id} onClick={() => setCutId(c.id)}>
                    <div className={`${s.frame} ${wide ? s.frameWide : ''}`}>
                      <Image size={18} />
                      关键帧待生成
                    </div>
                    <div className={s.cutMeta}>
                      <b>#{i + 1}</b>
                      <span>{c.start.toFixed(2)}s</span>
                    </div>
                    <div className={s.cutSize}>
                      {SIZE[c.size] ?? c.size} · {c.camera}
                    </div>
                    <div className={s.cutShot}>{c.frame}</div>
                  </button>
                ))}
              </div>
              <Timeline seg={seg} cut={cut} onPick={(c) => setCutId(c.id)} />
              <div className={s.prompt}>
                <header>MiniMax H3 视频提示词</header>
                <pre>{seg.h3Prompt || '（这一段没有写视频提示词）'}</pre>
              </div>
            </section>
          ) : null}
          {cut && seg ? <CutDetail cut={cut} index={seg.cuts.indexOf(cut)} projectId={id} episodeId={data.episode.id} onDone={(m) => notify(m)} onError={(e) => notify(e.message, 'err')} /> : null}
        </div>
      )}
      {toast}
    </>
  );
}

// 生成任务页（设计稿「生成任务 · Web 1440」）：按确认单看每张图、每段视频的状态、花费和产出。
// 顶部确认单切换与停止 / 继续生成；进度条卡片；角色参考图按角色 × 5 视图；关键帧、视频按集的表；右侧详情；全屏预览。
// 进度靠 SSE：生成事件来了就重新拉（合并成每秒最多一次），数据都在库里。
import { ChevronDown, CircleAlert, Film, RotateCcw, Hourglass, Image as ImageIcon, LayoutDashboard, ListChecks, Lock, OctagonAlert, ShieldAlert, Square, Play } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError, projectPath, useApi, useProjectEvents } from '../api.ts';
import { MediaViewer, type PreviewItem } from '../components/MediaViewer.tsx';
import { TaskDetail } from '../components/TaskDetail.tsx';
import { Badge, Button, cardClass, ErrorView, Loading, PageHead, useToast } from '../components/ui.tsx';
import { epLabel, yuan } from '../format.ts';
import { costText, gatePhase, progressOf, remedyFor, selectionText, taskState, viewTitle, type Tone } from '../generation.ts';
import { runRemedy } from '../remedy-action.ts';
import type { GateSummary, TaskCard, TasksView } from '../types.ts';
import s from './TasksPage.module.css';

const RELOAD_MS = 1000;
/** 角色多时先列这么多个，其余折起来 */
const SHOWN_CHARACTERS = 3;

type Ctx = { readonly running: boolean; readonly spent: number; readonly cap: number | null };

const STATE_ICON: Partial<Record<string, typeof Hourglass>> = { 排队: Hourglass, 未提交: Hourglass, 预算停下: Lock, 被拒: ShieldAlert, 失败: OctagonAlert, 结果未知: OctagonAlert };

function Media({ projectId, card, alt }: { projectId: string; card: TaskCard; alt: string }) {
  if (!card.mediaId) return null;
  const src = projectPath(projectId, `/media/${card.mediaId}`);
  return card.mime?.startsWith('video/') ? <video src={src} muted preload="metadata" /> : <img src={src} alt={alt} loading="lazy" />;
}

function Tile({ projectId, card, reuse, alt, selected, ctx, onSelect }: { projectId: string; card: TaskCard | null; reuse: TaskCard | null; alt: string; selected: boolean; ctx: Ctx; onSelect: (id: number) => void }) {
  const shown = card ?? reuse;
  if (!shown) return <div className={`${s.tile} ${s['tone-idle']}`} aria-label={`${alt}：没有任务`}>—</div>;
  const st = card ? taskState(card, ctx) : { tone: 'ok' as Tone, label: '沿用' };
  const Icon = STATE_ICON[st.label];
  const toneClass = shown.mediaId ? '' : (s[`tone-${st.tone}`] ?? '');
  return (
    <button type="button" className={`${s.tile} ${toneClass} ${selected ? s.selected : ''}`} aria-label={`${alt}：${st.label}`} aria-pressed={selected} onClick={() => onSelect(shown.id)}>
      {reuse && !card ? <span className={s.reuse}>沿用 #{reuse.gateId ?? '—'}</span> : null}
      <Media projectId={projectId} card={shown} alt={alt} />
      {shown.mediaId ? null : (
        <>
          {Icon ? <Icon size={14} /> : null}
          {st.label}
        </>
      )}
    </button>
  );
}

function GateBar({ view, gate, reused }: { view: TasksView; gate: GateSummary; reused: { count: number; cny: number } }) {
  const p = progressOf(gate);
  return (
    <section className={`${s.bar} ${cardClass}`} aria-label="确认单进度">
      <div className={s.barMain}>
        <b>
          {p.done} / {p.total}
        </b>
        <span>
          完成 · {p.active} 张生成中 · {p.queued} 张{gate.running ? '排队' : '未提交'}
        </span>
        <span className={s.barSel}>勾选：{selectionText(gate.selection)}</span>
      </div>
      <div className={s.stats}>
        <div className={s.stat}>
          <small>已花 / 上限</small>
          <b>
            {yuan(gate.spent)} <em>/ {gate.cap === null ? '不设' : yuan(gate.cap, 0)}</em>
          </b>
        </div>
        <div className={s.stat}>
          <small>失败</small>
          <b style={{ color: p.failed ? 'var(--err)' : undefined }}>{p.failed}</b>
        </div>
        <div className={s.stat}>
          <small>被拒</small>
          <b style={{ color: p.rejected ? 'var(--warn)' : undefined }}>{p.rejected}</b>
        </div>
        <div className={s.stat}>
          <small>沿用已生成</small>
          <b>
            {reused.count} <em>−{yuan(reused.cny)}</em>
          </b>
        </div>
      </div>
      <div className={s.track} role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-label={`${view.gates.length ? `确认单 #${gate.id}` : ''} 完成 ${p.done}/${p.total}`}>
        <i style={{ width: `${p.ratio * 100}%`, background: 'var(--accent)' }} />
        <i style={{ width: `${p.badRatio * 100}%`, background: 'var(--err)' }} />
      </div>
    </section>
  );
}

function Characters({ projectId, view, ctx, selected, onSelect }: { projectId: string; view: TasksView; ctx: Ctx; selected: number | null; onSelect: (id: number) => void }) {
  const [all, setAll] = useState(false);
  const cards = view.characters.flatMap((c) => c.views.flatMap((v) => (v.task ? [v.task] : [])));
  const done = cards.filter((c) => c.status === 'collected').length;
  const spent = cards.reduce((a, c) => a + (c.costActual ?? 0), 0);
  const shown = all ? view.characters : view.characters.slice(0, SHOWN_CHARACTERS);
  const hidden = view.characters.slice(SHOWN_CHARACTERS);
  return (
    <section className={`${s.section} ${cardClass}`} aria-label="角色参考图">
      <div className={s.sectionHead}>
        <h2>角色参考图</h2>
        <span>{view.characters.length} 个角色 × 5 个视图</span>
        <span className={s.right}>
          {done} / {cards.length} · {yuan(spent)}
        </span>
      </div>
      <div className={s.grid} role="table">
        <div className={s.gridHead} role="row">
          <div role="columnheader">角色</div>
          {view.characters[0]?.views.map((v) => (
            <div key={v.view} role="columnheader">
              {viewTitle(v.view)}
              {v.view === 'front-full' ? ' · 锚点' : ''}
            </div>
          ))}
        </div>
        {shown.map((c) => (
          <div key={c.id} style={{ display: 'contents' }} role="row">
            <div className={s.who} role="cell">
              <b>{c.name}</b>
              <small>{c.id}</small>
            </div>
            {c.views.map((v) => {
              const card = v.task ?? v.reuseOf;
              return (
                <div key={v.view} className={s.cell} role="cell">
                  <Tile projectId={projectId} card={v.task} reuse={v.reuseOf} alt={`${c.name} · ${viewTitle(v.view)}`} selected={card !== null && card.id === selected} ctx={ctx} onSelect={onSelect} />
                  <small>{v.task ? costText(v.task) : v.reuseOf ? '沿用' : '—'}</small>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {hidden.length && !all ? (
        <button type="button" className={s.more} onClick={() => setAll(true)}>
          <ChevronDown size={14} /> 还有 {hidden.length} 个角色（{hidden.map((c) => c.id).join('、')}）
        </button>
      ) : null}
    </section>
  );
}

function TaskTable({ projectId, title, icon, groups, ctx, selected, onSelect }: { projectId: string; title: string; icon: ReactNode; groups: TasksView['keyframes']; ctx: Ctx; selected: number | null; onSelect: (id: number) => void }) {
  const [filter, setFilter] = useState<string>('all');
  const bad = (c: TaskCard) => c.status === 'failed' || c.status === 'rejected' || c.status === 'unknown';
  const badCount = groups.reduce((a, g) => a + g.rows.filter(bad).length, 0);
  const rows = groups.flatMap((g) => (filter === 'all' || filter === 'bad' || filter === g.episode ? g.rows.filter((r) => filter !== 'bad' || bad(r)).map((r) => ({ g, r })) : []));
  const chips = [{ key: 'all', label: '全部' }, ...groups.map((g) => ({ key: g.episode, label: `第 ${g.ep ?? '?'} 集` })), ...(badCount ? [{ key: 'bad', label: `有问题 ${badCount}` }] : [])];
  return (
    <section className={`${s.section} ${cardClass}`} aria-label={title}>
      <div className={s.sectionHead}>
        {icon}
        <h2>{title}</h2>
        <span>{groups.map((g) => `第 ${g.ep ?? '?'} 集`).join('、')}</span>
        <div className={s.chips} role="group" aria-label={`${title}筛选`}>
          {chips.map((c) => (
            <button key={c.key} type="button" aria-pressed={filter === c.key} onClick={() => setFilter(c.key)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className={s.table} role="table">
        {['', '切', '画面', '状态', '预估', '实际'].map((h, i) => (
          <div key={i} className={s.th} role="columnheader">
            {h}
          </div>
        ))}
        {rows.map(({ g, r }) => {
          const st = taskState(r, ctx);
          return (
            <div key={r.id} className={`${s.row} ${r.id === selected ? s.rowSelected : ''}`} role="row" onClick={() => onSelect(r.id)}>
              <div role="cell" className={s.td}>
                <button type="button" className={s.thumb} aria-label={`看 ${r.code ?? r.label}`} onClick={() => onSelect(r.id)}>
                  {r.mediaId ? <Media projectId={projectId} card={r} alt={r.code ?? ''} /> : <ImageIcon size={14} />}
                </button>
              </div>
              <div role="cell" className={`${s.td} ${s.code}`}>
                E{epLabel(g.ep ?? 0)} · {r.code ?? r.label}
              </div>
              <div role="cell" className={`${s.td} ${s.caption}`}>
                <span>{r.caption}</span>
                {r.error ? <em>{r.error}</em> : null}
              </div>
              <div role="cell" className={s.td}>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              <div role="cell" className={`${s.td} ${s.mono}`}>
                {r.costEstimate === null ? '—' : yuan(r.costEstimate)}
              </div>
              <div role="cell" className={`${s.td} ${s.mono}`}>
                {r.costActual === null ? <span className={s.dim}>—</span> : costText(r)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EmptyTasks({ base }: { base: string }) {
  const navigate = useNavigate();
  return (
    <section className={`${s.empty} ${cardClass}`}>
      <div className={s.emptyIcon}>
        <ListChecks size={20} />
      </div>
      <h2>还没有付费生成</h2>
      <p>文本阶段跑完后，在全貌点「确认付费生成」，勾选要出的图和视频、填好上限。确认后这里会列出每个任务。</p>
      <Button variant="primary" onClick={() => void navigate(base)}>
        <LayoutDashboard size={14} /> 去全貌确认
      </Button>
    </section>
  );
}

/**
 * 确认单没出图（设计稿「生成任务 · 没开始」）：说原因、没花钱；能一键补救的给「重跑角色阶段」，旁边是「继续生成」。
 * 一条任务都没建时整块替换任务区；建了任务（比如凭据缺失停下）时作为任务区上面的横幅。
 */
function GateFailed({ gate, busy, onRemedy, onContinue, banner }: { gate: GateSummary; busy: boolean; onRemedy: () => void; onContinue: () => void; banner: boolean }) {
  const remedy = remedyFor(gate.error);
  const actions = (
    <div className={s.failActions}>
      {remedy ? (
        <Button variant="primary" disabled={busy} onClick={onRemedy}>
          <RotateCcw size={14} /> {remedy.label}
        </Button>
      ) : null}
      <Button disabled={busy} onClick={onContinue}>
        <Play size={14} /> 继续生成
      </Button>
    </div>
  );
  if (banner)
    return (
      <div className={s.failBanner} role="alert">
        <CircleAlert size={16} color="var(--err)" />
        <span>
          <b>生成出错停下了：</b>
          {gate.error}
        </span>
        {actions}
      </div>
    );
  return (
    <section className={`${s.empty} ${cardClass}`} role="alert">
      <div className={`${s.emptyIcon} ${s.emptyIconErr}`}>
        <CircleAlert size={20} />
      </div>
      <h2>确认单 #{gate.id} 没有出图</h2>
      <p>
        {gate.error}
        <br />
        没提交任何任务，没花钱。{remedy ? `${remedy.label}后回到这里点「继续生成」。` : '处理好后点「继续生成」。'}
      </p>
      {actions}
      {remedy ? <p className={s.hint}>重跑角色阶段要调用 DeepSeek，会先请你确认；跑完再点「继续生成」</p> : null}
    </section>
  );
}

/** 确认单确认了还没开跑（设计稿「生成任务 · 待开始」）：勾了什么、会建几条、上限，给「开始生成」。 */
function GatePending({ gate, busy, onStart }: { gate: GateSummary; busy: boolean; onStart: () => void }) {
  return (
    <section className={`${s.empty} ${cardClass}`}>
      <div className={`${s.emptyIcon} ${s.emptyIconPending}`}>
        <Hourglass size={20} />
      </div>
      <h2>确认单 #{gate.id} 待开始</h2>
      <p>
        勾选：{selectionText(gate.selection)} · 开跑会建 {gate.toCreate} 条（同样的输入已出过的会跳过）· 上限 {gate.cap === null ? '不设' : yuan(gate.cap, 0)}。
        <br />
        确认时有别的任务在跑，或者当时计划不出来，所以还没开跑。
      </p>
      <Button variant="primary" disabled={busy} onClick={onStart}>
        <Play size={14} /> 开始生成
      </Button>
      <p className={s.hint}>开始后在后台生成，进度在全貌和这里；可以随时停止</p>
    </section>
  );
}

/** 任务 id → 详情标题、预览列表（按页面上的顺序，只要有素材的）。 */
function indexCards(view: TasksView): { titles: Map<number, string>; preview: PreviewItem[] } {
  const titles = new Map<number, string>();
  const preview: PreviewItem[] = [];
  const add = (c: TaskCard, title: string) => {
    if (titles.has(c.id)) return;
    titles.set(c.id, title);
    if (c.mediaId) preview.push({ taskId: c.id, mediaId: c.mediaId, mime: c.mime, title, meta: `任务 #${c.id} · ${c.label ?? ''} · ${costText(c)}` });
  };
  for (const ch of view.characters) for (const v of ch.views) for (const c of [v.task, v.reuseOf]) if (c) add(c, `${ch.name} · ${viewTitle(v.view)}`);
  for (const g of [...view.keyframes, ...view.videos]) for (const r of g.rows) add(r, `第 ${g.ep ?? '?'} 集 · ${r.code ?? r.label}${r.node === 'video:segment' ? ' 视频' : ' 关键帧'}`);
  return { titles, preview };
}

export function TasksPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const gateParam = params.get('gate');
  const v = useApi<TasksView>(projectPath(id, `/tasks${gateParam ? `?gate=${encodeURIComponent(gateParam)}` : ''}`));
  const [toast, notify] = useToast();
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { reload } = v;

  useProjectEvents(id, (e) => {
    if (e.type === 'job-end' && e['ok'] === false) notify(`生成出错：${String(e['message'])}`, 'err');
    if (e.type !== 'gen-task' && e.type !== 'job-end' && e.type !== 'job-start' && e.type !== 'gen-stop') return;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      reload();
      setReloadKey((k) => k + 1);
    }, RELOAD_MS);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const base = `/p/${encodeURIComponent(id)}`;
  const head = (actions?: ReactNode) => <PageHead title="生成任务" sub="按确认单看每张图、每段视频的状态、花费和产出" actions={actions} />;
  if (v.error && !v.data) return <>{head()}<ErrorView error={v.error} onRetry={reload} /></>;
  if (!v.data) return <>{head()}<Loading what="读取生成任务" /></>;
  const view = v.data;
  const back = (
    <Link to={base} className={s.backLink}>
      <LayoutDashboard size={14} /> 回全貌
    </Link>
  );
  if (!view.gate) return <>{head(back)}<EmptyTasks base={base} /></>;
  const gate = view.gate;
  const ctx: Ctx = { running: gate.running, spent: gate.spent, cap: gate.cap };
  const phase = gatePhase(gate);
  const { titles, preview: items } = indexCards(view);
  const reusedCards = view.characters.flatMap((c) => c.views.flatMap((x) => (x.reuseOf && !x.task ? [x.reuseOf] : [])));
  const reused = { count: reusedCards.length, cny: reusedCards.reduce((a, c) => a + (c.costActual ?? c.costEstimate ?? 0), 0) };
  const pendingLeft = (gate.counts.planned ?? 0) > 0;

  const post = async (body: unknown, msg: string) => {
    setBusy(true);
    try {
      await api.post(projectPath(id, '/generate'), body);
      notify(msg);
      reload();
    } catch (e) {
      const err = e as ApiError;
      notify(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };
  const remedy = async () => {
    const r = remedyFor(gate.error);
    if (!r) return;
    setBusy(true);
    try {
      const msg = await runRemedy(id, r);
      if (msg) notify(msg);
    } catch (e) {
      notify((e as ApiError).message, 'err');
    } finally {
      setBusy(false);
    }
  };
  const control = gate.running ? (
    <Button disabled={busy} onClick={() => void post({ action: 'stop' }, '正在停止：在途的请求不打断，已提交的下次续查')}>
      <Square size={14} color="var(--err)" /> 停止
    </Button>
  ) : pendingLeft ? (
    <Button variant="primary" disabled={busy} onClick={() => void post({ action: 'continue', gateId: gate.id }, `继续生成确认单 #${gate.id}`)}>
      <Play size={14} /> 继续生成
    </Button>
  ) : null;

  return (
    <>
      {head(
        <>
          <label className={s.gateSelect}>
            确认单
            <select value={gate.id} aria-label="选确认单" onChange={(e) => setParams({ gate: e.target.value })}>
              {view.gates.map((g) => (
                <option key={g.id} value={g.id}>
                  #{g.id}
                  {g.running ? ' · 生成中' : ''}
                </option>
              ))}
            </select>
            {phase === 'running' ? <Badge tone="run">生成中</Badge> : phase === 'failed' ? <Badge tone="err">{gate.total ? '出错' : '没开始'}</Badge> : phase === 'pending' ? <Badge tone="run">待开始</Badge> : null}
          </label>
          {control}
          {back}
        </>,
      )}
      {phase === 'pending' ? (
        <GatePending gate={gate} busy={busy} onStart={() => void post({ action: 'continue', gateId: gate.id }, `开始生成确认单 #${gate.id}`)} />
      ) : phase === 'failed' && !gate.total ? (
        <GateFailed gate={gate} busy={busy} banner={false} onRemedy={() => void remedy()} onContinue={() => void post({ action: 'continue', gateId: gate.id }, `继续生成确认单 #${gate.id}`)} />
      ) : (
        <>
      <GateBar view={view} gate={gate} reused={reused} />
      {gate.error ? <GateFailed gate={gate} busy={busy} banner onRemedy={() => void remedy()} onContinue={() => void post({ action: 'continue', gateId: gate.id }, `继续生成确认单 #${gate.id}`)} /> : null}
      <div className={s.layout}>
        <div className={s.col}>
          {view.characters.length ? <Characters projectId={id} view={view} ctx={ctx} selected={selected} onSelect={setSelected} /> : null}
          {view.keyframes.length ? <TaskTable projectId={id} title="关键帧" icon={<ImageIcon size={15} />} groups={view.keyframes} ctx={ctx} selected={selected} onSelect={setSelected} /> : null}
          {view.videos.length ? <TaskTable projectId={id} title="视频" icon={<Film size={15} />} groups={view.videos} ctx={ctx} selected={selected} onSelect={setSelected} /> : null}
          {!view.characters.length && !view.keyframes.length && !view.videos.length ? <section className={`${s.empty} ${cardClass}`}><p>这张确认单还没有任务：同样的输入都生成过了，或者还没开始生成。</p></section> : null}
        </div>
        {selected !== null ? (
          <TaskDetail
            key={selected}
            projectId={id}
            taskId={selected}
            title={titles.get(selected) ?? `任务 #${selected}`}
            jobRunning={gate.running}
            reloadKey={reloadKey}
            onPreview={setPreview}
            onClose={() => setSelected(null)}
            onDone={(msg) => {
              notify(msg);
              reload();
            }}
            onError={(e) => notify(e.message, 'err')}
          />
        ) : (
          <aside className={`${s.detail} ${cardClass}`}>
            <p className={s.hint}>点缩略图或表格里的一行，看大图、提示词、参考图和经过。</p>
          </aside>
        )}
      </div>
        </>
      )}
      {preview !== null && items.length ? <MediaViewer projectId={id} items={items} current={preview} onChange={(tid) => { setPreview(tid); setSelected(tid); }} onClose={() => setPreview(null)} /> : null}
      {toast}
    </>
  );
}

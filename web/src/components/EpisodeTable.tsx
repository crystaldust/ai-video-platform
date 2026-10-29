// 分集全貌表：每集的剧本 / 站位 / 分镜状态与数字、这一集付费生成的估算。点一行在右侧面板看这一集。
import { useState } from 'react';
import { epLabel, seconds, yuanRange } from '../format.ts';
import type { CellState, EpisodeRow, ProjectEstimate } from '../types.ts';
import { Dot, type Tone } from './ui.tsx';
import s from './overview.module.css';

const CELL_TONE: Record<CellState, Tone> = { ok: 'ok', stale: 'warn', missing: 'idle' };
const CELL_COLOR: Record<CellState, string> = { ok: 'var(--text-1)', stale: 'var(--warn)', missing: 'var(--text-3)' };

function Cell({ state, text, reason }: { state: CellState; text: string; reason: string | null }) {
  return (
    <div className={s.cell} style={{ color: CELL_COLOR[state] }}>
      <span>
        <Dot tone={CELL_TONE[state]} />
        {state === 'missing' ? '还没有' : text}
      </span>
      {reason ? <small>{reason}</small> : null}
    </div>
  );
}

const needsAttention = (e: EpisodeRow) => [e.script.state, e.staging.state, e.storyboard.state].includes('stale');

export function EpisodeTable({ episodes, selected, onSelect, estimate }: { episodes: readonly EpisodeRow[]; selected: string | null; onSelect: (id: string) => void; estimate: ProjectEstimate | null }) {
  const [filter, setFilter] = useState<'all' | 'pending'>('all');
  const pending = episodes.filter(needsAttention);
  const shown = filter === 'all' ? episodes : pending;
  const totals = {
    scenes: episodes.reduce((a, e) => a + e.script.scenes, 0),
    segments: episodes.reduce((a, e) => a + e.storyboard.segments, 0),
    cuts: episodes.reduce((a, e) => a + e.storyboard.cuts, 0),
    seconds: episodes.reduce((a, e) => a + e.storyboard.seconds, 0),
  };
  const paid = estimate ? estimate.nodes.filter((n) => n.node.startsWith('image:') || n.node.startsWith('video:')) : [];
  const total = estimate && paid.every((n) => n.cost) ? { low: paid.reduce((a, n) => a + n.cost!.low, 0) * estimate.fx.usdToCny, high: paid.reduce((a, n) => a + n.cost!.high, 0) * estimate.fx.usdToCny } : null;
  return (
    <section className={s.table} aria-label="分集全貌">
      <div className={s.tableTitle}>
        <b>分集全貌</b>
        <span>
          {episodes.length} 集 · {totals.scenes} 场 · {totals.segments} 段 · {totals.cuts} 切 · 合计 {seconds(totals.seconds)}
        </span>
        <div className={`${s.filters} filters`} style={{ marginLeft: 'auto' }}>
          <button type="button" className={s.filter} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            全部
          </button>
          <button type="button" className={s.filter} aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>
            待处理 {pending.length}
          </button>
        </div>
      </div>
      <div className={`${s.grid} ${s.thead}`}>
        <span>集</span>
        <span>钩子</span>
        <span>剧本</span>
        <span>站位</span>
        <span>分镜</span>
        <span>生成预估</span>
      </div>
      {shown.map((e) => (
        <div
          key={e.id}
          role="button"
          tabIndex={0}
          data-testid={`episode-${e.ep}`}
          className={`${s.grid} ${s.row} ${selected === e.id ? s.rowSelected : ''}`}
          onClick={() => onSelect(e.id)}
          onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && onSelect(e.id)}
        >
          <span className={s.ep}>{epLabel(e.ep)}</span>
          <span className={s.hook}>
            <b>{e.hook || '（大纲没写钩子）'}</b>
            <small>{e.synopsis}</small>
          </span>
          <Cell state={e.script.state} text={`${e.script.scenes} 场 · ${e.script.lines} 句`} reason={e.script.reason} />
          <Cell state={e.staging.state} text={`${e.staging.scenes} 场`} reason={e.staging.reason} />
          <Cell state={e.storyboard.state} text={`${e.storyboard.segments} 段 · ${e.storyboard.cuts} 切`} reason={e.storyboard.reason} />
          <span className={s.est}>{e.estimate ? yuanRange(e.estimate, 1) : '—'}</span>
        </div>
      ))}
      {shown.length === 0 ? <div className={s.muted} style={{ padding: 24, textAlign: 'center' }}>{filter === 'pending' ? '没有需要处理的集' : '大纲还没有分集'}</div> : null}
      <div className={s.tableFoot}>
        <span>{estimate ? `预估按「${estimate.preset}」预设：${paid.map((n) => n.model.split(':')[1]).join(' · ')}；分镜还没有的集不计` : '还不能估算'}</span>
        <b>合计 {yuanRange(total, 0)}</b>
      </div>
    </section>
  );
}

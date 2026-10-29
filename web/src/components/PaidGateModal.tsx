// 付费确认弹窗：按节点 × 集勾选（需复核、还没有分镜的集默认不勾），设单次上限，确认后确认单定下来。
// 实际生成在 Phase 5 的付费生成模块执行；这里只记勾选与上限。
import { Gauge, Info, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, projectPath, useApi } from '../api.ts';
import { epLabel, yuanRange } from '../format.ts';
import type { GateView, NodeEstimate } from '../types.ts';
import { Button, ErrorView, Loading } from './ui.tsx';
import s from './overview.module.css';

const TITLES: Record<string, string> = { 'image:character-refs': '角色参考图', 'image:keyframe': '关键帧', 'video:segment': '视频' };
type Range = { low: number; high: number };
const add = (a: Range, b: Range | null): Range => (b ? { low: a.low + b.low, high: a.high + b.high } : a);
const times = (r: Range | null, k: number): Range | null => (r ? { low: r.low * k, high: r.high * k } : null);

function Group({ node, view, fx, picked, toggle }: { node: NodeEstimate; view: GateView; fx: number; picked: ReadonlySet<string>; toggle: (keys: string[], on: boolean) => void }) {
  const byEp = new Map((node.episodes ?? []).map((e) => [e.episode, e]));
  const ok = view.episodes.filter((e) => e.state === 'ok' && byEp.has(e.id));
  const rest = view.episodes.filter((e) => !(e.state === 'ok' && byEp.has(e.id)));
  const key = (ep: string) => `${node.node}|${ep}`;
  const okKeys = ok.map((e) => key(e.id));
  const sumOk = ok.reduce<Range>((a, e) => add(a, byEp.get(e.id)?.cost ?? null), { low: 0, high: 0 });
  const all = [...byEp.keys()].map(key);
  const on = all.filter((k) => picked.has(k)).length;
  const head = on === 0 ? false : on === all.length ? true : 'mixed';
  return (
    <div className={s.group}>
      <label className={s.groupHead}>
        <input type="checkbox" className={s.check} checked={head === true} ref={(el) => {
            if (el) el.indeterminate = head === 'mixed';
          }} onChange={(e) => toggle(all, e.target.checked)} />
        <b>{TITLES[node.node]}</b>
        <span className={`mono ${s.dim}`}>{node.model.split(':')[1]}</span>
        <em>{yuanRange(times(node.cost, fx))}</em>
      </label>
      {ok.length ? (
        <label className={s.groupRow}>
          <input type="checkbox" className={s.check} checked={okKeys.every((k) => picked.has(k))} onChange={(e) => toggle(okKeys, e.target.checked)} />第 {ok.map((e) => epLabel(e.ep)).join('、')} 集
          <em>{yuanRange(times(sumOk, fx))}</em>
        </label>
      ) : null}
      {rest.map((e) => {
        const est = byEp.get(e.id);
        return (
          <label key={e.id} className={s.groupRow}>
            <input type="checkbox" className={s.check} disabled={!est} checked={picked.has(key(e.id))} onChange={(x) => toggle([key(e.id)], x.target.checked)} />
            第 {epLabel(e.ep)} 集<span style={{ color: e.state === 'stale' ? 'var(--warn)' : 'var(--text-3)' }}>{e.note}</span>
            <em className={s.dim}>{est ? yuanRange(times(est.cost, fx)) : '—'}</em>
          </label>
        );
      })}
    </div>
  );
}

export function PaidGateModal({ projectId, gateId, onClose, onDone }: { projectId: string; gateId: number; onClose: () => void; onDone: (msg: string) => void }) {
  const view = useApi<GateView>(projectPath(projectId, `/gates/${gateId}`));
  // Esc 关闭弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [refs, setRefs] = useState(true);
  const [cap, setCap] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const est = view.data?.gate.estimate;
  const fx = est?.fx.usdToCny ?? 1;
  const nodes = est?.nodes.filter((n) => n.node.startsWith('image:') || n.node.startsWith('video:')) ?? [];
  const charNode = nodes.find((n) => n.node === 'image:character-refs');
  const epNodes = nodes.filter((n) => n.episodes);
  // 默认：分镜有、也不需复核的集都勾上
  const okEps = new Set(view.data?.episodes.filter((e) => e.state === 'ok').map((e) => e.id));
  const defaults = new Set(epNodes.flatMap((n) => (n.episodes ?? []).filter((e) => okEps.has(e.episode)).map((e) => `${n.node}|${e.episode}`)));
  const selected = picked ?? defaults;
  const total = epNodes.reduce<Range>((a, n) => (n.episodes ?? []).filter((e) => selected.has(`${n.node}|${e.episode}`)).reduce<Range>((b, e) => add(b, e.cost), a), refs && charNode?.cost ? charNode.cost : { low: 0, high: 0 });
  const totalCny = times(total, fx)!;
  const stale = view.data?.episodes.filter((e) => e.state === 'stale') ?? [];
  const toggle = (keys: string[], on: boolean) => {
    const next = new Set(selected);
    for (const k of keys) (on ? next.add(k) : next.delete(k));
    setPicked(next);
  };
  const nothing = !(refs && charNode) && !epNodes.some((n) => (n.episodes ?? []).some((e) => selected.has(`${n.node}|${e.episode}`)));
  const capValue = cap === '' ? Math.ceil(totalCny.high) : Number(cap);
  const capOk = Number.isFinite(capValue) && capValue > 0;
  const confirm = async () => {
    setBusy(true);
    setError(null);
    const selection: Record<string, true | string[]> = {};
    if (refs && charNode) selection['image:character-refs'] = true;
    for (const n of epNodes) selection[n.node] = (n.episodes ?? []).filter((e) => selected.has(`${n.node}|${e.episode}`)).map((e) => e.episode);
    try {
      const budgetCap = capValue;
      await api.post(projectPath(projectId, `/gates/${gateId}`), { action: 'confirm', selection, budgetCap });
      onDone('已确认。图片和视频会在付费生成模块（Phase 5）执行，这里先记下勾选与上限');
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };
  return (
    <div className={s.backdrop} role="dialog" aria-modal aria-label="确认付费生成" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={s.modal}>
        <div className={s.modalBody}>
          <div className={s.modalHead}>
            <div>
              <h2>确认付费生成</h2>
              <p>预设「{est?.preset ?? '—'}」 · {est?.note ?? ''}</p>
            </div>
            <button type="button" className={s.iconBtn} aria-label="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
          {view.error ? <ErrorView error={view.error} /> : null}
          {!view.data && !view.error ? <Loading what="读取确认单" /> : null}
          {view.data && view.data.gate.status !== 'awaiting_confirmation' ? <div className={s.notice}>这张确认单已经是「{view.data.gate.status}」，不能再改。</div> : null}
          {stale.length ? (
            <div className={s.notice}>
              <Info size={15} color="var(--warn)" style={{ flex: 'none' }} />第 {stale.map((e) => epLabel(e.ep)).join('、')} 集需复核，默认不生成。处理完后可以单独补生成，已生成的不会重复付费。
            </div>
          ) : null}
          {charNode ? (
            <div className={s.group}>
              <label className={s.groupHead}>
                <input type="checkbox" className={s.check} checked={refs} onChange={(e) => setRefs(e.target.checked)} />
                <b>{TITLES[charNode.node]}</b>
                <span className={`mono ${s.dim}`}>{charNode.model.split(':')[1]}</span>
                <em>{yuanRange(times(charNode.cost, fx))}</em>
              </label>
              <div className={s.groupRow}>
                {view.data?.characters.join(' · ')} <span className={s.dim}>{charNode.assumptions[0]}</span>
              </div>
            </div>
          ) : null}
          {view.data ? epNodes.map((n) => <Group key={n.node} node={n} view={view.data!} fx={fx} picked={selected} toggle={toggle} />) : null}
          <label className={s.cap}>
            <Gauge size={15} /> 单次上限 ¥
            <input inputMode="decimal" value={cap} placeholder={String(Math.ceil(totalCny.high))} onChange={(e) => setCap(e.target.value.replace(/[^\d.]/g, ''))} />
            {capOk ? '实际花费超过上限时自动暂停，等你确认' : <span style={{ color: 'var(--err)' }}>上限要是正数</span>}
          </label>
          {error ? <ErrorView error={error} /> : null}
        </div>
        <div className={s.modalFoot}>
          <div>
            <b>本次预估 {yuanRange(totalCny)}</b>
            <small>{est?.incomplete ? '有节点没有价格，合计只算了有价格的部分' : '提交后记下勾选与上限；断线后只重新查询，不会重新付费'}</small>
          </div>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy || nothing || !capOk || !view.data || view.data.gate.status !== 'awaiting_confirmation'} title={nothing ? '一项都没勾' : capOk ? undefined : '单次上限要是正数'} onClick={() => void confirm()}>
            确认
          </Button>
        </div>
      </div>
    </div>
  );
}

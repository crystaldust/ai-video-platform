// 付费确认弹窗：按节点 × 集勾选（需复核、还没有分镜的集默认不勾），设单次上限，确认后确认单定下来并在后台开跑。
// 同样的输入以前出过的会跳过（不再出、不计费）：每组下面说明，合计里扣掉。
import { CircleAlert, Gauge, History, Info, RotateCcw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, projectPath, useApi } from '../api.ts';
import { epLabel, yuan, yuanRange } from '../format.ts';
import { remedyFor, skippedFor, type Remedy } from '../generation.ts';
import { runRemedy } from '../remedy-action.ts';
import type { GateView, NodeEstimate, PaidGateRow } from '../types.ts';
import { Button, ErrorView, Loading } from './ui.tsx';
import s from './overview.module.css';

const TITLES: Record<string, string> = { 'image:character-refs': '角色参考图', 'image:keyframe': '关键帧', 'video:segment': '视频' };
type Range = { low: number; high: number };
const add = (a: Range, b: Range | null): Range => (b ? { low: a.low + b.low, high: a.high + b.high } : a);
const times = (r: Range | null, k: number): Range | null => (r ? { low: r.low * k, high: r.high * k } : null);

function SkipRow({ skip }: { skip: { count: number; cny: number } | undefined }) {
  if (!skip) return null;
  return (
    <div className={`${s.groupRow} ${s.skipRow}`}>
      <History size={13} /> 已生成过 {skip.count} 张，同样的输入不再出、不计费
      <em>−{yuan(skip.cny, 1)}</em>
    </div>
  );
}

/** 这个节点计划不出来：红色一行说原因（设计稿「付费确认 · 计划不出来」），能一键补救的给按钮。 */
function PlanErrorRow({ error, onRemedy }: { error: string | undefined; onRemedy: (r: Remedy) => void }) {
  if (!error) return null;
  const remedy = remedyFor(error);
  return (
    <div className={`${s.groupRow} ${s.planErrorRow}`} role="alert">
      <CircleAlert size={13} />
      <span>计划不出来：{error}</span>
      {remedy ? (
        <Button onClick={() => onRemedy(remedy)}>
          <RotateCcw size={13} /> {remedy.label}
        </Button>
      ) : null}
    </div>
  );
}

function Group({ node, view, fx, picked, toggle, skip, error, onRemedy }: { node: NodeEstimate; view: GateView; fx: number; picked: ReadonlySet<string>; toggle: (keys: string[], on: boolean) => void; skip: { count: number; cny: number } | undefined; error: string | undefined; onRemedy: (r: Remedy) => void }) {
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
    <div className={`${s.group} ${error ? s.groupBlocked : ''}`}>
      <label className={s.groupHead}>
        <input type="checkbox" className={s.check} disabled={Boolean(error)} checked={head === true} ref={(el) => {
            if (el) el.indeterminate = head === 'mixed';
          }} onChange={(e) => toggle(all, e.target.checked)} />
        <b>{TITLES[node.node]}</b>
        <span className={`mono ${s.dim}`}>{node.model.split(':')[1]}</span>
        <em>{yuanRange(times(node.cost, fx))}</em>
      </label>
      {ok.length ? (
        <label className={s.groupRow}>
          <input type="checkbox" className={s.check} disabled={Boolean(error)} checked={okKeys.every((k) => picked.has(k))} onChange={(e) => toggle(okKeys, e.target.checked)} />第 {ok.map((e) => epLabel(e.ep)).join('、')} 集
          <em>{yuanRange(times(sumOk, fx))}</em>
        </label>
      ) : null}
      {rest.map((e) => {
        const est = byEp.get(e.id);
        return (
          <label key={e.id} className={s.groupRow}>
            <input type="checkbox" className={s.check} disabled={!est || Boolean(error)} checked={picked.has(key(e.id))} onChange={(x) => toggle([key(e.id)], x.target.checked)} />
            第 {epLabel(e.ep)} 集<span style={{ color: e.state === 'stale' ? 'var(--warn)' : 'var(--text-3)' }}>{e.note}</span>
            <em className={s.dim}>{est ? yuanRange(times(est.cost, fx)) : '—'}</em>
          </label>
        );
      })}
      <SkipRow skip={skip} />
      <PlanErrorRow error={error} onRemedy={onRemedy} />
    </div>
  );
}

type Decided = { gate: PaidGateRow; started: boolean; reason?: string };

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
  // null = 没改过：跟着本次预估的上限走（框里显示真值，不用灰色占位，免得看起来像没设上限）
  const [cap, setCap] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const est = view.data?.gate.estimate;
  const fx = est?.fx.usdToCny ?? 1;
  const nodes = est?.nodes.filter((n) => n.node.startsWith('image:') || n.node.startsWith('video:')) ?? [];
  const charNode = nodes.find((n) => n.node === 'image:character-refs');
  // 计划不出来的节点不能勾（确认了也只会在后台失败）
  const planErrors = view.data?.planErrors ?? {};
  const refsOn = refs && Boolean(charNode) && !planErrors['image:character-refs'];
  const epNodes = nodes.filter((n) => n.episodes);
  // 默认：分镜有、也不需复核的集都勾上
  const okEps = new Set(view.data?.episodes.filter((e) => e.state === 'ok').map((e) => e.id));
  const defaults = new Set(epNodes.flatMap((n) => (n.episodes ?? []).filter((e) => okEps.has(e.episode)).map((e) => `${n.node}|${e.episode}`)));
  const selected = new Set([...(picked ?? defaults)].filter((k) => !planErrors[k.split('|')[0]!]));
  const total = epNodes.reduce<Range>((a, n) => (n.episodes ?? []).filter((e) => selected.has(`${n.node}|${e.episode}`)).reduce<Range>((b, e) => add(b, e.cost), a), refsOn && charNode?.cost ? charNode.cost : { low: 0, high: 0 });
  const skipped = view.data ? skippedFor(view.data.skipByNode, refsOn, selected) : { count: 0, cny: 0, byNode: {} as Record<string, { count: number; cny: number }> };
  const gross = times(total, fx)!;
  const totalCny = { low: Math.max(0, gross.low - skipped.cny), high: Math.max(0, gross.high - skipped.cny) };
  const stale = view.data?.episodes.filter((e) => e.state === 'stale') ?? [];
  const toggle = (keys: string[], on: boolean) => {
    const next = new Set(selected);
    for (const k of keys) (on ? next.add(k) : next.delete(k));
    setPicked(next);
  };
  const nothing = !refsOn && !epNodes.some((n) => (n.episodes ?? []).some((e) => selected.has(`${n.node}|${e.episode}`)));
  const defaultCap = Math.max(1, Math.ceil(totalCny.high));
  const capValue = cap === null ? defaultCap : cap === '' ? Number.NaN : Number(cap);
  const capOk = Number.isFinite(capValue) && capValue > 0;
  const remedy = async (r: Remedy) => {
    try {
      const msg = await runRemedy(projectId, r);
      if (msg) onDone(msg);
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    const selection: Record<string, true | string[]> = {};
    if (refsOn) selection['image:character-refs'] = true;
    for (const n of epNodes) selection[n.node] = (n.episodes ?? []).filter((e) => selected.has(`${n.node}|${e.episode}`)).map((e) => e.episode);
    try {
      const budgetCap = capValue;
      const r = await api.post<Decided>(projectPath(projectId, `/gates/${gateId}`), { action: 'confirm', selection, budgetCap });
      onDone(r.started ? `已确认 #${gateId}，开始生成：进度在付费条和生成任务页` : `已确认 #${gateId}。${r.reason ?? '没有开始生成：到生成任务页点「继续生成」'}`);
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
              <h2>确认付费生成 #{gateId}</h2>
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
            <div className={`${s.group} ${planErrors['image:character-refs'] ? s.groupBlocked : ''}`}>
              <label className={s.groupHead}>
                <input type="checkbox" className={s.check} disabled={Boolean(planErrors['image:character-refs'])} checked={refsOn} onChange={(e) => setRefs(e.target.checked)} />
                <b>{TITLES[charNode.node]}</b>
                <span className={`mono ${s.dim}`}>{charNode.model.split(':')[1]}</span>
                <em>{yuanRange(times(charNode.cost, fx))}</em>
              </label>
              <div className={s.groupRow}>
                {view.data?.characters.join(' · ')} <span className={s.dim}>{charNode.assumptions[0]}</span>
              </div>
              {refsOn ? <SkipRow skip={skipped.byNode['image:character-refs']} /> : null}
              <PlanErrorRow error={planErrors['image:character-refs']} onRemedy={(r) => void remedy(r)} />
            </div>
          ) : null}
          {view.data ? epNodes.map((n) => <Group key={n.node} node={n} view={view.data!} fx={fx} picked={selected} toggle={toggle} skip={skipped.byNode[n.node]} error={planErrors[n.node]} onRemedy={(r) => void remedy(r)} />) : null}
          <label className={s.cap}>
            <Gauge size={15} /> 单次上限 ¥
            <input inputMode="decimal" aria-label="单次上限（元）" value={cap ?? String(defaultCap)} onChange={(e) => setCap(e.target.value.replace(/[^\d.]/g, ''))} />
            {capOk ? (cap === null ? '默认填本次预估的上限；实际花费超过上限时自动暂停' : '实际花费超过上限时自动暂停，等你确认') : <span style={{ color: 'var(--err)' }}>上限要是正数</span>}
          </label>
          {error ? <ErrorView error={error} /> : null}
        </div>
        <div className={s.modalFoot}>
          <div>
            <b>本次预估 {yuanRange(totalCny)}</b>
            <small>{est?.incomplete ? '有节点没有价格，合计只算了有价格的部分' : '确认后在后台开始生成，进度在全貌和生成任务页；断线后只重新查询，不会重新付费'}</small>
          </div>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy || nothing || !capOk || !view.data || view.data.gate.status !== 'awaiting_confirmation'} title={nothing ? '一项都没勾' : capOk ? undefined : '单次上限要是正数'} onClick={() => void confirm()}>
            确认并开始生成
          </Button>
        </div>
      </div>
    </div>
  );
}

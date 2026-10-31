// 全貌：运行摘要、阶段流水线、分集表 + 详情面板；有任务在跑时换成运行记录 + 「正在进行」。
// 进度靠 SSE：收到事件就重新拉全貌（合并成每 0.7 秒最多一次），数据都在库里，断线重连也不会错。
import { Pause, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { api, ApiError, projectPath, useApi, useProjectEvents } from '../api.ts';
import { DetailPanel } from '../components/DetailPanel.tsx';
import { EpisodeTable } from '../components/EpisodeTable.tsx';
import { PaidGateModal } from '../components/PaidGateModal.tsx';
import { CurrentPanel, RunLog } from '../components/RunLog.tsx';
import { StagePipeline } from '../components/StagePipeline.tsx';
import { Button, ButtonHint, ErrorView, Loading, PageHead, Segmented, useToast } from '../components/ui.tsx';
import s from '../components/overview.module.css';
import { clock, yuan, yuanRange } from '../format.ts';
import type { Overview, PendingItem } from '../types.ts';

const RELOAD_MS = 700;

function Metric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className={s.metric}>
      <small>{label}</small>
      <b>{value}</b>
      {unit ? <span>{unit}</span> : null}
    </div>
  );
}

/** 付费阶段合计（人民币）：确认按钮上的「约 ¥…」。 */
function paidTotal(o: Overview): { low: number; high: number } | null {
  const e = o.estimate;
  if (!e) return null;
  const nodes = e.nodes.filter((n) => !n.node.startsWith('text:'));
  if (nodes.some((n) => !n.cost)) return null;
  return { low: nodes.reduce((a, n) => a + n.cost!.low, 0) * e.fx.usdToCny, high: nodes.reduce((a, n) => a + n.cost!.high, 0) * e.fx.usdToCny };
}

export function OverviewPage() {
  const { id = '' } = useParams();
  const o = useApi<Overview>(projectPath(id, '/overview'));
  const [toast, notify] = useToast();
  const [selectedEp, setSelectedEp] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<PendingItem | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useProjectEvents(id, (e) => {
    if (e.type === 'job-end' && e['ok'] === false) notify(`任务失败：${String(e['message'])}`, 'err');
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      o.reload();
    }, RELOAD_MS);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const data = o.data;
  const running = Boolean(data?.job) || data?.orchestration?.status === 'running';
  // 运行中让用时走起来
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  if (o.error && !data) return <ErrorView error={o.error} onRetry={o.reload} />;
  if (!data) return <Loading what="读取全貌（各阶段质量门要跑一下 skill 的检查）" />;

  const pending = data.pending;
  // 选中项按 (类型, 阶段, 集) 在最新数据里重新找：原因、运行号都用新的
  const fresh = selectedItem ? pending.find((p) => p.kind === selectedItem.kind && p.stage === selectedItem.stage && p.episode === selectedItem.episode) : undefined;
  const item = fresh ?? (selectedEp ? (pending.find((p) => p.episode === selectedEp) ?? null) : (pending[0] ?? null));
  // 转人工的项点名了上游的某一集，就把这一集带上：打回框默认只改那一集
  const episodeId = item?.episode ?? item?.upstream?.episode ?? selectedEp;
  const episode = data.episodes.find((e) => e.id === episodeId) ?? null;
  const next = pending.find((p) => p !== item && !(item && p.stage === item.stage && p.episode === item.episode)) ?? null;
  const elapsed = data.orchestration ? (data.orchestration.endedAt ? data.summary.elapsedMs : now - Date.parse(data.orchestration.startedAt)) : null;
  const total = paidTotal(data);
  const done = (msg: string) => {
    notify(msg);
    o.reload();
  };
  const fail = (e: ApiError) => notify(e.problems.length ? `${e.message}：${e.problems[0]}` : e.message, 'err');
  const action = async (path: string, body: unknown, msg: string) => {
    try {
      await api.post(projectPath(id, path), body);
      done(msg);
    } catch (e) {
      fail(e as ApiError);
    }
  };

  return (
    <>
      <PageHead
        title="全貌"
        sub={running ? '文本阶段运行中 · 不需要你操作，跑完会停在付费生成之前' : '从梗概一键跑完文本阶段；付费生成需要你确认'}
        actions={
          <>
            <Segmented label="模型预设" value={data.project.preset} options={data.presets.map((p) => ({ value: p.name, label: p.title }))} onChange={(v) => void action('/models', { action: 'preset', preset: v }, '已切换预设，估算已更新')} />
            {running ? (
              <Button disabled title="编排暂不支持中途暂停：可以直接关掉页面，重开后从断点继续">
                <Pause size={14} /> 运行中
              </Button>
            ) : (
              <Button onClick={() => void action('/go', { mode: 'all' }, '开始跑文本阶段：没产物的从头跑，需复核的只改受影响的集')}>
                <RotateCcw size={14} /> 重跑文本阶段
              </Button>
            )}
            <Button variant="primary" disabled={!data.gate || running} onClick={() => setGateOpen(true)} title={data.gate ? undefined : '文本阶段跑完后才会生成付费确认单'}>
              确认付费生成 <ButtonHint>约 {yuanRange(total, 0)}</ButtonHint>
            </Button>
          </>
        }
      />
      <div className={s.summary}>
        <Metric label="文本阶段" value={`${data.summary.textPassed}/${data.summary.textTotal}`} unit={running ? '已完成' : data.summary.textPassed === data.summary.textTotal ? '已跑完' : '已完成'} />
        <Metric label="对话推进" value="0" unit="次" />
        <Metric label="用时" value={clock(elapsed)} />
        <Metric label="文本花费" value={yuan(data.summary.textCost.cny)} unit={data.log[0]?.model.split(':')[0] ?? ''} />
        <Metric label="待你处理" value={String(data.summary.pending)} unit="项" />
      </div>
      <StagePipeline stages={data.stages} log={data.log} estimate={data.estimate} estimateError={data.estimateError} />
      {running ? (
        <div className={s.body}>
          <RunLog log={data.log} />
          <CurrentPanel log={data.log} stages={data.stages} />
        </div>
      ) : null}
      {/* 运行中也留着分集表：能看各集进度、选好集；任务在跑时打回、重跑按钮是禁用的 */}
      <div className={s.body}>
        <EpisodeTable
          episodes={data.episodes}
          selected={episodeId}
          estimate={data.estimate}
          onSelect={(ep) => {
            setSelectedEp(ep);
            setSelectedItem(null);
          }}
        />
        <DetailPanel
          projectId={id}
          item={item}
          episode={episode}
          next={next}
          busy={Boolean(data.job)}
          stages={data.stages}
          totalEpisodes={data.episodes.length}
          onNext={(n) => {
            setSelectedItem(n);
            setSelectedEp(n.episode);
          }}
          onClose={() => {
            setSelectedEp(null);
            setSelectedItem(null);
          }}
          onDone={done}
          onError={fail}
        />
      </div>
      {gateOpen && data.gate ? (
        <PaidGateModal
          projectId={id}
          gateId={data.gate.id}
          onClose={() => setGateOpen(false)}
          onDone={(msg) => {
            setGateOpen(false);
            done(msg);
          }}
        />
      ) : null}
      {toast}
    </>
  );
}

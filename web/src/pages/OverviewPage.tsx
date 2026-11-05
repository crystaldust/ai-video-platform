// 全貌：运行摘要、阶段流水线、分集表 + 详情面板；有任务在跑时换成运行记录 + 「正在进行」。
// 进度靠 SSE：收到事件就重新拉全貌（合并成每 0.7 秒最多一次），数据都在库里，断线重连也不会错。
import { ArrowRight, Loader, Pause, RotateCcw, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, ApiError, projectPath, useApi, useProjectEvents } from '../api.ts';
import { DetailPanel } from '../components/DetailPanel.tsx';
import { EpisodeTable } from '../components/EpisodeTable.tsx';
import { PaidGateModal } from '../components/PaidGateModal.tsx';
import { CurrentPanel, RunLog } from '../components/RunLog.tsx';
import { StagePipeline } from '../components/StagePipeline.tsx';
import { Button, ButtonHint, ErrorView, Loading, PageHead, Segmented, useToast } from '../components/ui.tsx';
import s from '../components/overview.module.css';
import { clock, yuan, yuanRange } from '../format.ts';
import { overviewTab, sidePanel, type OverviewTab } from '../overview-tabs.ts';
import type { Overview, PendingItem } from '../types.ts';
import { busyReason, paidButton, rejectSummary, type Remedy } from '../generation.ts';
import { refsConfirm, stageRerunConfirm } from '../rerun.ts';
import { STAGE_TITLE } from '../reject.ts';
import { runRemedy } from '../remedy-action.ts';

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
  // 弹窗里打开的确认单号；null = 没开
  const [openGateId, setOpenGateId] = useState<number | null>(null);
  const [pickedTab, setPickedTab] = useState<OverviewTab | null>(null);
  const [now, setNow] = useState(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useProjectEvents(id, (e) => {
    if (e.type === 'job-end' && e['ok'] === false) notify(`任务失败：${String(e['message'])}`, 'err');
    // 一次打回多集：逐集结果汇总一句
    const summary = e.type === 'job-end' && e['ok'] === true ? rejectSummary(e['result']) : null;
    if (summary) notify(summary.text, summary.failed ? 'err' : 'ok');
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      o.reload();
    }, RELOAD_MS);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const navigate = useNavigate();
  const data = o.data;
  // 付费生成、恢复也是后台任务，但不算「文本阶段运行中」：全貌照常看分集表，付费条显示进度
  const generating = data?.job?.kind === 'generate' || data?.job?.kind === 'resume';
  const running = (Boolean(data?.job) && !generating) || data?.orchestration?.status === 'running';
  // 任务开始、结束时回到自动：开跑看运行记录，跑完回到分集全貌
  useEffect(() => setPickedTab(null), [running]);
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
  const tab = overviewTab(pickedTab, running);
  const gen = data.generation;
  const done = (msg: string) => {
    notify(msg);
    o.reload();
  };
  const fail = (e: ApiError) => notify(e.problems.length ? `${e.message}：${e.problems[0]}` : e.message, 'err');
  // 有后台任务在跑时，置灰的按钮都用这一句说明原因
  const busyText = busyReason(data.job);
  const paid = paidButton({ gateId: data.gate?.id ?? null, busy: running || Boolean(data.job), hasEstimate: Boolean(data.estimate) });
  // 有等待确认的就打开它；没有就先按当前估算开一张，再打开
  const openPaid = async () => {
    if (paid.action === 'open') return setOpenGateId(paid.gateId);
    try {
      const r = await api.post<{ id: number; created: boolean }>(projectPath(id, '/gates'));
      setOpenGateId(r.id);
      o.reload();
    } catch (e) {
      fail(e as ApiError);
    }
  };
  const remedy = async (r: Remedy) => {
    try {
      const msg = await runRemedy(id, r);
      if (msg) done(msg);
    } catch (e) {
      fail(e as ApiError);
    }
  };
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
        sub={running ? '文本阶段运行中 · 不需要你操作，跑完会停在付费生成之前' : generating ? '付费生成在后台跑 · 进度见付费条和生成任务页' : '从梗概一键跑完文本阶段；付费生成需要你确认'}
        actions={
          <>
            <Segmented label="模型预设" value={data.project.preset} options={data.presets.map((p) => ({ value: p.name, label: p.title }))} onChange={(v) => void action('/models', { action: 'preset', preset: v }, '已切换预设，估算已更新')} />
            {running ? (
              // 正在跑什么：后台任务的说明（「打回分镜（第 02 集）」）；命令行在跑的编排没有任务说明，照旧写「运行中」
              <Button disabled className={s.genBadge} title="编排暂不支持中途暂停：可以直接关掉页面，重开后从断点继续">
                {data.job ? <Loader size={14} /> : <Pause size={14} />} {data.job?.detail ?? '运行中'}
              </Button>
            ) : null}
            {running && !data.job ? null : (
              <Button disabled={Boolean(data.job)} title={busyText ?? undefined} onClick={() => void action('/go', { mode: 'all' }, '开始跑文本阶段：没产物的从头跑，需复核的只改受影响的集')}>
                <RotateCcw size={14} /> 重跑文本阶段
              </Button>
            )}
            {generating ? (
              <>
                <Button disabled className={s.genBadge}>
                  <Loader size={14} /> {data.job?.kind === 'resume' ? '恢复中' : '生成中'}
                  {gen ? <ButtonHint>{gen.done}/{gen.total}</ButtonHint> : null}
                </Button>
                <Button onClick={() => void action('/generate', { action: 'stop' }, '正在停止：在途的请求不打断，已提交的下次续查')}>
                  <Square size={14} color="var(--err)" /> 停止
                </Button>
              </>
            ) : null}
            <Button
              variant="primary"
              disabled={paid.disabledReason !== null}
              title={(data.job ? busyText : paid.disabledReason) ?? (paid.action === 'open' ? `打开确认单 #${paid.gateId}` : '按当前估算开一张新的确认单；需复核的集默认不勾，可以先只出角色图')}
              onClick={() => void openPaid()}
            >
              确认付费生成 <ButtonHint>约 {yuanRange(total, 0)}</ButtonHint>
            </Button>
            {gen ? (
              <Button onClick={() => void navigate('tasks')}>
                查看任务 <ArrowRight size={14} />
              </Button>
            ) : null}
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
      <StagePipeline stages={data.stages} log={data.log} estimate={data.estimate} estimateError={data.estimateError} generation={gen}
        onRerun={(stage, cost) => {
          if (!window.confirm(stageRerunConfirm(stage, cost))) return;
          // 带 fresh：阶段卡的重跑说的是「从头重写」，上一次失败留下的集也不沿用
          void action('/go', { only: stage, fresh: true }, `开始重跑${STAGE_TITLE[stage]}阶段`);
        }}
        onRefs={() => {
          if (!window.confirm(refsConfirm())) return;
          void action('/refs', {}, '开始补出图提示词：角色卡正文不变');
        }}
        onRemedy={(r) => void remedy(r)} startDisabled={busyText} onStart={(gateId) => void action('/generate', { action: 'continue', gateId }, `开始生成确认单 #${gateId}：进度在付费条和生成任务页`)} />
      {/* 分集全貌与运行记录并列成两个 tab：运行中也能切去分集表选好集（打回、重跑按钮在跑时是禁用的） */}
      <div className={s.tabs} role="tablist" aria-label="全貌内容">
        {(
          [
            ['episodes', '分集全貌', `${data.episodes.length} 集`],
            ['log', '运行记录', `${data.log.length} 次${running ? ' · 运行中' : ''}`],
          ] as const
        ).map(([k, label, sub]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={s.tab} onClick={() => setPickedTab(k)}>
            {label}
            <small>{sub}</small>
          </button>
        ))}
      </div>
      <div className={s.body}>
        {tab === 'log' ? (
          <RunLog log={data.log} />
        ) : (
          <EpisodeTable
            episodes={data.episodes}
            selected={episodeId}
            estimate={data.estimate}
            onSelect={(ep) => {
              setSelectedEp(ep);
              setSelectedItem(null);
            }}
          />
        )}
        {sidePanel(tab, running) === 'current' ? (
          <CurrentPanel log={data.log} stages={data.stages} />
        ) : (
          <DetailPanel
            projectId={id}
            item={item}
            episode={episode}
            next={next}
            busy={busyText}
            stages={data.stages}
            totalEpisodes={data.episodes.length}
            allEpisodes={data.episodes}
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
        )}
      </div>
      {openGateId !== null ? (
        <PaidGateModal
          projectId={id}
          gateId={openGateId}
          onClose={() => setOpenGateId(null)}
          onDone={(msg) => {
            setOpenGateId(null);
            done(msg);
          }}
        />
      ) : null}
      {toast}
    </>
  );
}

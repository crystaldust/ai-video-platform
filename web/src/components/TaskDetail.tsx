// 生成任务页右侧的详情：大图 / 视频、状态、费用、尺寸、模型、参考图、经过（状态时间线）、实际提示词、失败原因；
// 「全屏看」打开预览，「重新查询」只对提交过还没结束、结果未知、没下载下来的任务可用（不花钱）。
import { Copy, Expand, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, projectPath, useApi } from '../api.ts';
import { stamp } from '../format.ts';
import { costText, taskLabel, taskTone, viewTitle } from '../generation.ts';
import type { TaskDetail as Detail } from '../types.ts';
import s from '../pages/TasksPage.module.css';
import { Badge, Button, cardClass, Dot, ErrorView, Loading } from './ui.tsx';

/** 依赖的显示名：角色视图「C01:front-full」→「C01 正面全身」，关键帧给切的编号。 */
function refName(key: string): string {
  const label = key.split('|')[1] ?? key;
  const [who, view] = label.split(':');
  return view ? `${who} ${viewTitle(view)}` : label;
}

const REQUERYABLE = new Set(['submitted', 'running', 'unknown', 'succeeded']);

function eventText(status: Detail['status'], detail: unknown): string {
  const id = detail && typeof detail === 'object' ? (detail as Record<string, unknown>)['providerTaskId'] : undefined;
  if (status === 'planned') return '排队';
  if (status === 'submitted' && typeof id === 'string') return `提交 · ${id.length > 16 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id}`;
  if (status === 'collected') return '完成 · 已下载入库';
  return taskLabel(status);
}

export function TaskDetail({ projectId, taskId, title, jobRunning, reloadKey, onPreview, onClose, onDone, onError }: {
  projectId: string;
  taskId: number;
  title: string;
  jobRunning: boolean;
  /** 列表刷新时详情也跟着刷新 */
  reloadKey: number;
  onPreview: (taskId: number) => void;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (e: ApiError) => void;
}) {
  const d = useApi<Detail>(projectPath(projectId, `/tasks/${taskId}`));
  const [busy, setBusy] = useState(false);
  const { reload } = d;
  // 列表因为进度事件刷新了：详情也拉一次（第一次渲染由 useApi 自己拉）
  useEffect(() => {
    if (reloadKey > 0) reload();
  }, [reloadKey, reload]);
  if (d.error && !d.data)
    return (
      <aside className={`${s.detail} ${cardClass}`}>
        <ErrorView error={d.error} />
      </aside>
    );
  if (!d.data)
    return (
      <aside className={`${s.detail} ${cardClass}`}>
        <Loading what="读取任务" />
      </aside>
    );
  const t = d.data;
  const src = t.mediaId ? projectPath(projectId, `/media/${t.mediaId}`) : null;
  const isVideo = Boolean(t.mime?.startsWith('video/'));
  const wide = t.node !== 'image:character-refs';
  const canRequery = REQUERYABLE.has(t.status) && !jobRunning;
  const requery = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ status: string }>(projectPath(projectId, `/tasks/${taskId}/requery`));
      onDone(`重新查询完成：${taskLabel(r.status as Detail['status'])}`);
      d.reload();
    } catch (e) {
      onError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className={`${s.detail} ${cardClass}`} aria-label="任务详情">
      <div className={s.detailHead}>
        <div>
          <h2>{title}</h2>
          <small>
            任务 #{t.id}
            {t.gateId ? ` · 确认单 #${t.gateId}` : ''} · {t.label}
            {t.attemptOf ? ` · 重新生成自 #${t.attemptOf}` : ''}
          </small>
        </div>
        <button type="button" className={s.close} aria-label="关闭详情" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className={s.detailTop}>
        <div className={`${s.big} ${wide ? s.bigWide : ''}`}>
          {src ? isVideo ? <video src={src} controls preload="metadata" /> : <img src={src} alt={title} /> : <span>{taskLabel(t.status)}</span>}
          {src ? (
            <button type="button" className={s.expand} aria-label="全屏看" onClick={() => onPreview(t.id)}>
              <Expand size={14} />
            </button>
          ) : null}
        </div>
        <div className={s.facts}>
          <Badge tone={taskTone(t.status)}>{taskLabel(t.status)}</Badge>
          <div>
            <small>预估 / 实际</small>
            <span>
              {t.costEstimate === null ? '—' : `¥${t.costEstimate.toFixed(2)}`} / {t.costActual === null ? '—' : costText(t)}
            </span>
          </div>
          {t.size ? (
            <div>
              <small>尺寸</small>
              <span>{t.size.replace('*', ' × ')}</span>
            </div>
          ) : null}
          <div>
            <small>模型</small>
            <span>{t.model}</span>
          </div>
          {t.refs.length ? (
            <div>
              <small>参考图</small>
              {t.refs.map((r) => (
                <span key={r.key} className={s.refThumb}>
                  {r.task?.mediaId ? <img src={projectPath(projectId, `/media/${r.task.mediaId}`)} alt="" loading="lazy" /> : null}
                  {refName(r.key)} {r.task ? `#${r.task.id}（确认单 #${r.task.gateId ?? '—'}）` : '（还没有）'}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {t.error ? <div className={s.error} role="alert">{t.error}</div> : null}
      <div>
        <div className={s.blockTitle}>经过</div>
        <ol className={s.timeline}>
          {t.events.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <time>{stamp(Date.parse(e.at))}</time>
              <Dot tone={taskTone(e.status)} />
              <span>{eventText(e.status, e.detail)}</span>
            </li>
          ))}
        </ol>
      </div>
      {t.prompt ? (
        <div>
          <div className={s.blockTitle}>
            实际提示词
            <button type="button" onClick={() => void navigator.clipboard?.writeText(t.prompt ?? '').then(() => onDone('已复制提示词'))}>
              <Copy size={12} /> 复制
            </button>
          </div>
          <div className={s.prompt}>{t.prompt}</div>
          <div className={s.promptNote}>
            {t.negativePrompt ? `反向词 ${t.negativePrompt.length} 字 · ` : ''}
            {t.planDiffers ? '和计划不一致（供应商改写过）' : '和计划一致'}
          </div>
        </div>
      ) : null}
      <div className={s.actions}>
        <Button variant="primary" disabled={!src} onClick={() => onPreview(t.id)}>
          <Expand size={14} /> 全屏看
        </Button>
        <Button disabled={!canRequery || busy} title={canRequery ? undefined : jobRunning ? '生成在跑，等它结束' : '只有结果未知、查询放弃或没下载下来的任务需要重新查询'} onClick={() => void requery()}>
          <RefreshCw size={14} /> 重新查询
        </Button>
      </div>
      <p className={s.hint}>重新查询不花钱，只在结果未知或查询放弃时可用。想再出一张属于审阅（Phase 6）。</p>
    </aside>
  );
}

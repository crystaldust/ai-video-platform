// 全屏预览（设计稿「生成任务 · 预览」）：大图或视频、← → 切换、底部缩略图条、Esc 关闭；
// 打开时焦点进弹窗，关闭后还给打开它的元素。只预览已入库（有素材）的任务。
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { projectPath } from '../api.ts';
import { nextPreview } from '../generation.ts';
import s from '../pages/TasksPage.module.css';

export interface PreviewItem {
  readonly taskId: number;
  readonly mediaId: number;
  readonly mime: string | null;
  readonly title: string;
  readonly meta: string;
}

const isVideo = (mime: string | null): boolean => Boolean(mime?.startsWith('video/'));

export function MediaViewer({ projectId, items, current, onChange, onClose }: { projectId: string; items: readonly PreviewItem[]; current: number; onChange: (taskId: number) => void; onClose: () => void }) {
  const ids = items.map((i) => i.taskId);
  const item = items.find((i) => i.taskId === current) ?? items[0];
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = nextPreview(ids, current, e.key === 'ArrowRight' ? 1 : -1);
        if (next !== null) onChange(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ids, current, onChange, onClose]);

  if (!item) return null;
  const src = projectPath(projectId, `/media/${item.mediaId}`);
  const at = ids.indexOf(item.taskId);
  return (
    <div className={s.viewer} role="dialog" aria-modal aria-label={`预览：${item.title}`} tabIndex={-1} ref={dialog}>
      <div className={s.viewerHead}>
        <b>{item.title}</b>
        <span>{item.meta}</span>
        <span className={s.grow} />
        <span>
          {at + 1} / {items.length}
        </span>
        <a href={src} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> 新标签页打开原图
        </a>
        <button type="button" aria-label="关闭预览" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className={s.stage}>
        <button type="button" className={`${s.nav} ${s.prev}`} aria-label="上一张" disabled={at <= 0} onClick={() => onChange(ids[at - 1]!)}>
          <ChevronLeft size={20} />
        </button>
        {isVideo(item.mime) ? <video key={item.mediaId} src={src} controls autoPlay preload="metadata" /> : <img key={item.mediaId} src={src} alt={item.title} />}
        <button type="button" className={`${s.nav} ${s.next}`} aria-label="下一张" disabled={at >= items.length - 1} onClick={() => onChange(ids[at + 1]!)}>
          <ChevronRight size={20} />
        </button>
      </div>
      <div className={s.strip}>
        {items.map((i) => (
          <button key={i.taskId} type="button" aria-label={i.title} aria-current={i.taskId === item.taskId} onClick={() => onChange(i.taskId)}>
            {isVideo(i.mime) ? null : <img src={projectPath(projectId, `/media/${i.mediaId}`)} alt="" loading="lazy" />}
          </button>
        ))}
        <span>← → 切换 · Esc 关闭 · 视频在这里直接播放</span>
      </div>
    </div>
  );
}

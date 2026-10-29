// 通用小组件：按钮、状态徽标、页头、加载 / 空 / 错误三态、提示条、分段切换。只用设计变量。
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { ApiError } from '../api.ts';
import s from './ui.module.css';

export type Tone = 'ok' | 'warn' | 'err' | 'run' | 'idle';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'dark' | 'ghost' | 'default'; block?: boolean };

export function Button({ variant = 'default', block, className, ...rest }: ButtonProps) {
  const cls = [s.btn, variant !== 'default' ? s[variant] : '', block ? s.block : '', className ?? ''].filter(Boolean).join(' ');
  return <button type="button" {...rest} className={cls} />;
}

export const ButtonHint = ({ children }: { children: ReactNode }) => <span className={s.btnHint}>{children}</span>;

export function Badge({ tone, children, plain }: { tone: Tone; children: ReactNode; plain?: boolean }) {
  return <span className={`${s.badge} ${s[`tone-${tone}`]} ${plain ? s.badgePlain : ''}`}>{children}</span>;
}

const DOT: Record<Tone, string> = { ok: 'var(--ok)', warn: 'var(--warn)', err: 'var(--err)', run: 'var(--accent)', idle: 'var(--text-3)' };
export const Dot = ({ tone }: { tone: Tone }) => <span className={s.dot} style={{ background: DOT[tone] }} aria-hidden />;

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className={s.pageHead}>
      <div>
        <h1 className={s.pageTitle}>{title}</h1>
        {sub ? <p className={s.pageSub}>{sub}</p> : null}
      </div>
      {actions ? <div className={s.pageActions}>{actions}</div> : null}
    </header>
  );
}

export const Loading = ({ what = '加载中' }: { what?: string }) => (
  <div className={s.state} role="status">
    {what}…
  </div>
);

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={s.state}>
      <div className={s.stateTitle}>{title}</div>
      {children}
    </div>
  );
}

export function ErrorView({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }) {
  const problems = 'problems' in error ? error.problems : [];
  return (
    <div className={s.state}>
      <div className={s.errorBox} role="alert">
        <strong>{error.message}</strong>
        {problems.length ? (
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {onRetry ? (
        <p>
          <Button onClick={onRetry}>重试</Button>
        </p>
      ) : null}
    </div>
  );
}

/** 页面底部的短提示：成功 3 秒后消失，错误要手动点掉。 */
export function useToast(): [ReactNode, (text: string, kind?: 'ok' | 'err') => void] {
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err'; n: number } | null>(null);
  useEffect(() => {
    if (!toast || toast.kind === 'err') return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);
  const node = toast ? (
    <div className={`${s.toast} ${toast.kind === 'err' ? s.toastErr : ''}`} role={toast.kind === 'err' ? 'alert' : 'status'} onClick={() => setToast(null)}>
      {toast.text}
    </div>
  ) : null;
  return [node, (text, kind = 'ok') => setToast({ text, kind, n: Date.now() })];
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className={s.segmented} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => o.value !== value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const cardClass = s.card;

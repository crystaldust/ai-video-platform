// 运行中视图：左边是项目的运行记录（重跑、打回都追加，按时间倒序），右边是「正在进行」——当前阶段的每次尝试与排队中的阶段。
import { Hourglass, Info } from 'lucide-react';
import { attemptState, callNo, stamp } from '../format.ts';
import type { LogRun, StageCard } from '../types.ts';
import s from './overview.module.css';

const STAGE_TITLE: Record<string, string> = { outline: '大纲', cast: '角色', art: '美术', script: '剧本', staging: '站位', storyboard: '分镜' };
const WAITING: Record<string, string> = { cast: '等大纲', art: '等大纲', script: '等大纲', staging: '等剧本和美术都跑完', storyboard: '等剧本和站位都跑完' };

interface Entry {
  readonly at: number;
  readonly tone: 'ok' | 'err' | 'idle';
  readonly stage: string;
  readonly text: string;
  readonly sub?: string;
}

/** 运行与尝试 → 时间线条目：开始、每次没过的尝试、结束。at 是时刻（毫秒）。 */
function entries(log: readonly LogRun[]): Entry[] {
  const out: Entry[] = [];
  for (const r of log) {
    out.push({ at: Date.parse(r.startedAt), tone: 'idle', stage: STAGE_TITLE[r.stage] ?? r.stage, text: `开始${r.episodeKey ? `（只跑 ${r.episodeKey.split(',').length} 集）` : ''}`, sub: `${r.skill} · ${r.model}` });
    for (const a of r.attempts) {
      if (a.violations.length && a.endedAt) out.push({ at: Date.parse(a.endedAt), tone: 'err', stage: STAGE_TITLE[r.stage] ?? r.stage, text: `${a.step} 第 ${a.n} 次：${a.violations.length} 处违规`, sub: a.violations[0] });
    }
    if (r.endedAt) {
      const ok = r.status === 'passed';
      out.push({ at: Date.parse(r.endedAt), tone: ok ? 'ok' : 'err', stage: STAGE_TITLE[r.stage] ?? r.stage, text: ok ? `通过 · ${r.attempts.length} 次模型调用` : `${r.status === 'needs_human' ? '转人工' : '失败'}：${r.error ?? ''}` });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

const DOT = { ok: 'var(--ok)', err: 'var(--err)', idle: 'var(--text-3)' };

/** 项目的全部运行（重跑、打回都追加在后面），新的在上。 */
export function RunLog({ log }: { log: readonly LogRun[] }) {
  const list = entries(log);
  return (
    <section className={s.log} aria-label="运行记录">
      <div className={s.tableTitle}>
        <b>运行记录</b>
        <span>{log.length} 次运行</span>
      </div>
      {list.map((e, i) => (
        <div key={`${e.at}-${i}`} className={`${s.logRow} ${e.tone === 'err' ? s.logRowErr : ''}`}>
          <span className={s.logTime}>{stamp(e.at)}</span>
          <span className={s.logDot} style={{ background: DOT[e.tone] }} />
          <span className={s.logText}>
            <b style={e.tone === 'err' ? { color: 'var(--err)' } : undefined}>{e.stage}</b>
            {e.text}
            {e.sub ? <small>{e.sub}</small> : null}
          </span>
        </div>
      ))}
      {list.length === 0 ? <div className={s.muted} style={{ padding: 24 }}>刚开始，第一个阶段的结果马上出来</div> : null}
    </section>
  );
}

export function CurrentPanel({ log, stages }: { log: readonly LogRun[]; stages: readonly StageCard[] }) {
  const running = log.filter((r) => r.status === 'running');
  const queued = stages.filter((c) => c.state === 'waiting');
  return (
    <aside className={s.panel} aria-label="正在进行">
      {running.length === 0 ? <p className={s.muted}>正在准备下一个阶段…</p> : null}
      {running.map((r) => {
        const used = Date.now() - Date.parse(r.startedAt);
        const tokens = r.attempts.reduce((a, x) => a + (x.inputTokens ?? 0), 0);
        // 正在调的那一次库里已有行；没有的话（两次调用之间）补一行「进行中」
        const calling = r.attempts.some((a) => attemptState(a) === 'running');
        return (
          <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <div className={s.kicker} style={{ color: 'var(--accent)' }}>
                正在进行 · {STAGE_TITLE[r.stage]}
              </div>
              <h2 className={s.panelTitle}>
                {r.skill.replace('@', ' ')} · 第 {callNo(r.attempts)} 次调用
              </h2>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {r.model} · 已用 {Math.round(used / 1000)} 秒{tokens ? ` · 输入 ${(tokens / 1000).toFixed(1)}k tokens` : ''}
              </span>
            </div>
            {r.attempts.map((a) => {
              const state = attemptState(a);
              if (state === 'running') {
                return (
                  <div key={`${a.step}-${a.n}`} className={`${s.attempt} ${s.attemptRun}`}>
                    <b>{a.step}</b>
                    <span style={{ color: 'var(--accent)' }}>进行中</span>
                    <small>等模型返回</small>
                  </div>
                );
              }
              return (
                <div key={`${a.step}-${a.n}`} className={s.attempt}>
                  <b>{a.step}</b>
                  {state === 'err' ? <span style={{ color: 'var(--err)' }}>{a.violations.length} 处违规</span> : <span style={{ color: 'var(--ok)' }}>通过</span>}
                  {a.violations[0] ? <small>{a.violations[0]}</small> : null}
                </div>
              );
            })}
            {calling ? null : (
              <div className={`${s.attempt} ${s.attemptRun}`}>
                <b>#{r.attempts.length + 1}</b>
                <span style={{ color: 'var(--accent)' }}>进行中</span>
                <small>{r.attempts.at(-1)?.violations.length ? '提示词里附上了上一次的违规' : '等模型返回'}</small>
              </div>
            )}
          </div>
        );
      })}
      {queued.length ? (
        <div className={s.queue}>
          <div className={s.divider} />
          <span className={s.sectionTitle}>排队中</span>
          {queued.map((c) => (
            <div key={c.stage} className={s.queueItem}>
              <Hourglass size={14} color="var(--text-3)" />
              {c.title}
              <small>{WAITING[c.stage] ?? ''}</small>
            </div>
          ))}
        </div>
      ) : null}
      <div className={s.hint}>
        <Info size={14} style={{ flex: 'none' }} />
        可以关掉页面。每个阶段的产出都先写进项目库，重开后从断点继续。
      </div>
    </aside>
  );
}

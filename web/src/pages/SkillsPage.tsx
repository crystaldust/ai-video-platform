// Skill 包：每个阶段挂的 skill、协议能力（seed / validate / ids）、质量门数；已注册的包；换挂载、注册新包。
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { api, ApiError, projectPath, useApi } from '../api.ts';
import { Badge, Button, cardClass, Dot, ErrorView, Loading, PageHead, useToast } from '../components/ui.tsx';
import { when } from '../format.ts';
import type { MountRow, SkillsView } from '../types.ts';
import s from './Settings.module.css';

const PAID_ROWS = [
  { title: '角色参考图', note: 'character-refs · 付费生成模块接入（Phase 5）' },
  { title: '关键帧', note: 'Phase 5' },
  { title: '视频', note: 'Phase 5' },
];

function Caps({ caps }: { caps: MountRow['capabilities'] }) {
  return (
    <span className={s.caps}>
      {(['seed', 'validate', 'ids'] as const).map((k) => (
        <span key={k} className={`${s.cap} ${caps?.[k] ? '' : s.capOff}`}>
          {caps?.[k] ? '✓' : '–'} {k}
        </span>
      ))}
    </span>
  );
}

export function SkillsPage() {
  const { id = '' } = useParams();
  const v = useApi<SkillsView>(projectPath(id, '/skills'));
  const [toast, notify] = useToast();
  const [form, setForm] = useState<{ manifest: string; root: string } | null>(null);
  const post = async (path: string, body: unknown, msg: string) => {
    try {
      await api.post(projectPath(id, path), body);
      notify(msg);
      v.reload();
    } catch (e) {
      const err = e as ApiError;
      notify(err.problems.length ? `${err.message}：${err.problems[0]}` : err.message, 'err');
    }
  };
  if (v.error) return <ErrorView error={v.error} onRetry={v.reload} />;
  if (!v.data) return <Loading what="读取 Skill 包" />;
  const data = v.data;
  return (
    <>
      <PageHead
        title="Skill 包"
        sub="每个阶段挂一套 skill；平台按「seed → 模型填写 → validate → 带错误重试」运行它"
        actions={
          <Button variant="primary" onClick={() => setForm(form ? null : { manifest: '', root: '' })}>
            <Plus size={14} /> 注册 skill 包
          </Button>
        }
      />
      <div className={s.body}>
        <section className={`${cardClass} ${s.tableCard}`}>
          <div className={s.tableTitle}>
            <b>《{data.project.name}》各阶段挂载</b>
            <span>换一个阶段的 skill，下游会全部标为需复核</span>
          </div>
          <table className={s.table}>
            <thead>
              <tr>
                <th>阶段</th>
                <th>挂载的 skill</th>
                <th>质量门</th>
                <th>协议</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {data.mounts.map((m) => (
                <tr key={m.stage}>
                  <td>{m.title}</td>
                  <td>
                    <span className={s.mono}>{m.skill?.name ?? '未挂载'}</span>
                    {m.skill ? <span className={s.ver}>{m.skill.version}</span> : null}
                    {m.alternatives.length ? (
                      <small>
                        可换：
                        {m.alternatives.map((a) => (
                          <button key={a.id} type="button" className="mono" style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }} onClick={() => void post('/mount', { stage: m.stage, skill: a.name, packId: a.packId }, `${m.title}已换挂 ${a.name}`)}>
                            {a.name}@{a.version}
                          </button>
                        ))}
                      </small>
                    ) : null}
                  </td>
                  <td className={s.mono}>{m.gates ? (m.gates.total ?? (m.gates.failed.length ? `${m.gates.failed.length} 处违规` : 'validate')) : '—'}</td>
                  <td>
                    <Caps caps={m.capabilities} />
                  </td>
                  <td>
                    <span className={s.status}>
                      <Dot tone={m.skill ? 'ok' : 'idle'} />
                      {m.skill ? '已挂载' : '未挂载'}
                    </span>
                  </td>
                </tr>
              ))}
              {PAID_ROWS.map((r) => (
                <tr key={r.title} className={s.dimRow}>
                  <td>{r.title}</td>
                  <td>未挂载</td>
                  <td>—</td>
                  <td>
                    <Caps caps={null} />
                  </td>
                  <td>
                    <span className={s.status}>
                      <Dot tone="idle" />
                      {r.note}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={s.foot}>
            <span>
              <b>seed</b>从上游 JSON 预填骨架
            </span>
            <span>
              <b>validate</b>确定性质量门，不过就带错误重试
            </span>
            <span>
              <b>ids</b>给集、场次、段、切分配稳定 id
            </span>
          </div>
        </section>
        <aside className={`${cardClass} ${s.side}`}>
          <h2>已注册的 skill 包</h2>
          {form ? (
            <div className={s.form}>
              <input aria-label="清单路径" placeholder="清单 JSON 的路径，如 ~/skills/my.pack.json" value={form.manifest} onChange={(e) => setForm({ ...form, manifest: e.target.value })} />
              <input aria-label="skills 根目录" placeholder="skills 根目录" value={form.root} onChange={(e) => setForm({ ...form, root: e.target.value })} />
              <Button variant="primary" disabled={!form.manifest || !form.root} onClick={() => void post('/packs', form, '已注册；有阶段的 skill 自动挂载').then(() => setForm(null))}>
                注册
              </Button>
            </div>
          ) : null}
          {data.packs.map((p) => (
            <div key={p.id} className={`${s.pack} ${p.inUse ? s.packOn : ''}`}>
              <div className={s.packHead}>
                <b>{p.name}</b>
                {p.inUse ? <Badge tone="run" plain>本项目在用</Badge> : null}
              </div>
              <span className={s.path}>{p.root}</span>
              <p>
                {p.skills.length} 个 skill{p.description ? `：${p.description}` : ''}
              </p>
              <span className={s.path}>注册于 {when(p.registeredAt)}</span>
            </div>
          ))}
          <p style={{ marginTop: 'auto' }}>同一阶段只挂一套：并行跑多套再择优会让费用成倍增加。</p>
        </aside>
      </div>
      {toast}
    </>
  );
}

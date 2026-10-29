// 模型与预设：两套预设各自的估算、每个节点当前用的模型（可单独覆盖）、凭据状态（只看是否配置与末 4 位）。
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useParams } from 'react-router';
import { api, ApiError, projectPath, useApi } from '../api.ts';
import { Badge, Button, cardClass, Dot, ErrorView, Loading, PageHead, useToast } from '../components/ui.tsx';
import { yuanRange } from '../format.ts';
import type { ModelsView } from '../types.ts';
import s from './Settings.module.css';

const NODE_TITLES: Record<string, [string, string]> = {
  'text:outline': ['文本 · 大纲', 'novel-outline'],
  'text:cast': ['文本 · 角色', 'novel-characters'],
  'text:art': ['文本 · 美术', 'novel-art'],
  'text:script': ['文本 · 剧本', 'novel-script'],
  'text:staging': ['文本 · 站位', 'novel-staging'],
  'text:storyboard': ['文本 · 分镜', 'novel-storyboard'],
  'image:character-refs': ['角色参考图', 'character-refs'],
  'image:keyframe': ['关键帧', '每切一张'],
  'video:segment': ['视频', '每段一次生成'],
};
const PROVIDERS: Record<string, string> = { deepseek: 'DeepSeek', openai: 'OpenAI', dashscope: 'DashScope', minimax: 'MiniMax' };
const paramText = (p: Readonly<Record<string, string>>) => Object.values(p).join(' · ');

export function ModelsPage() {
  const { id = '' } = useParams();
  const v = useApi<ModelsView>(projectPath(id, '/models'));
  const [toast, notify] = useToast();
  const post = async (path: string, body: unknown, msg: string) => {
    try {
      await api.post(path, body);
      notify(msg);
      v.reload();
    } catch (e) {
      notify((e as ApiError).message, 'err');
    }
  };
  if (v.error) return <ErrorView error={v.error} onRetry={v.reload} />;
  if (!v.data) return <Loading what="读取模型与预设（要估一遍费用）" />;
  const data = v.data;
  const current = data.presets.find((p) => p.current);
  const missing = data.credentials.filter((c) => !c.masked);
  return (
    <>
      <PageHead
        title="模型与预设"
        sub="每个节点单独选模型；预设是一组默认选择，项目里可以逐个覆盖"
        actions={
          <Button onClick={() => void post('/api/prices/refresh', {}, '已从 OpenRouter 拉取文本模型价格（转售价，未核对官方）')}>
            <RefreshCw size={14} /> 重新拉取价格
          </Button>
        }
      />
      <div className={s.presets}>
        {data.presets.map((p) => (
          <button key={p.name} type="button" className={`${s.preset} ${p.current ? s.presetOn : ''}`} onClick={() => !p.current && void post(projectPath(id, '/models'), { action: 'preset', preset: p.name }, `已切换到「${p.title}」`)}>
            <header>
              <b>{p.title}</b>
              {p.current ? <Badge tone="run" plain>本项目在用</Badge> : <span style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 600 }}>切换到这套</span>}
            </header>
            <p>{p.description}</p>
            <small>
              约 {yuanRange(p.total, 0)}
              {p.incomplete ? '（有节点无价格，不完整）' : ''}
            </small>
          </button>
        ))}
      </div>
      <div className={s.body}>
        <section className={`${cardClass} ${s.tableCard}`}>
          <div className={s.tableTitle}>
            <b>《{data.project.name}》的节点模型</b>
            <span>
              基于「{current?.title}」 · 覆盖 {data.nodes.filter((n) => n.overridden).length} 项
            </span>
            <em>{data.fx ? `价格仅供参考 · 1 USD ≈ ${data.fx.usdToCny} CNY` : (data.estimateError ?? '')}</em>
          </div>
          <table className={s.table}>
            <thead>
              <tr>
                <th>节点</th>
                <th>当前模型</th>
                <th>其他预设</th>
                <th>本项目估算</th>
              </tr>
            </thead>
            <tbody>
              {data.nodes.map((n) => {
                const [title, note] = NODE_TITLES[n.node] ?? [n.node, ''];
                const options = data.models.filter((m) => m.capability === n.capability);
                return (
                  <tr key={n.node}>
                    <td>
                      {title}
                      <small>{note}</small>
                    </td>
                    <td>
                      <span className={`${s.select} ${n.overridden ? s.selectOver : ''}`}>
                        <select
                          aria-label={`${title}的模型`}
                          value={n.model}
                          onChange={(e) => void post(projectPath(id, '/models'), { action: 'set', node: n.node, model: e.target.value }, `${title}改用 ${e.target.value}`)}
                        >
                          {options.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.id.split(':')[1]}
                            </option>
                          ))}
                        </select>
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{paramText(n.params)}</span>
                        {n.overridden ? (
                          <button type="button" title="撤销覆盖，回到预设" style={{ border: 0, background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 4, fontSize: 11, cursor: 'pointer' }} onClick={() => void post(projectPath(id, '/models'), { action: 'clear', node: n.node }, `${title}回到预设`)}>
                            已覆盖 ×
                          </button>
                        ) : null}
                      </span>
                    </td>
                    <td className={s.mono} style={{ color: 'var(--text-3)' }}>
                      {n.others.map((o) => `${o.model?.split(':')[1] ?? '—'}${paramText(o.params) ? ` · ${paramText(o.params)}` : ''}`).join(' / ')}
                    </td>
                    <td className={s.mono}>{n.estimate ? yuanRange(n.estimate) : '无价格'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className={s.foot}>
            {data.presets.map((p) => (
              <span key={p.name}>
                {p.current ? '当前合计' : `全用${p.title}`} <b>{yuanRange(p.total, 0)}</b>
              </span>
            ))}
            <span style={{ marginLeft: 'auto' }}>切换预设只影响还没生成的节点</span>
          </div>
        </section>
        <aside className={`${cardClass} ${s.side}`}>
          <h2>供应商与凭据</h2>
          <p>凭据只保存在本机配置目录，不进项目文件；页面上只显示是否配置与末 4 位。设置用命令行 cred set &lt;供应商&gt;（从标准输入读）。</p>
          {data.credentials.map((c) => (
            <div key={c.provider} className={`${s.cred} ${c.masked ? '' : s.credOff}`}>
              <Dot tone={c.masked ? 'ok' : 'idle'} />
              <div>
                <b>{PROVIDERS[c.provider] ?? c.provider}</b>
                <small>{c.masked ? `API key ${c.masked}（${c.source}）` : '未配置'}</small>
              </div>
            </div>
          ))}
          {missing.length ? (
            <div className={s.note}>
              <TriangleAlert size={14} color="var(--warn)" style={{ flex: 'none' }} />
              {missing.map((c) => PROVIDERS[c.provider]).join('、')} 还没有配置凭据：用到它们的节点现在无法运行。
            </div>
          ) : null}
        </aside>
      </div>
      {toast}
    </>
  );
}

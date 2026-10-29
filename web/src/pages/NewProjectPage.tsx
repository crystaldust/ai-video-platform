// 新建项目：贴梗概或小说正文、定参数与预设 → 一键跑完文本阶段（建好就开跑，跳到全貌看进度）。
import { Package, Play } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, useApi } from '../api.ts';
import { Button, ErrorView } from '../components/ui.tsx';
import type { AppConfigView } from '../types.ts';
import s from './NewProjectPage.module.css';

type Tab = 'synopsis' | 'novel' | 'import';
const EPISODES = [1, 3, 6, 8, 10, 12, 20, 30];
const SECONDS = [30, 45, 60, 90, 120];

export function NewProjectPage() {
  const config = useApi<AppConfigView>('/api/config');
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('synopsis');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [episodes, setEpisodes] = useState(6);
  const [seconds, setSeconds] = useState(60);
  const [aspect, setAspect] = useState<'9:16' | '16:9'>('9:16');
  const [genre, setGenre] = useState('');
  const [preset, setPreset] = useState('budget');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const ready = name.trim() && text.trim() && genre.trim() && !busy && config.data?.canCreate;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: string }>('/api/projects', { name: name.trim(), kind: tab === 'novel' ? 'novel' : 'synopsis', text, params: { episodes, seconds, genre: genre.trim(), aspect }, preset, start: true });
      navigate(`/p/${encodeURIComponent(r.id)}`);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
      setBusy(false);
    }
  };

  const pack = config.data?.pack;
  return (
    <div className={s.wrap}>
      <h1 className={s.title}>从一个梗概开始</h1>
      <p className={s.lead}>贴入梗概或小说正文。平台会一口气跑完大纲、角色、美术、剧本、站位、分镜，然后停在付费生成之前，等你在全貌上审阅。</p>
      <div className={s.tabs} role="tablist">
        {(
          [
            ['synopsis', '梗概'],
            ['novel', '小说正文'],
            ['import', '导入现有 JSON'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={s.tab} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'import' ? (
        <div className={s.importNote}>
          已经用 skill 链产出了 JSON：先建一个项目（梗概可以简写），然后用命令行逐份导入——
          <br />
          <code>node src/cli.ts import &lt;项目目录&gt; outline 渡口-outline.json</code>
          <br />
          按 outline → cast → art → script → staging → storyboard 的顺序导入，全貌页会直接显示导入的产物。
        </div>
      ) : (
        <>
          <div className={s.nameRow}>
            <input className={s.input} aria-label="项目名" placeholder="项目名（也是项目目录名），如：渡口" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className={s.text}>
            <textarea aria-label={tab === 'novel' ? '小说正文' : '梗概'} placeholder={tab === 'novel' ? '贴入小说正文：角色卡的引文会逐字对照它' : '民国年间，一条无名河上的老渡船……'} value={text} onChange={(e) => setText(e.target.value)} />
            <span className={s.count}>{text.trim().length} 字</span>
          </div>
          <div className={s.params}>
            <label>
              集数
              <select value={episodes} onChange={(e) => setEpisodes(Number(e.target.value))}>
                {EPISODES.map((n) => (
                  <option key={n} value={n}>
                    {n} 集
                  </option>
                ))}
              </select>
            </label>
            <label>
              每集时长
              <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
                {SECONDS.map((n) => (
                  <option key={n} value={n}>
                    {n} 秒
                  </option>
                ))}
              </select>
            </label>
            <label>
              画幅
              <select value={aspect} onChange={(e) => setAspect(e.target.value as '9:16' | '16:9')}>
                <option value="9:16">竖屏 9:16</option>
                <option value="16:9">横屏 16:9</option>
              </select>
            </label>
            <label>
              题材
              <input value={genre} placeholder="如：民国悬疑" onChange={(e) => setGenre(e.target.value)} />
            </label>
            <label>
              模型预设
              <select value={preset} onChange={(e) => setPreset(e.target.value)}>
                {(config.data?.presets ?? []).map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={s.pack}>
            <Package size={18} color="var(--text-2)" />
            <div>
              <b>Skill 包：{pack?.name ?? '—'}</b>
              <small>{pack ? `${pack.stages.join(' · ')}，每个阶段一套` : '读不到 skill 包清单'}</small>
            </div>
          </div>
          <div className={s.go}>
            <Button variant="primary" className={s.goBtn} disabled={!ready} onClick={() => void submit()}>
              <Play size={15} /> {busy ? '正在创建…' : '一键跑完文本阶段'}
            </Button>
            <div className={s.goHint}>
              {config.data && !config.data.canCreate ? '服务启动时没有给 --skills，不能新建项目' : '项目名、正文、题材都填了就能开始'}
              <small>图片和视频不会自动生成，费用确认前一分钱不花</small>
            </div>
          </div>
          {error ? <ErrorView error={error} /> : null}
        </>
      )}
      <div className={s.stepsTitle}>点了之后会发生什么</div>
      <div className={s.steps}>
        {[
          ['自动跑完文本阶段', '每个阶段都要过质量门；没过就带着错误重试，最多 3 次，仍不过就停下来交给你。'],
          ['在全貌上审阅', '逐集看产物和质量门；哪项不满意就附意见打回，下游自动标为需复核。'],
          ['确认费用再生成', '图片和视频按集勾选，先给估算区间；超过单次上限自动暂停。'],
        ].map(([t, d], i) => (
          <div key={t} className={s.step}>
            <b>
              <span>{i + 1}</span>
              {t}
            </b>
            <p>{d}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

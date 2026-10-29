// 项目列表：项目根目录下的每个项目一行——三段进度（文本 / 付费生成 / 剪辑）、一句话现状、文本花费。
import { ChevronRight, FolderOpen, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { useApi } from '../api.ts';
import { Button, Dot, Empty, ErrorView, Loading, PageHead, type Tone } from '../components/ui.tsx';
import { aspectLabel, joinDot, when, yuan } from '../format.ts';
import type { AppConfigView, ProjectSummary } from '../types.ts';
import s from './ProjectsPage.module.css';

const TONE: Record<string, Tone> = { running: 'run', err: 'err', warn: 'warn', ok: 'ok', idle: 'idle' };
const TONE_COLOR: Record<Tone, string> = { ok: 'var(--ok)', warn: 'var(--warn)', err: 'var(--err)', run: 'var(--accent)', idle: 'var(--text-3)' };
const PHASE_BG: Record<Tone, [string, string]> = {
  ok: ['var(--ok-soft)', 'var(--ok)'],
  warn: ['var(--warn-soft)', 'var(--warn)'],
  err: ['var(--err-soft)', 'var(--err)'],
  run: ['var(--accent-soft)', 'var(--accent)'],
  idle: ['var(--lock-soft)', 'var(--text-3)'],
};

function ProjectRow({ p, presets }: { p: Extract<ProjectSummary, { status: 'ok' }>; presets: AppConfigView['presets'] }) {
  const tone = TONE[p.headline.tone] ?? 'idle';
  const params = p.head.params;
  const preset = presets.find((x) => x.name === p.head.preset)?.title ?? p.head.preset;
  const [bg, fg] = PHASE_BG[p.text.passed === p.text.total && tone !== 'err' ? 'ok' : tone];
  return (
    <Link to={`/p/${encodeURIComponent(p.id)}`} className={s.row}>
      <div>
        <div className={s.titleLine}>
          <span className={s.name}>《{p.head.name}》</span>
          <span className={s.meta}>{joinDot(params && `${params.episodes} 集`, aspectLabel(params?.aspect), preset)}</span>
        </div>
        <div className={s.headline} style={{ color: TONE_COLOR[tone] }}>
          <Dot tone={tone} />
          {p.headline.text}
        </div>
        <div className={s.path}>{p.dir}</div>
      </div>
      <div className={s.phases}>
        <span className={s.phase} style={{ background: bg, color: fg }}>
          <small>文本</small>
          <b>
            {p.text.passed}/{p.text.total}
          </b>
        </span>
        <span className={s.phase}>
          <small>付费生成</small>
          <b>未开始</b>
        </span>
        <span className={s.phase}>
          <small>剪辑</small>
          <b>—</b>
        </span>
      </div>
      <div className={s.cost}>
        花费 {yuan(p.cost.cny)}
        <small>{when(p.updatedAt)}</small>
      </div>
      <ChevronRight size={16} className={s.chev} />
    </Link>
  );
}

export function ProjectsPage() {
  const list = useApi<ProjectSummary[]>('/api/projects');
  const config = useApi<AppConfigView>('/api/config');
  const navigate = useNavigate();
  const canCreate = config.data?.canCreate ?? false;
  return (
    <>
      <PageHead
        title="项目"
        sub="每个项目是本机上的一个目录，数据存在其中的 project.sqlite"
        actions={
          <Button variant="primary" onClick={() => navigate('/new')} disabled={!canCreate} title={canCreate ? undefined : '启动服务时没有给 --skills，不能新建'}>
            <Plus size={14} /> 新建项目
          </Button>
        }
      />
      {list.error ? <ErrorView error={list.error} onRetry={list.reload} /> : null}
      {!list.data && list.loading ? <Loading what="读取项目" /> : null}
      {list.data ? (
        <div className={s.list}>
          {list.data.length === 0 ? (
            <Empty title="还没有项目">
              项目目录 <span className="mono">{config.data?.projectsRoot}</span> 下还没有项目。点「新建项目」从一个梗概开始。
            </Empty>
          ) : null}
          {list.data.map((p) =>
            p.status === 'ok' ? (
              <ProjectRow key={p.id} p={p} presets={config.data?.presets ?? []} />
            ) : (
              <div key={p.id} className={s.row}>
                <div>
                  <span className={s.name}>{p.id}</span>
                  <div className={`${s.headline} ${s.broken}`}>
                    <Dot tone="err" />
                    {p.status === 'needs_upgrade' ? '需要升级平台才能打开' : '打不开'}：{p.message}
                  </div>
                  <div className={s.path}>{p.dir}</div>
                </div>
              </div>
            ),
          )}
          <div className={s.open}>
            <FolderOpen size={16} />
            <b>项目目录</b>
            <span className={`mono ${s.openPath}`}>{config.data?.projectsRoot}</span>
            <span>也可以把 skill 链已经产出的 JSON 用命令行 import 导入到项目里</span>
          </div>
        </div>
      ) : null}
    </>
  );
}

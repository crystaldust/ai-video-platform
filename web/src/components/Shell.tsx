// 页面框架：左侧导航 + 右侧内容。进了项目后导航换成项目内的页面，侧栏显示当前项目。
import { Boxes, Film, Folder, Image, LayoutDashboard, ListChecks, Package, Scissors, SlidersHorizontal, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useParams } from 'react-router';
import { projectPath, useApi } from '../api.ts';
import { aspectLabel, joinDot } from '../format.ts';
import type { JobInfo, ProjectHead } from '../types.ts';
import s from './Shell.module.css';

interface Item {
  readonly to: string | null;
  readonly label: string;
  readonly icon: ReactNode;
  readonly end?: boolean;
  /** 还没做的页面：显示但不能点 */
  readonly soon?: string;
}

const ICON = { size: 16, strokeWidth: 1.8 };

function NavItem({ item }: { item: Item }) {
  if (!item.to) {
    return (
      <span className={`${s.nav} ${s.disabled}`} aria-disabled title={item.soon}>
        {item.icon}
        {item.label}
        <span className={s.soon}>{item.soon}</span>
      </span>
    );
  }
  return (
    <NavLink to={item.to} end={item.end ?? false} className={({ isActive }) => `${s.nav} ${isActive ? s.active : ''}`}>
      {item.icon}
      {item.label}
    </NavLink>
  );
}

function Brand() {
  return (
    <NavLink to="/" className={s.brand}>
      <span className={s.mark} aria-hidden />
      短剧工坊
    </NavLink>
  );
}

/** 项目列表、新建项目用的框架。 */
export function HomeShell() {
  const items: Item[] = [
    { to: '/', label: '项目', icon: <Folder {...ICON} />, end: true },
    { to: null, label: '模型与预设', icon: <SlidersHorizontal {...ICON} />, soon: '进项目后设置' },
    { to: null, label: 'Skill 包', icon: <Boxes {...ICON} />, soon: '进项目后设置' },
  ];
  return (
    <div className={s.shell}>
      <aside className={s.side}>
        <Brand />
        {items.map((i) => (
          <NavItem key={i.label} item={i} />
        ))}
      </aside>
      <main className={s.main}>
        <Outlet />
      </main>
    </div>
  );
}

/** 项目内的框架：侧栏带项目名与参数。 */
export function ProjectShell() {
  const { id = '' } = useParams();
  const head = useApi<ProjectHead & { job: JobInfo | null }>(projectPath(id, '/head'));
  const base = `/p/${encodeURIComponent(id)}`;
  const items: Item[] = [
    { to: base, label: '全貌', icon: <LayoutDashboard {...ICON} />, end: true },
    { to: `${base}/episodes`, label: '剧集与分镜', icon: <Film {...ICON} /> },
    { to: `${base}/cast`, label: '角色与美术', icon: <Users {...ICON} /> },
    { to: null, label: '素材与候选', icon: <Image {...ICON} />, soon: 'Phase 6' },
    { to: null, label: '生成任务', icon: <ListChecks {...ICON} />, soon: 'Phase 5' },
    { to: null, label: '剪辑', icon: <Scissors {...ICON} />, soon: 'Phase 7' },
    { to: `${base}/models`, label: '模型与预设', icon: <SlidersHorizontal {...ICON} /> },
    { to: `${base}/skills`, label: 'Skill 包', icon: <Package {...ICON} /> },
  ];
  const p = head.data?.params;
  return (
    <div className={s.shell}>
      <aside className={s.side}>
        <Brand />
        <div className={s.project}>
          <span className={s.projectLabel}>当前项目</span>
          <span className={s.projectName}>《{head.data?.name ?? id}》</span>
          <span className={s.projectMeta}>{p ? joinDot(`${p.episodes} 集`, aspectLabel(p.aspect), `每集 ${p.seconds} 秒`) : head.error ? '打不开' : ' '}</span>
        </div>
        {items.map((i) => (
          <NavItem key={i.label} item={i} />
        ))}
      </aside>
      <main className={s.main}>
        <Outlet />
      </main>
    </div>
  );
}

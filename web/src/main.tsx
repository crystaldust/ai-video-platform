// 前端入口：路由。项目内页面共用 ProjectShell（侧栏带当前项目）。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { HomeShell, ProjectShell } from './components/Shell.tsx';
import './global.css';
import { CastPage } from './pages/CastPage.tsx';
import { EpisodePage, EpisodesIndex } from './pages/EpisodePage.tsx';
import { ModelsPage } from './pages/ModelsPage.tsx';
import { NewProjectPage } from './pages/NewProjectPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { SkillsPage } from './pages/SkillsPage.tsx';

const router = createBrowserRouter([
  {
    element: <HomeShell />,
    children: [
      { path: '/', element: <ProjectsPage /> },
      { path: '/new', element: <NewProjectPage /> },
    ],
  },
  {
    path: '/p/:id',
    element: <ProjectShell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'episodes', element: <EpisodesIndex /> },
      { path: 'ep/:ep', element: <EpisodePage /> },
      { path: 'cast', element: <CastPage /> },
      { path: 'models', element: <ModelsPage /> },
      { path: 'skills', element: <SkillsPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

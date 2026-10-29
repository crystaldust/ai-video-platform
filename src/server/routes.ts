// 路由表：各分组汇总。
import { ACTION_ROUTES } from './routes/actions.ts';
import { PROJECT_ROUTES } from './routes/projects.ts';
import { VIEW_ROUTES } from './routes/views.ts';
import type { Route } from './route.ts';

export type { Route, RouteCtx } from './route.ts';

export const ROUTES: readonly Route[] = [...PROJECT_ROUTES, ...VIEW_ROUTES, ...ACTION_ROUTES];

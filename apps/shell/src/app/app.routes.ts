import { NxWelcome } from './nx-welcome';
import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: 'page2',
    loadChildren: () => import('page2/Routes').then((m) => m!.remoteRoutes),
  },
  {
    path: 'weather-app',
    loadChildren: () => import('weather-app/Routes').then((m) => m!.remoteRoutes),
  },
  {
    path: '',
    component: NxWelcome,
  },
];

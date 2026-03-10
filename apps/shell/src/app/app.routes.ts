import { NxWelcome } from './nx-welcome';
import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: 'weatheredit-app',
    loadChildren: () => import('weatheredit-app/Routes').then((m) => m!.remoteRoutes),
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

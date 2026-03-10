import { NxWelcome } from './nx-welcome';
import { Route } from '@angular/router';
import { weatherEditAuthGuard } from './auth/auth.guard';
import { LoginComponent } from './auth/login/login.component';
import { UnauthorizedComponent } from './auth/unauthorized/unauthorized.component';

export const appRoutes: Route[] = [
  {
    path: 'weatheredit-app',
    canActivate: [weatherEditAuthGuard],
    loadChildren: () => import('weatheredit-app/Routes').then((m) => m!.remoteRoutes),
  },
  {
    path: 'weather-app',
    loadChildren: () => import('weather-app/Routes').then((m) => m!.remoteRoutes),
  },
  {
    path: 'auth/login',
    component: LoginComponent,
  },
  {
    path: 'auth/unauthorized',
    component: UnauthorizedComponent,
  },
  {
    path: '',
    component: NxWelcome,
  },
];

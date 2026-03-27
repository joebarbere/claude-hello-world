import { Route } from '@angular/router';
import { weatherEditAuthGuard, adminAuthGuard } from './auth/auth.guard';
import { LoginComponent } from './auth/login/login.component';
import { RecoveryComponent } from './auth/recovery/recovery.component';
import { SignupComponent } from './auth/signup/signup.component';
import { UnauthorizedComponent } from './auth/unauthorized/unauthorized.component';
import { HomeComponent } from './home/home.component';

export const appRoutes: Route[] = [
  {
    path: 'admin-app',
    canActivate: [adminAuthGuard],
    loadChildren: () => import('admin-app/Routes').then((m) => m!.remoteRoutes),
  },
  {
    path: 'weatheredit-app',
    canActivate: [weatherEditAuthGuard],
    loadChildren: () =>
      import('weatheredit-app/Routes').then((m) => m!.remoteRoutes),
  },
  {
    path: 'weather-app',
    loadChildren: () =>
      import('weather-app/Routes').then((m) => m!.remoteRoutes),
  },
  {
    path: 'auth/login',
    component: LoginComponent,
  },
  {
    path: 'auth/signup',
    component: SignupComponent,
  },
  {
    path: 'auth/recovery',
    component: RecoveryComponent,
  },
  {
    path: 'auth/settings',
    component: RecoveryComponent,
  },
  {
    path: 'auth/unauthorized',
    component: UnauthorizedComponent,
  },
  {
    path: 'auth/error',
    component: LoginComponent,
  },
  {
    path: '',
    component: HomeComponent,
  },
];

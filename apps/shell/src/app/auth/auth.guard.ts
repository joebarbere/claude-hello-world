import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs/operators';
import { AuthService } from './auth.service';

export const weatherEditAuthGuard: CanActivateFn = (_route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.getSession().pipe(
    map((session) => {
      if (!session) {
        authService.initiateLogin(state.url);
        return false;
      }
      if (!authService.canAccessWeatherEdit(session)) {
        return router.createUrlTree(['/auth/unauthorized']);
      }
      return true;
    })
  );
};

export const adminAuthGuard: CanActivateFn = (_route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.getSession().pipe(
    map((session) => {
      if (!session) {
        authService.initiateLogin(state.url);
        return false;
      }
      if (!authService.canAccessAdmin(session)) {
        return router.createUrlTree(['/auth/unauthorized']);
      }
      return true;
    })
  );
};

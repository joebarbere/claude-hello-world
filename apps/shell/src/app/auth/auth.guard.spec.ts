import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { of } from 'rxjs';
import { weatherEditAuthGuard, adminAuthGuard } from './auth.guard';
import { AuthService, KratosSession } from './auth.service';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';

function makeSession(role?: string): KratosSession {
  return {
    id: 'test-session',
    active: true,
    identity: {
      id: 'test-identity',
      traits: { email: 'test@example.com', role },
    },
  };
}

describe('adminAuthGuard', () => {
  let authService: AuthService;
  let router: Router;

  beforeEach(async () => {
    await resolveComponentResources(() =>
      Promise.resolve({ text: () => Promise.resolve('') } as Response)
    );
    await TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: {
            getSession: vi.fn(),
            canAccessAdmin: vi.fn(),
            initiateLogin: vi.fn(),
          },
        },
        {
          provide: Router,
          useValue: {
            createUrlTree: vi.fn().mockReturnValue('unauthorized-tree' as unknown as UrlTree),
          },
        },
      ],
    }).compileComponents();

    authService = TestBed.inject(AuthService);
    router = TestBed.inject(Router);
  });

  it('should redirect to login when no session', () => {
    vi.mocked(authService.getSession).mockReturnValue(of(null));

    const result$ = TestBed.runInInjectionContext(() =>
      adminAuthGuard({} as any, { url: '/admin-app' } as any)
    );

    (result$ as any).subscribe((result: boolean | UrlTree) => {
      expect(result).toBe(false);
      expect(authService.initiateLogin).toHaveBeenCalledWith('/admin-app');
    });
  });

  it('should redirect to unauthorized when role is not admin', () => {
    const session = makeSession('weather_admin');
    vi.mocked(authService.getSession).mockReturnValue(of(session));
    vi.mocked(authService.canAccessAdmin).mockReturnValue(false);

    const result$ = TestBed.runInInjectionContext(() =>
      adminAuthGuard({} as any, { url: '/admin-app' } as any)
    );

    (result$ as any).subscribe((result: boolean | UrlTree) => {
      expect(result).toBe('unauthorized-tree');
      expect(router.createUrlTree).toHaveBeenCalledWith(['/auth/unauthorized']);
    });
  });

  it('should allow access when role is admin', () => {
    const session = makeSession('admin');
    vi.mocked(authService.getSession).mockReturnValue(of(session));
    vi.mocked(authService.canAccessAdmin).mockReturnValue(true);

    const result$ = TestBed.runInInjectionContext(() =>
      adminAuthGuard({} as any, { url: '/admin-app' } as any)
    );

    (result$ as any).subscribe((result: boolean | UrlTree) => {
      expect(result).toBe(true);
    });
  });
});

describe('weatherEditAuthGuard', () => {
  let authService: AuthService;
  let router: Router;

  beforeEach(async () => {
    await resolveComponentResources(() =>
      Promise.resolve({ text: () => Promise.resolve('') } as Response)
    );
    await TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: {
            getSession: vi.fn(),
            canAccessWeatherEdit: vi.fn(),
            initiateLogin: vi.fn(),
          },
        },
        {
          provide: Router,
          useValue: {
            createUrlTree: vi.fn().mockReturnValue('unauthorized-tree' as unknown as UrlTree),
          },
        },
      ],
    }).compileComponents();

    authService = TestBed.inject(AuthService);
    router = TestBed.inject(Router);
  });

  it('should redirect to login when no session', () => {
    vi.mocked(authService.getSession).mockReturnValue(of(null));

    const result$ = TestBed.runInInjectionContext(() =>
      weatherEditAuthGuard({} as any, { url: '/weatheredit-app' } as any)
    );

    (result$ as any).subscribe((result: boolean | UrlTree) => {
      expect(result).toBe(false);
      expect(authService.initiateLogin).toHaveBeenCalledWith('/weatheredit-app');
    });
  });

  it('should redirect to unauthorized when role is not allowed', () => {
    const session = makeSession('viewer');
    vi.mocked(authService.getSession).mockReturnValue(of(session));
    vi.mocked(authService.canAccessWeatherEdit).mockReturnValue(false);

    const result$ = TestBed.runInInjectionContext(() =>
      weatherEditAuthGuard({} as any, { url: '/weatheredit-app' } as any)
    );

    (result$ as any).subscribe((result: boolean | UrlTree) => {
      expect(result).toBe('unauthorized-tree');
      expect(router.createUrlTree).toHaveBeenCalledWith(['/auth/unauthorized']);
    });
  });

  it('should allow access when role is weather_admin', () => {
    const session = makeSession('weather_admin');
    vi.mocked(authService.getSession).mockReturnValue(of(session));
    vi.mocked(authService.canAccessWeatherEdit).mockReturnValue(true);

    const result$ = TestBed.runInInjectionContext(() =>
      weatherEditAuthGuard({} as any, { url: '/weatheredit-app' } as any)
    );

    (result$ as any).subscribe((result: boolean | UrlTree) => {
      expect(result).toBe(true);
    });
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { AuthService, KratosSession } from './auth.service';

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

describe('AuthService', () => {
  let service: AuthService;
  let httpTesting: HttpTestingController;

  beforeEach(async () => {
    await resolveComponentResources(() =>
      Promise.resolve({ text: () => Promise.resolve('') } as Response)
    );
    await TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    service = TestBed.inject(AuthService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  describe('canAccessWeatherEdit', () => {
    it('should return true for admin role', () => {
      expect(service.canAccessWeatherEdit(makeSession('admin'))).toBe(true);
    });

    it('should return true for weather_admin role', () => {
      expect(service.canAccessWeatherEdit(makeSession('weather_admin'))).toBe(true);
    });

    it('should return false for no role', () => {
      expect(service.canAccessWeatherEdit(makeSession())).toBe(false);
    });

    it('should return false for null session', () => {
      expect(service.canAccessWeatherEdit(null)).toBe(false);
    });

    it('should return false for inactive session', () => {
      const session = makeSession('admin');
      session.active = false;
      expect(service.canAccessWeatherEdit(session)).toBe(false);
    });
  });

  describe('canAccessAdmin', () => {
    it('should return true for admin role', () => {
      expect(service.canAccessAdmin(makeSession('admin'))).toBe(true);
    });

    it('should return false for weather_admin role', () => {
      expect(service.canAccessAdmin(makeSession('weather_admin'))).toBe(false);
    });

    it('should return false for no role', () => {
      expect(service.canAccessAdmin(makeSession())).toBe(false);
    });

    it('should return false for null session', () => {
      expect(service.canAccessAdmin(null)).toBe(false);
    });

    it('should return false for inactive session', () => {
      const session = makeSession('admin');
      session.active = false;
      expect(service.canAccessAdmin(session)).toBe(false);
    });

    it('should return false for unknown role', () => {
      expect(service.canAccessAdmin(makeSession('viewer'))).toBe(false);
    });
  });

  describe('getSession', () => {
    it('should call whoami endpoint and return session', () => {
      const session = makeSession('admin');

      service.getSession().subscribe((result) => {
        expect(result).toEqual(session);
      });

      const req = httpTesting.expectOne('/.ory/kratos/public/sessions/whoami');
      expect(req.request.withCredentials).toBe(true);
      req.flush(session);
    });

    it('should return null on error', () => {
      service.getSession().subscribe((result) => {
        expect(result).toBeNull();
      });

      const req = httpTesting.expectOne('/.ory/kratos/public/sessions/whoami');
      req.flush(null, { status: 401, statusText: 'Unauthorized' });
    });
  });

  describe('initiateLogin', () => {
    it('should redirect to kratos login with return_to', () => {
      const hrefSetter = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { href: '' },
        writable: true,
        configurable: true,
      });

      service.initiateLogin('/weatheredit-app');

      expect(window.location.href).toBe(
        '/.ory/kratos/public/self-service/login/browser?return_to=%2Fweatheredit-app'
      );
    });
  });

  describe('logout', () => {
    it('should fetch logout flow and redirect to logout_url', () => {
      const logoutUrl = 'https://example.com/logout';
      Object.defineProperty(window, 'location', {
        value: { href: '' },
        writable: true,
        configurable: true,
      });

      service.logout();

      const req = httpTesting.expectOne('/.ory/kratos/public/self-service/logout/browser');
      expect(req.request.withCredentials).toBe(true);
      req.flush({ logout_url: logoutUrl });

      expect(window.location.href).toBe(logoutUrl);
    });

    it('should not redirect when logout flow fails', () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'original' },
        writable: true,
        configurable: true,
      });

      service.logout();

      const req = httpTesting.expectOne('/.ory/kratos/public/self-service/logout/browser');
      req.flush(null, { status: 500, statusText: 'Server Error' });

      expect(window.location.href).toBe('original');
    });
  });

  describe('getLoginFlow', () => {
    it('should fetch login flow by id', () => {
      const flow = { id: 'flow-123', ui: { action: '/login', method: 'POST', nodes: [] } };

      service.getLoginFlow('flow-123').subscribe((result) => {
        expect(result).toEqual(flow);
      });

      const req = httpTesting.expectOne(
        '/.ory/kratos/public/self-service/login/flows?id=flow-123'
      );
      expect(req.request.withCredentials).toBe(true);
      req.flush(flow);
    });

    it('should return null on error', () => {
      service.getLoginFlow('bad-id').subscribe((result) => {
        expect(result).toBeNull();
      });

      const req = httpTesting.expectOne(
        '/.ory/kratos/public/self-service/login/flows?id=bad-id'
      );
      req.flush(null, { status: 404, statusText: 'Not Found' });
    });
  });
});

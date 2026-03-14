import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
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

  beforeEach(async () => {
    await resolveComponentResources(() =>
      Promise.resolve({ text: () => Promise.resolve('') } as Response)
    );
    await TestBed.configureTestingModule({
      providers: [provideHttpClient()],
    }).compileComponents();

    service = TestBed.inject(AuthService);
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
});

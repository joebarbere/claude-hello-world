import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { KratosAdminService, KratosIdentity } from './kratos-admin.service';

const ADMIN_URL = '/.ory/kratos/admin';

function makeIdentity(overrides?: Partial<KratosIdentity>): KratosIdentity {
  return {
    id: 'id-1',
    schema_id: 'default',
    traits: { email: 'test@example.com', role: 'admin' },
    state: 'active',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('KratosAdminService', () => {
  let service: KratosAdminService;
  let httpTesting: HttpTestingController;

  beforeEach(async () => {
    await resolveComponentResources(() =>
      Promise.resolve({ text: () => Promise.resolve('') } as Response)
    );
    await TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    service = TestBed.inject(KratosAdminService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  it('should list identities', () => {
    const identities = [makeIdentity()];
    service.listIdentities().subscribe((result) => {
      expect(result).toEqual(identities);
    });
    const req = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    expect(req.request.method).toBe('GET');
    req.flush(identities);
  });

  it('should get identity by id', () => {
    const identity = makeIdentity();
    service.getIdentity('id-1').subscribe((result) => {
      expect(result).toEqual(identity);
    });
    const req = httpTesting.expectOne(`${ADMIN_URL}/admin/identities/id-1`);
    expect(req.request.method).toBe('GET');
    req.flush(identity);
  });

  it('should create identity', () => {
    const created = makeIdentity({ id: 'id-new' });
    const payload = {
      schema_id: 'default',
      traits: { email: 'new@example.com', role: 'admin' },
      credentials: { password: { config: { password: 'pass' } } },
    };
    service.createIdentity(payload).subscribe((result) => {
      expect(result).toEqual(created);
    });
    const req = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(payload);
    req.flush(created);
  });

  it('should update identity traits', () => {
    const updated = makeIdentity({ traits: { email: 'test@example.com', role: 'weather_admin' } });
    service.updateIdentityTraits('id-1', { email: 'test@example.com', role: 'weather_admin' }).subscribe((result) => {
      expect(result).toEqual(updated);
    });
    const req = httpTesting.expectOne(`${ADMIN_URL}/admin/identities/id-1`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({
      schema_id: 'default',
      traits: { email: 'test@example.com', role: 'weather_admin' },
      state: 'active',
    });
    req.flush(updated);
  });

  it('should delete identity', () => {
    service.deleteIdentity('id-1').subscribe();
    const req = httpTesting.expectOne(`${ADMIN_URL}/admin/identities/id-1`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('should check health', () => {
    service.checkHealth().subscribe((result) => {
      expect(result).toEqual({ status: 'ok' });
    });
    const req = httpTesting.expectOne(`${ADMIN_URL}/health/alive`);
    expect(req.request.method).toBe('GET');
    req.flush({ status: 'ok' });
  });
});

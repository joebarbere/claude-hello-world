import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { KratosAdminComponent } from './kratos-admin.component';
import { KratosIdentity } from './kratos-admin.service';

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

describe('KratosAdminComponent', () => {
  let httpTesting: HttpTestingController;

  beforeEach(async () => {
    await resolveComponentResources(() =>
      Promise.resolve({ text: () => Promise.resolve('') } as Response)
    );
    await TestBed.configureTestingModule({
      imports: [KratosAdminComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    httpTesting = TestBed.inject(HttpTestingController);
  });

  function createComponent() {
    const fixture = TestBed.createComponent(KratosAdminComponent);
    const component = fixture.componentInstance;
    // ngOnInit fires health check + listIdentities
    fixture.detectChanges();
    return { fixture, component };
  }

  function flushInit(identities: KratosIdentity[] = [makeIdentity()]) {
    // Health check
    const healthReq = httpTesting.expectOne(`${ADMIN_URL}/health/alive`);
    healthReq.flush({ status: 'ok' });
    // List identities
    const listReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    listReq.flush(identities);
  }

  it('should create the component', () => {
    const { component } = createComponent();
    flushInit();
    expect(component).toBeTruthy();
  });

  it('should load identities on init', () => {
    const { component } = createComponent();
    const identities = [makeIdentity(), makeIdentity({ id: 'id-2', traits: { email: 'b@b.com' } })];
    flushInit(identities);
    expect(component.identities()).toEqual(identities);
    expect(component.loading()).toBe(false);
  });

  it('should set health status on init', () => {
    const { component } = createComponent();
    flushInit();
    expect(component.healthState()).toBe('up');
    expect(component.healthLabel()).toBe('Healthy');
  });

  it('should set health status to down on error', () => {
    const { component } = createComponent();
    const healthReq = httpTesting.expectOne(`${ADMIN_URL}/health/alive`);
    healthReq.flush(null, { status: 503, statusText: 'Unavailable' });
    const listReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    listReq.flush([]);
    expect(component.healthState()).toBe('down');
    expect(component.healthLabel()).toBe('Down');
  });

  it('should handle load error', () => {
    const { component } = createComponent();
    const healthReq = httpTesting.expectOne(`${ADMIN_URL}/health/alive`);
    healthReq.flush({ status: 'ok' });
    const listReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    listReq.flush(null, { status: 500, statusText: 'Server Error' });
    expect(component.loadError()).toContain('Failed to load identities');
    expect(component.loading()).toBe(false);
  });

  it('should create identity and reload', () => {
    const { component, fixture } = createComponent();
    flushInit();

    component.newEmail = 'new@example.com';
    component.newPassword = 'Pass1234!';
    component.newRole = 'weather_admin';
    component.createIdentity();

    const createReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    expect(createReq.request.method).toBe('POST');
    expect(createReq.request.body.traits.email).toBe('new@example.com');
    createReq.flush(makeIdentity({ id: 'id-new', traits: { email: 'new@example.com', role: 'weather_admin' } }));

    expect(component.createSuccess()).toContain('new@example.com');
    expect(component.newEmail).toBe('');
    expect(component.creating()).toBe(false);

    // Reload triggered
    const reloadReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    reloadReq.flush([]);
  });

  it('should handle create error', () => {
    const { component } = createComponent();
    flushInit();

    component.newEmail = 'bad@example.com';
    component.newPassword = 'pass';
    component.createIdentity();

    const createReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    createReq.flush(null, { status: 400, statusText: 'Bad Request' });

    expect(component.createError()).toContain('Failed to create identity');
    expect(component.creating()).toBe(false);
  });

  it('should start and cancel edit', () => {
    const { component } = createComponent();
    const identity = makeIdentity();
    flushInit([identity]);

    component.startEdit(identity);
    expect(component.editingId()).toBe('id-1');
    expect(component.editRole).toBe('admin');

    component.cancelEdit();
    expect(component.editingId()).toBeNull();
    expect(component.editRole).toBe('');
  });

  it('should save role and reload', () => {
    const { component } = createComponent();
    const identity = makeIdentity();
    flushInit([identity]);

    component.startEdit(identity);
    component.editRole = 'weather_admin';
    component.saveRole(identity);

    const updateReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities/id-1`);
    expect(updateReq.request.method).toBe('PUT');
    expect(updateReq.request.body.traits.role).toBe('weather_admin');
    updateReq.flush(makeIdentity({ traits: { email: 'test@example.com', role: 'weather_admin' } }));

    expect(component.saving()).toBe(false);
    expect(component.editingId()).toBeNull();

    // Reload triggered
    const reloadReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    reloadReq.flush([]);
  });

  it('should handle save error', () => {
    const { component } = createComponent();
    const identity = makeIdentity();
    flushInit([identity]);

    component.startEdit(identity);
    component.editRole = 'weather_admin';
    component.saveRole(identity);

    const updateReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities/id-1`);
    updateReq.flush(null, { status: 500, statusText: 'Error' });

    expect(component.saving()).toBe(false);
  });

  it('should delete identity and reload', () => {
    const { component } = createComponent();
    const identity = makeIdentity();
    flushInit([identity]);

    component.deleteIdentity(identity);
    expect(component.deletingId()).toBe('id-1');

    const deleteReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities/id-1`);
    expect(deleteReq.request.method).toBe('DELETE');
    deleteReq.flush(null);

    expect(component.deletingId()).toBeNull();

    // Reload triggered
    const reloadReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    reloadReq.flush([]);
  });

  it('should handle delete error', () => {
    const { component } = createComponent();
    const identity = makeIdentity();
    flushInit([identity]);

    component.deleteIdentity(identity);
    const deleteReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities/id-1`);
    deleteReq.flush(null, { status: 500, statusText: 'Error' });

    expect(component.deletingId()).toBeNull();
  });

  it('should format date', () => {
    const { component } = createComponent();
    flushInit();
    const result = component.formatDate('2026-01-15T12:00:00Z');
    expect(result).toBeTruthy();
  });

  it('should render heading', () => {
    const { fixture } = createComponent();
    flushInit();
    fixture.changeDetectorRef.detectChanges();
    const heading = (fixture.nativeElement as HTMLElement).querySelector('h1');
    expect(heading?.textContent).toContain('Identity Management');
  });

  it('should render identity table rows', () => {
    const { fixture } = createComponent();
    flushInit([makeIdentity(), makeIdentity({ id: 'id-2', traits: { email: 'b@b.com', role: 'weather_admin' } })]);
    fixture.changeDetectorRef.detectChanges();
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
  });

  it('should render back to dashboard link', () => {
    const { fixture } = createComponent();
    flushInit();
    fixture.changeDetectorRef.detectChanges();
    const backLink = (fixture.nativeElement as HTMLElement).querySelector('.back-link');
    expect(backLink?.textContent).toContain('Back to Dashboard');
  });

  it('should default editRole to empty string when identity has no role', () => {
    const { component } = createComponent();
    const identity = makeIdentity({ traits: { email: 'norole@example.com' } });
    flushInit([identity]);

    component.startEdit(identity);
    expect(component.editRole).toBe('');
  });

  it('should save role with empty string when no role selected', () => {
    const { component } = createComponent();
    const identity = makeIdentity();
    flushInit([identity]);

    component.startEdit(identity);
    component.editRole = '';
    component.saveRole(identity);

    const updateReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities/id-1`);
    expect(updateReq.request.body.traits.role).toBeUndefined();
    updateReq.flush(makeIdentity({ traits: { email: 'test@example.com' } }));

    const reloadReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    reloadReq.flush([]);
  });

  it('should create identity without role when none selected', () => {
    const { component } = createComponent();
    flushInit();

    component.newEmail = 'norole@example.com';
    component.newPassword = 'Pass1234!';
    component.newRole = '';
    component.createIdentity();

    const createReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    expect(createReq.request.body.traits.role).toBeUndefined();
    createReq.flush(makeIdentity({ traits: { email: 'norole@example.com' } }));

    const reloadReq = httpTesting.expectOne(`${ADMIN_URL}/admin/identities`);
    reloadReq.flush([]);
  });
});

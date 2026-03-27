import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import {
  provideHttpClientTesting,
  HttpTestingController,
} from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { RemoteEntry } from './entry';
import {
  PageHeaderComponent,
  CardComponent,
  StatusBadgeComponent,
} from '@org/ui';

const HEALTH_ENDPOINT = '/.ory/kratos/admin/health/alive';

describe('RemoteEntry (admin-app)', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RemoteEntry],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    })
      .overrideComponent(RemoteEntry, {
        remove: { imports: [PageHeaderComponent, CardComponent, StatusBadgeComponent] },
        add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
      })
      .compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should create the component', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should have links defined', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    const component = fixture.componentInstance;
    expect(component.links.length).toBeGreaterThan(0);
  });

  it('should have categories derived from links', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    const component = fixture.componentInstance;
    expect(component.categories.length).toBeGreaterThan(0);
    expect(component.categories).toContain('API');
    expect(component.categories).toContain('Identity');
    expect(component.categories).toContain('Observability');
    expect(component.categories).toContain('Infrastructure');
  });

  it('should filter links by category', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    const component = fixture.componentInstance;
    const apiLinks = component.linksByCategory('API');
    expect(apiLinks.length).toBeGreaterThan(0);
    apiLinks.forEach((link) => {
      expect(link.category).toBe('API');
    });
  });

  it('should return empty array for unknown category', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    const component = fixture.componentInstance;
    expect(component.linksByCategory('NonExistent')).toEqual([]);
  });

  it('should include Weather API Docs link', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    const component = fixture.componentInstance;
    const docs = component.links.find((l) => l.name === 'Weather API Docs');
    expect(docs).toBeDefined();
    expect(docs!.url).toContain('scalar');
  });

  it('should include Ory Kratos Admin link with routerLink and health badge', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    const component = fixture.componentInstance;
    const kratos = component.links.find((l) => l.name === 'Ory Kratos Admin');
    expect(kratos).toBeDefined();
    expect(kratos!.routerLink).toBe('/admin-app/kratos');
    expect(kratos!.url).toBeUndefined();
    expect(kratos!.badge).toBeDefined();
    expect(kratos!.badge!.endpoint).toContain('health/alive');
  });

  it('should include Grafana Dashboard link with credentials', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    const component = fixture.componentInstance;
    const grafana = component.links.find((l) => l.name === 'Grafana Dashboard');
    expect(grafana).toBeDefined();
    expect(grafana!.url).toContain('3000');
    expect(grafana!.credentials).toEqual({ username: 'admin', password: 'admin' });
  });

  it('should include Traefik Dashboard link', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    const component = fixture.componentInstance;
    const traefik = component.links.find((l) => l.name === 'Traefik Dashboard');
    expect(traefik).toBeDefined();
    expect(traefik!.url).toContain('8081');
  });

  it('should render the page-header element with the correct title attribute', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock.expectOne(HEALTH_ENDPOINT).flush('OK');
    const compiled = fixture.nativeElement as HTMLElement;
    const header = compiled.querySelector('ui-page-header');
    expect(header).toBeTruthy();
    expect(header!.getAttribute('title')).toBe('Admin Dashboard');
  });

  it('should render a link card inner for each admin link', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock.expectOne(HEALTH_ENDPOINT).flush('OK');
    const compiled = fixture.nativeElement as HTMLElement;
    const cards = compiled.querySelectorAll('.link-card-inner');
    expect(cards.length).toBe(9);
  });

  it('should render external links with target="_blank"', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock.expectOne(HEALTH_ENDPOINT).flush('OK');
    const compiled = fixture.nativeElement as HTMLElement;
    const externalCards = compiled.querySelectorAll('a[target="_blank"]');
    expect(externalCards.length).toBe(7);
  });

  it('should render category section titles', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock.expectOne(HEALTH_ENDPOINT).flush('OK');
    const compiled = fixture.nativeElement as HTMLElement;
    const sections = compiled.querySelectorAll('.section-title');
    const sectionTexts = Array.from(sections).map((s) => s.textContent?.trim());
    expect(sectionTexts).toContain('API');
    expect(sectionTexts).toContain('Identity');
    expect(sectionTexts).toContain('Observability');
    expect(sectionTexts).toContain('Infrastructure');
  });

  describe('healthVariant', () => {
    it('should return "success" for status "up"', () => {
      const fixture = TestBed.createComponent(RemoteEntry);
      expect(fixture.componentInstance.healthVariant('up')).toBe('success');
    });

    it('should return "danger" for status "down"', () => {
      const fixture = TestBed.createComponent(RemoteEntry);
      expect(fixture.componentInstance.healthVariant('down')).toBe('danger');
    });

    it('should return "neutral" for status "pending" (default)', () => {
      const fixture = TestBed.createComponent(RemoteEntry);
      expect(fixture.componentInstance.healthVariant('pending')).toBe('neutral');
    });
  });

  describe('checkHealth (via ngOnInit)', () => {
    it('should GET the health endpoint on init', () => {
      const fixture = TestBed.createComponent(RemoteEntry);
      fixture.detectChanges();
      const req = httpMock.expectOne(HEALTH_ENDPOINT);
      expect(req.request.method).toBe('GET');
      req.flush('OK');
    });

    it('should set healthStatus to "up" when health check succeeds', () => {
      const fixture = TestBed.createComponent(RemoteEntry);
      fixture.detectChanges();
      httpMock.expectOne(HEALTH_ENDPOINT).flush('OK');
      expect(fixture.componentInstance.healthStatus[HEALTH_ENDPOINT]).toBe('up');
    });

    it('should set healthStatus to "down" when health check fails', () => {
      const fixture = TestBed.createComponent(RemoteEntry);
      fixture.detectChanges();
      httpMock
        .expectOne(HEALTH_ENDPOINT)
        .flush(null, { status: 503, statusText: 'Service Unavailable' });
      expect(fixture.componentInstance.healthStatus[HEALTH_ENDPOINT]).toBe('down');
    });
  });
});

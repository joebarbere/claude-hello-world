import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { RemoteEntry } from './entry';

describe('RemoteEntry (admin-app)', () => {
  beforeEach(async () => {
    await resolveComponentResources(() =>
      Promise.resolve({ text: () => Promise.resolve('') } as Response)
    );
    await TestBed.configureTestingModule({
      imports: [RemoteEntry],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
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

  it('should render the heading', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Admin Dashboard');
  });

  it('should render link cards', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const cards = compiled.querySelectorAll('.link-card');
    expect(cards.length).toBe(4);
  });

  it('should render external links with target="_blank"', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const externalCards = compiled.querySelectorAll('.link-card[target="_blank"]');
    expect(externalCards.length).toBe(3);
  });

  it('should render category section titles', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const sections = compiled.querySelectorAll('.section-title');
    const sectionTexts = Array.from(sections).map((s) => s.textContent?.trim());
    expect(sectionTexts).toContain('API');
    expect(sectionTexts).toContain('Identity');
    expect(sectionTexts).toContain('Observability');
    expect(sectionTexts).toContain('Infrastructure');
  });
});

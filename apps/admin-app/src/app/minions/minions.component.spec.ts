import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import {
  provideHttpClientTesting,
  HttpTestingController,
} from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MinionsComponent } from './minions.component';
import {
  PageHeaderComponent,
  CardComponent,
  StatusBadgeComponent,
} from '@org/ui';

describe('MinionsComponent', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MinionsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    })
      .overrideComponent(MinionsComponent, {
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
    const fixture = TestBed.createComponent(MinionsComponent);
    fixture.detectChanges();
    httpMock.expectOne('/minions').flush([]);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should load minions on init', () => {
    const fixture = TestBed.createComponent(MinionsComponent);
    fixture.detectChanges();
    const req = httpMock.expectOne('/minions');
    expect(req.request.method).toBe('GET');
    req.flush([
      { id: 1, name: 'Test Minion', scheduleType: 'Interval', scheduleValue: '5', isActive: true, lastRunAt: null, createdAt: '2026-03-26T00:00:00Z', updatedAt: '2026-03-26T00:00:00Z' },
    ]);
    expect(fixture.componentInstance.minions().length).toBe(1);
  });

  it('should format interval schedule', () => {
    const fixture = TestBed.createComponent(MinionsComponent);
    fixture.detectChanges();
    httpMock.expectOne('/minions').flush([]);
    const result = fixture.componentInstance.formatSchedule({
      id: 1, name: 'Test', scheduleType: 'Interval', scheduleValue: '10',
      isActive: false, lastRunAt: null, createdAt: '', updatedAt: '',
    });
    expect(result).toBe('Every 10 min');
  });

  it('should format cron schedule', () => {
    const fixture = TestBed.createComponent(MinionsComponent);
    fixture.detectChanges();
    httpMock.expectOne('/minions').flush([]);
    const result = fixture.componentInstance.formatSchedule({
      id: 1, name: 'Test', scheduleType: 'Cron', scheduleValue: '*/10 * * * *',
      isActive: false, lastRunAt: null, createdAt: '', updatedAt: '',
    });
    expect(result).toBe('*/10 * * * *');
  });

  it('should format daily-at schedule', () => {
    const fixture = TestBed.createComponent(MinionsComponent);
    fixture.detectChanges();
    httpMock.expectOne('/minions').flush([]);
    const result = fixture.componentInstance.formatSchedule({
      id: 1, name: 'Test', scheduleType: 'DailyAt', scheduleValue: '14:30',
      isActive: false, lastRunAt: null, createdAt: '', updatedAt: '',
    });
    expect(result).toBe('Daily at 14:30 UTC');
  });

  it('should format lastRunAt as "Never" when null', () => {
    const fixture = TestBed.createComponent(MinionsComponent);
    fixture.detectChanges();
    httpMock.expectOne('/minions').flush([]);
    expect(fixture.componentInstance.formatLastRun(null)).toBe('Never');
  });
});

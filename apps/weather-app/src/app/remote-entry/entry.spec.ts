import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import {
  provideHttpClientTesting,
  HttpTestingController,
} from '@angular/common/http/testing';
import { RemoteEntry } from './entry';
import {
  PageHeaderComponent,
  CardComponent,
  StatusBadgeComponent,
} from '@org/ui';

interface WeatherForecast {
  date: string;
  temperatureC: number;
  temperatureF: number;
  summary: string | null;
}

const mockForecasts: WeatherForecast[] = [
  { date: '2024-01-01', temperatureC: 5, temperatureF: 41, summary: 'Chilly' },
  { date: '2024-01-02', temperatureC: 20, temperatureF: 68, summary: 'Warm' },
  { date: '2024-01-03', temperatureC: 30, temperatureF: 86, summary: 'Hot' },
  { date: '2024-01-04', temperatureC: 40, temperatureF: 104, summary: null },
];

describe('RemoteEntry (weather-app)', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RemoteEntry],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
      .overrideComponent(RemoteEntry, {
        remove: {
          imports: [PageHeaderComponent, CardComponent, StatusBadgeComponent],
        },
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
    fixture.detectChanges();
    httpMock.expectOne('/weather').flush([]);
  });

  it('should start in loading state', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    expect(fixture.componentInstance.loading()).toBe(true);
    httpMock.expectOne('/weather').flush([]);
  });

  it('should show "Loading..." text while fetching', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Loading forecasts...');
    httpMock.expectOne('/weather').flush([]);
  });

  it('should call GET /weather on init', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    const req = httpMock.expectOne('/weather');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('should populate forecasts signal on success', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock.expectOne('/weather').flush(mockForecasts);
    expect(fixture.componentInstance.forecasts()).toEqual(mockForecasts);
  });

  it('should clear loading after successful response', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock.expectOne('/weather').flush(mockForecasts);
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('should render table headers after data loads', async () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock.expectOne('/weather').flush(mockForecasts);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const headers = Array.from(el.querySelectorAll('th')).map((th) =>
      th.textContent?.trim()
    );
    expect(headers).toContain('Date');
    expect(headers).toContain('Temp (°C)');
    expect(headers).toContain('Temp (°F)');
    expect(headers).toContain('Summary');
  });

  it('should render a row for each forecast', async () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock.expectOne('/weather').flush(mockForecasts);
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(mockForecasts.length);
  });

  it('should display forecast data in rows', async () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock.expectOne('/weather').flush(mockForecasts);
    fixture.detectChanges();
    const cells = Array.from(
      fixture.nativeElement.querySelectorAll('tbody td')
    ).map((td: Element) => td.textContent?.trim());
    expect(cells).toContain('2024-01-01');
    expect(cells).toContain('5°');
    expect(cells).toContain('41°');
    expect(cells).toContain('Chilly');
  });

  it('should show error message on HTTP failure', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock
      .expectOne('/weather')
      .flush(null, { status: 500, statusText: 'Server Error' });
    expect(fixture.componentInstance.error()).toBe(
      'Failed to load weather data.'
    );
  });

  it('should clear loading after HTTP failure', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock
      .expectOne('/weather')
      .flush(null, { status: 500, statusText: 'Server Error' });
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('should render error text in the DOM on failure', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock
      .expectOne('/weather')
      .flush(null, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Failed to load weather data.');
  });

  describe('tempVariant', () => {
    it('should return "cold" for temperatures below 0', () => {
      const fixture = TestBed.createComponent(RemoteEntry);
      fixture.detectChanges();
      httpMock.expectOne('/weather').flush([]);
      expect(fixture.componentInstance.tempVariant(-5)).toBe('cold');
    });

    it('should return "cool" for temperatures 0–14', () => {
      const fixture = TestBed.createComponent(RemoteEntry);
      fixture.detectChanges();
      httpMock.expectOne('/weather').flush([]);
      expect(fixture.componentInstance.tempVariant(10)).toBe('cool');
    });

    it('should return "mild" for temperatures 15–24', () => {
      const fixture = TestBed.createComponent(RemoteEntry);
      fixture.detectChanges();
      httpMock.expectOne('/weather').flush([]);
      expect(fixture.componentInstance.tempVariant(20)).toBe('mild');
    });

    it('should return "warm" for temperatures 25–34', () => {
      const fixture = TestBed.createComponent(RemoteEntry);
      fixture.detectChanges();
      httpMock.expectOne('/weather').flush([]);
      expect(fixture.componentInstance.tempVariant(30)).toBe('warm');
    });

    it('should return "hot" for temperatures 35+', () => {
      const fixture = TestBed.createComponent(RemoteEntry);
      fixture.detectChanges();
      httpMock.expectOne('/weather').flush([]);
      expect(fixture.componentInstance.tempVariant(40)).toBe('hot');
    });
  });

  it('should render a dash for forecasts with null summary', () => {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    httpMock.expectOne('/weather').flush(mockForecasts);
    fixture.detectChanges();
    const dashes = fixture.nativeElement.querySelectorAll('.dash');
    expect(dashes.length).toBe(1);
    expect(dashes[0].textContent).toBe('—');
  });
});

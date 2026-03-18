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
  id: number;
  date: string;
  temperatureC: number;
  temperatureF: number;
  summary: string | null;
}

const mockForecasts: WeatherForecast[] = [
  { id: 1, date: '2024-01-01', temperatureC: -5, temperatureF: 23, summary: 'Freezing' },
  { id: 2, date: '2024-01-02', temperatureC: 10, temperatureF: 50, summary: 'Cool' },
  { id: 3, date: '2024-01-03', temperatureC: 20, temperatureF: 68, summary: 'Mild' },
];

describe('RemoteEntry (weatheredit-app)', () => {
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

  function createAndInit() {
    const fixture = TestBed.createComponent(RemoteEntry);
    fixture.detectChanges();
    return fixture;
  }

  // --- Creation & initial state ---

  it('should create the component', () => {
    const fixture = createAndInit();
    expect(fixture.componentInstance).toBeTruthy();
    httpMock.expectOne('/weather').flush([]);
  });

  it('should start in loading state', () => {
    const fixture = createAndInit();
    expect(fixture.componentInstance.loading()).toBe(true);
    httpMock.expectOne('/weather').flush([]);
  });

  it('should call GET /weather on init', () => {
    createAndInit();
    const req = httpMock.expectOne('/weather');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('should clear loading after data loads', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush(mockForecasts);
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('should populate forecasts signal after successful load', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush(mockForecasts);
    expect(fixture.componentInstance.forecasts()).toEqual(mockForecasts);
  });

  it('should show empty state when no forecasts', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush([]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('No forecasts yet');
  });

  it('should show forecast table when data exists', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush(mockForecasts);
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(mockForecasts.length);
  });

  it('should set error signal and clear loading on HTTP failure', () => {
    const fixture = createAndInit();
    httpMock
      .expectOne('/weather')
      .flush(null, { status: 500, statusText: 'Server Error' });
    expect(fixture.componentInstance.error()).toBe('Failed to load forecasts.');
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  // --- tempClass ---

  it('tempClass() returns badge-cold for temp < 0', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush([]);
    expect(fixture.componentInstance.tempClass(-1)).toBe('cold');
    expect(fixture.componentInstance.tempClass(-20)).toBe('cold');
  });

  it('tempClass() returns badge-cool for 0 <= temp < 15', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush([]);
    expect(fixture.componentInstance.tempClass(0)).toBe('cool');
    expect(fixture.componentInstance.tempClass(14)).toBe('cool');
  });

  it('tempClass() returns badge-mild for 15 <= temp < 25', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush([]);
    expect(fixture.componentInstance.tempClass(15)).toBe('mild');
    expect(fixture.componentInstance.tempClass(24)).toBe('mild');
  });

  it('tempClass() returns badge-warm for 25 <= temp < 35', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush([]);
    expect(fixture.componentInstance.tempClass(25)).toBe('warm');
    expect(fixture.componentInstance.tempClass(34)).toBe('warm');
  });

  it('tempClass() returns badge-hot for temp >= 35', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush([]);
    expect(fixture.componentInstance.tempClass(35)).toBe('hot');
    expect(fixture.componentInstance.tempClass(100)).toBe('hot');
  });

  // --- Form state ---

  it('clearError() clears the error signal', () => {
    const fixture = createAndInit();
    httpMock
      .expectOne('/weather')
      .flush(null, { status: 500, statusText: 'Server Error' });
    fixture.componentInstance.clearError();
    expect(fixture.componentInstance.error()).toBeNull();
  });

  it('openCreate() shows form and clears editingId', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush([]);
    fixture.componentInstance.openCreate();
    expect(fixture.componentInstance.showForm()).toBe(true);
    expect(fixture.componentInstance.editingId()).toBeNull();
  });

  it('closeForm() hides form', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush([]);
    fixture.componentInstance.openCreate();
    fixture.componentInstance.closeForm();
    expect(fixture.componentInstance.showForm()).toBe(false);
  });

  it('openEdit() populates formData and shows form', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush(mockForecasts);
    const forecast = mockForecasts[0];
    fixture.componentInstance.openEdit(forecast);
    expect(fixture.componentInstance.showForm()).toBe(true);
    expect(fixture.componentInstance.editingId()).toBe(forecast.id);
    expect(fixture.componentInstance.formData.date).toBe(forecast.date);
    expect(fixture.componentInstance.formData.temperatureC).toBe(
      forecast.temperatureC
    );
  });

  // --- Delete flow ---

  it('confirmDelete() sets confirmingDeleteId', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush(mockForecasts);
    fixture.componentInstance.confirmDelete(1);
    expect(fixture.componentInstance.confirmingDeleteId()).toBe(1);
  });

  it('cancelDelete() clears confirmingDeleteId', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush(mockForecasts);
    fixture.componentInstance.confirmDelete(1);
    fixture.componentInstance.cancelDelete();
    expect(fixture.componentInstance.confirmingDeleteId()).toBeNull();
  });

  it('deleteConfirmed() sends DELETE request and reloads', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush(mockForecasts);

    fixture.componentInstance.confirmDelete(1);
    fixture.componentInstance.deleteConfirmed(1);

    const deleteReq = httpMock.expectOne('/weather/1');
    expect(deleteReq.request.method).toBe('DELETE');
    deleteReq.flush(null);

    // reload triggered
    httpMock.expectOne('/weather').flush([]);
    expect(fixture.componentInstance.deletingId()).toBeNull();
  });

  it('deleteConfirmed() sets error on failure', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush(mockForecasts);

    fixture.componentInstance.confirmDelete(1);
    fixture.componentInstance.deleteConfirmed(1);
    httpMock
      .expectOne('/weather/1')
      .flush(null, { status: 500, statusText: 'Server Error' });

    expect(fixture.componentInstance.error()).toBe('Failed to delete forecast.');
    expect(fixture.componentInstance.deletingId()).toBeNull();
  });

  // --- Save flow ---

  it('save() sends POST for new forecast, then reloads and closes form', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush(mockForecasts);

    fixture.componentInstance.openCreate();
    fixture.componentInstance.formData = {
      date: '2024-06-01',
      temperatureC: 25,
      summary: 'Hot day',
    };
    fixture.componentInstance.save();

    const postReq = httpMock.expectOne('/weather');
    expect(postReq.request.method).toBe('POST');
    expect(postReq.request.body).toMatchObject({
      date: '2024-06-01',
      temperatureC: 25,
      summary: 'Hot day',
    });
    postReq.flush({ id: 4, date: '2024-06-01', temperatureC: 25, temperatureF: 77, summary: 'Hot day' });

    // reload
    httpMock.expectOne('/weather').flush([]);
    expect(fixture.componentInstance.showForm()).toBe(false);
    expect(fixture.componentInstance.saving()).toBe(false);
  });

  it('save() sends PUT for edit, then reloads and closes form', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush(mockForecasts);

    fixture.componentInstance.openEdit(mockForecasts[0]);
    fixture.componentInstance.save();

    const putReq = httpMock.expectOne('/weather/1');
    expect(putReq.request.method).toBe('PUT');
    putReq.flush(mockForecasts[0]);

    httpMock.expectOne('/weather').flush(mockForecasts);
    expect(fixture.componentInstance.showForm()).toBe(false);
  });

  it('save() sets error on failure', () => {
    const fixture = createAndInit();
    httpMock.expectOne('/weather').flush(mockForecasts);

    fixture.componentInstance.openCreate();
    fixture.componentInstance.save();
    httpMock
      .expectOne('/weather')
      .flush(null, { status: 400, statusText: 'Bad Request' });

    expect(fixture.componentInstance.error()).toBe('Failed to save forecast.');
    expect(fixture.componentInstance.saving()).toBe(false);
  });
});

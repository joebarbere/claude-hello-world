import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

interface WeatherForecast {
  id: number;
  date: string;
  temperatureC: number;
  temperatureF: number;
  summary: string | null;
}

interface ForecastFormData {
  date: string;
  temperatureC: number;
  summary: string;
}

@Component({
  selector: 'app-page2-entry',
  imports: [FormsModule],
  styleUrl: './entry.css',
  template: `
    <div class="page">

      <header class="page-header">
        <div class="header-title">
          <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 3v1m0 16v1M4.22 4.22l.7.7m12.16 12.16.7.7M3 12h1m16 0h1M4.92 19.08l.7-.7M18.36 5.64l.7-.7"/>
            <circle cx="12" cy="12" r="4"/>
          </svg>
          <h1>Weather Forecasts</h1>
        </div>
        @if (!showForm()) {
          <button class="btn btn-primary" (click)="openCreate()">
            <span class="btn-icon">+</span> New Forecast
          </button>
        }
      </header>

      @if (error()) {
        <div class="alert alert-error" role="alert">
          <div class="alert-body">
            <svg viewBox="0 0 20 20" fill="currentColor" class="alert-icon">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd"/>
            </svg>
            {{ error() }}
          </div>
          <button class="alert-close" (click)="clearError()" aria-label="Dismiss">✕</button>
        </div>
      }

      <div class="card">
        @if (loading()) {
          <div class="loading-state">
            <div class="spinner"></div>
            <span>Loading forecasts…</span>
          </div>
        } @else if (forecasts().length === 0) {
          <div class="empty-state">
            <svg class="empty-icon" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M32 8C18.7 8 8 18.7 8 32s10.7 24 24 24 24-10.7 24-24S45.3 8 32 8z"/>
              <path d="M32 20v12l8 4"/>
            </svg>
            <p class="empty-title">No forecasts yet</p>
            <p class="empty-sub">Create your first weather forecast to get started.</p>
            <button class="btn btn-primary" (click)="openCreate()">Add Forecast</button>
          </div>
        } @else {
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Date</th>
                  <th>Temp °C</th>
                  <th>Temp °F</th>
                  <th>Summary</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (f of forecasts(); track f.id) {
                  <tr [class.row-fading]="deletingId() === f.id">
                    <td class="cell-id">#{{ f.id }}</td>
                    <td class="cell-date">{{ f.date }}</td>
                    <td class="cell-temp">{{ f.temperatureC }}°</td>
                    <td class="cell-temp muted">{{ f.temperatureF }}°</td>
                    <td>
                      @if (f.summary) {
                        <span [class]="'badge ' + tempClass(f.temperatureC)">{{ f.summary }}</span>
                      } @else {
                        <span class="dash">—</span>
                      }
                    </td>
                    <td class="cell-actions">
                      @if (confirmingDeleteId() === f.id) {
                        <span class="confirm-text">Delete?</span>
                        <button class="btn btn-danger btn-sm" (click)="deleteConfirmed(f.id)">Yes</button>
                        <button class="btn btn-ghost btn-sm" (click)="cancelDelete()">No</button>
                      } @else {
                        <button class="btn btn-ghost btn-sm"
                          (click)="openEdit(f)"
                          [disabled]="deletingId() !== null">
                          <svg viewBox="0 0 16 16" fill="currentColor" class="btn-icon-sm">
                            <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/>
                          </svg>
                          Edit
                        </button>
                        <button class="btn btn-danger-ghost btn-sm"
                          (click)="confirmDelete(f.id)"
                          [disabled]="deletingId() !== null">
                          <svg viewBox="0 0 16 16" fill="currentColor" class="btn-icon-sm">
                            <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.49.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/>
                          </svg>
                          Delete
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>

      @if (showForm()) {
        <div class="card form-card">
          <div class="form-header">
            <h2>{{ editingId() !== null ? 'Edit Forecast' : 'New Forecast' }}</h2>
            <p class="form-subtitle">{{ editingId() !== null ? 'Update the forecast details below.' : 'Fill in the details to create a new forecast.' }}</p>
          </div>
          <form (ngSubmit)="save()" #f="ngForm">
            <div class="form-grid">
              <div class="form-group">
                <label for="date">Date</label>
                <input id="date" type="date" class="form-input"
                  [(ngModel)]="formData.date" name="date" required />
              </div>
              <div class="form-group">
                <label for="temp">Temperature (°C)</label>
                <input id="temp" type="number" class="form-input"
                  [(ngModel)]="formData.temperatureC" name="temperatureC"
                  required min="-100" max="100" />
              </div>
              <div class="form-group">
                <label for="summary">Summary</label>
                <input id="summary" type="text" class="form-input"
                  [(ngModel)]="formData.summary" name="summary"
                  placeholder="e.g. Sunny, Partly cloudy…" maxlength="64" />
              </div>
            </div>
            <div class="form-actions">
              <button type="button" class="btn btn-ghost" (click)="closeForm()">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="saving() || f.invalid">
                @if (saving()) {
                  <span class="spinner-sm"></span> Saving…
                } @else {
                  {{ editingId() !== null ? 'Update Forecast' : 'Create Forecast' }}
                }
              </button>
            </div>
          </form>
        </div>
      }

    </div>
  `,
})
export class RemoteEntry implements OnInit {
  private http = inject(HttpClient);

  forecasts = signal<WeatherForecast[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  saving = signal(false);
  deletingId = signal<number | null>(null);
  confirmingDeleteId = signal<number | null>(null);
  showForm = signal(false);
  editingId = signal<number | null>(null);

  formData: ForecastFormData = { date: '', temperatureC: 20, summary: '' };

  ngOnInit() {
    this.load();
  }

  load() {
    this.loading.set(true);
    this.error.set(null);
    this.http.get<WeatherForecast[]>('/weather').subscribe({
      next: (data) => { this.forecasts.set(data); this.loading.set(false); },
      error: () => { this.error.set('Failed to load forecasts.'); this.loading.set(false); },
    });
  }

  clearError() { this.error.set(null); }

  openCreate() {
    this.editingId.set(null);
    this.formData = { date: todayIso(), temperatureC: 20, summary: '' };
    this.showForm.set(true);
  }

  openEdit(f: WeatherForecast) {
    this.editingId.set(f.id);
    this.formData = { date: f.date, temperatureC: f.temperatureC, summary: f.summary ?? '' };
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
  }

  save() {
    const id = this.editingId();
    this.saving.set(true);
    const req = id !== null
      ? this.http.put<WeatherForecast>(`/weather/${id}`, this.formData)
      : this.http.post<WeatherForecast>('/weather', this.formData);

    req.subscribe({
      next: () => { this.saving.set(false); this.closeForm(); this.load(); },
      error: () => { this.saving.set(false); this.error.set('Failed to save forecast.'); },
    });
  }

  confirmDelete(id: number) { this.confirmingDeleteId.set(id); }
  cancelDelete() { this.confirmingDeleteId.set(null); }

  deleteConfirmed(id: number) {
    this.confirmingDeleteId.set(null);
    this.deletingId.set(id);
    this.http.delete(`/weather/${id}`).subscribe({
      next: () => { this.deletingId.set(null); this.load(); },
      error: () => { this.deletingId.set(null); this.error.set('Failed to delete forecast.'); },
    });
  }

  tempClass(temp: number): string {
    if (temp < 0) return 'badge-cold';
    if (temp < 15) return 'badge-cool';
    if (temp < 25) return 'badge-mild';
    if (temp < 35) return 'badge-warm';
    return 'badge-hot';
  }
}

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

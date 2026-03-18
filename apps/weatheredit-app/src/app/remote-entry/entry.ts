import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
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

interface ForecastFormData {
  date: string;
  temperatureC: number;
  summary: string;
}

@Component({
  selector: 'app-weatheredit-app-entry',
  imports: [FormsModule, PageHeaderComponent, CardComponent, StatusBadgeComponent],
  styles: [`
    :host { display: block; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif; background: #f8f9fa; min-height: 100%; color: #1e293b; -webkit-font-smoothing: antialiased; }
    .page-container { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
    .alert { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.875rem; gap: 12px; }
    .alert-error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }
    .alert-body { display: flex; align-items: center; gap: 8px; }
    .alert-close { background: none; border: none; cursor: pointer; color: #b91c1c; padding: 4px; border-radius: 4px; line-height: 1; opacity: 0.6; transition: opacity 0.15s; }
    .alert-close:hover { opacity: 1; }
    .loading-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px 24px; color: #64748b; font-size: 0.875rem; }
    .empty-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 48px 24px; text-align: center; }
    .empty-title { font-size: 0.9375rem; font-weight: 600; color: #334155; }
    .empty-sub { font-size: 0.8125rem; color: #94a3b8; margin-bottom: 8px; }
    .table-wrapper { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    thead th { padding: 12px 16px; text-align: left; font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8; background: #f8fafc; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    tbody tr { border-bottom: 1px solid #f1f5f9; transition: background 0.1s; }
    tbody tr:last-child { border-bottom: none; }
    tbody tr:hover { background: #f8fafc; }
    tbody tr.row-fading { opacity: 0.35; pointer-events: none; }
    td { padding: 12px 16px; color: #334155; }
    .cell-id { color: #94a3b8; font-variant-numeric: tabular-nums; font-size: 0.8125rem; }
    .cell-date { font-variant-numeric: tabular-nums; color: #475569; }
    .cell-temp { font-variant-numeric: tabular-nums; font-weight: 600; color: #1e293b; }
    .cell-temp.muted { font-weight: 400; color: #94a3b8; }
    .cell-actions { display: flex; align-items: center; gap: 6px; }
    .confirm-text { font-size: 0.8125rem; color: #64748b; margin-right: 2px; }
    .dash { color: #cbd5e1; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; border: none; cursor: pointer; transition: background 0.15s, box-shadow 0.15s, opacity 0.15s; white-space: nowrap; line-height: 1.25; }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-sm { padding: 5px 10px; font-size: 0.8125rem; border-radius: 6px; gap: 4px; }
    .btn-primary { background: #6366f1; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #4f46e5; box-shadow: 0 1px 4px rgba(79,70,229,0.3); }
    .btn-danger { background: #ef4444; color: #fff; }
    .btn-danger:hover:not(:disabled) { background: #dc2626; }
    .btn-ghost { background: #f1f5f9; color: #334155; }
    .btn-ghost:hover:not(:disabled) { background: #e2e8f0; }
    .btn-danger-ghost { background: transparent; color: #dc2626; }
    .btn-danger-ghost:hover:not(:disabled) { background: #fef2f2; }
    .form-card { padding: 24px; }
    .form-header { margin-bottom: 20px; }
    h2 { margin: 0; font-size: 1rem; font-weight: 600; color: #1e293b; }
    .form-subtitle { margin: 4px 0 0; font-size: 0.8125rem; color: #94a3b8; }
    .form-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px; }
    @media (max-width: 640px) { .form-grid { grid-template-columns: 1fr; } }
    .form-group { display: flex; flex-direction: column; gap: 5px; }
    label { font-size: 0.8125rem; font-weight: 500; color: #334155; }
    .form-input { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem; color: #1e293b; background: #fff; width: 100%; box-sizing: border-box; outline: none; transition: border-color 0.15s, box-shadow 0.15s; }
    .form-input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.12); }
    .form-input::placeholder { color: #94a3b8; }
    .form-actions { display: flex; gap: 8px; justify-content: flex-end; padding-top: 16px; border-top: 1px solid #f1f5f9; }
  `],
  template: `
    <div class="page-container">
      <ui-page-header
        title="Manage Forecasts"
        [subtitle]="showForm() ? undefined : 'Create, edit, and delete weather forecasts.'"
      >
        @if (!showForm()) {
          <button class="btn btn-primary" (click)="openCreate()">
            <i class="pi pi-plus" style="font-size: 0.75rem;"></i> New Forecast
          </button>
        }
      </ui-page-header>

      @if (error()) {
        <div class="alert alert-error" role="alert">
          <div class="alert-body">
            <i class="pi pi-exclamation-circle"></i>
            {{ error() }}
          </div>
          <button class="alert-close" (click)="clearError()" aria-label="Dismiss">
            <i class="pi pi-times"></i>
          </button>
        </div>
      }

      <ui-card>
        @if (loading()) {
          <div class="loading-state">
            <i class="pi pi-spin pi-spinner" style="font-size: 1.5rem; color: #6366f1;"></i>
            <span>Loading forecasts...</span>
          </div>
        } @else if (forecasts().length === 0) {
          <div class="empty-state">
            <i class="pi pi-cloud" style="font-size: 2.5rem; color: #cbd5e1;"></i>
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
                        <ui-status-badge [variant]="tempClass(f.temperatureC)">{{ f.summary }}</ui-status-badge>
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
                          <i class="pi pi-pencil" style="font-size: 0.75rem;"></i>
                          Edit
                        </button>
                        <button class="btn btn-danger-ghost btn-sm"
                          (click)="confirmDelete(f.id)"
                          [disabled]="deletingId() !== null">
                          <i class="pi pi-trash" style="font-size: 0.75rem;"></i>
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
      </ui-card>

      @if (showForm()) {
        <ui-card>
          <div class="form-card">
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
                    <i class="pi pi-spin pi-spinner" style="font-size: 0.75rem;"></i> Saving...
                  } @else {
                    {{ editingId() !== null ? 'Update Forecast' : 'Create Forecast' }}
                  }
                </button>
              </div>
            </form>
          </div>
        </ui-card>
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
      next: (data) => {
        this.forecasts.set(data);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load forecasts.');
        this.loading.set(false);
      },
    });
  }

  clearError() {
    this.error.set(null);
  }

  openCreate() {
    this.editingId.set(null);
    this.formData = { date: todayIso(), temperatureC: 20, summary: '' };
    this.showForm.set(true);
  }

  openEdit(f: WeatherForecast) {
    this.editingId.set(f.id);
    this.formData = {
      date: f.date,
      temperatureC: f.temperatureC,
      summary: f.summary ?? '',
    };
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
  }

  save() {
    const id = this.editingId();
    this.saving.set(true);
    const req =
      id !== null
        ? this.http.put<WeatherForecast>(`/weather/${id}`, this.formData)
        : this.http.post<WeatherForecast>('/weather', this.formData);

    req.subscribe({
      next: () => {
        this.saving.set(false);
        this.closeForm();
        this.load();
      },
      error: () => {
        this.saving.set(false);
        this.error.set('Failed to save forecast.');
      },
    });
  }

  confirmDelete(id: number) {
    this.confirmingDeleteId.set(id);
  }
  cancelDelete() {
    this.confirmingDeleteId.set(null);
  }

  deleteConfirmed(id: number) {
    this.confirmingDeleteId.set(null);
    this.deletingId.set(id);
    this.http.delete(`/weather/${id}`).subscribe({
      next: () => {
        this.deletingId.set(null);
        this.load();
      },
      error: () => {
        this.deletingId.set(null);
        this.error.set('Failed to delete forecast.');
      },
    });
  }

  tempClass(temp: number): string {
    if (temp < 0) return 'cold';
    if (temp < 15) return 'cool';
    if (temp < 25) return 'mild';
    if (temp < 35) return 'warm';
    return 'hot';
  }
}

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

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
  styleUrl: './entry.css',
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

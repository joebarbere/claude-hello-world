import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { PageHeaderComponent, CardComponent, StatusBadgeComponent } from '@org/ui';

interface WeatherForecast {
  date: string;
  temperatureC: number;
  temperatureF: number;
  summary: string | null;
}

@Component({
  selector: 'app-weather-app-entry',
  imports: [PageHeaderComponent, CardComponent, StatusBadgeComponent],
  template: `
    <div class="page-container">
      <ui-page-header
        title="Weather Forecast"
        subtitle="Current weather data from the API."
      ></ui-page-header>

      @if (loading()) {
        <ui-card>
          <div class="loading-state">
            <i class="pi pi-spin pi-spinner" style="font-size: 1.5rem; color: #6366f1;"></i>
            <span>Loading forecasts...</span>
          </div>
        </ui-card>
      } @else if (error()) {
        <div class="alert-error">
          <i class="pi pi-exclamation-circle"></i>
          {{ error() }}
        </div>
      } @else {
        <ui-card>
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Temp (°C)</th>
                  <th>Temp (°F)</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                @for (row of forecasts(); track row.date) {
                  <tr>
                    <td class="cell-date">{{ row.date }}</td>
                    <td class="cell-temp">{{ row.temperatureC }}°</td>
                    <td class="cell-temp muted">{{ row.temperatureF }}°</td>
                    <td>
                      @if (row.summary) {
                        <ui-status-badge [variant]="tempVariant(row.temperatureC)">
                          {{ row.summary }}
                        </ui-status-badge>
                      } @else {
                        <span class="dash">—</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </ui-card>
      }
    </div>
  `,
  styles: [
    `
      .page-container {
        max-width: 960px;
        margin: 0 auto;
        padding: 32px 24px;
      }
      .loading-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 48px 24px;
        color: var(--text-secondary);
        font-size: 0.875rem;
      }
      .alert-error {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        background: rgba(239, 68, 68, 0.15);
        border: 1px solid rgba(239, 68, 68, 0.3);
        color: #f87171;
        border-radius: 8px;
        font-size: 0.875rem;
      }
      .table-wrapper {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.875rem;
      }
      thead th {
        padding: 12px 16px;
        text-align: left;
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
        background: var(--bg-body);
        border-bottom: 1px solid var(--border-color);
      }
      tbody tr {
        border-bottom: 1px solid var(--border-color);
        transition: background 0.1s;
      }
      tbody tr:last-child {
        border-bottom: none;
      }
      tbody tr:hover {
        background: var(--bg-surface-hover);
      }
      td {
        padding: 12px 16px;
        color: var(--text-primary);
      }
      .cell-date {
        font-variant-numeric: tabular-nums;
        color: var(--text-muted);
      }
      .cell-temp {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        color: var(--text-primary);
      }
      .cell-temp.muted {
        font-weight: 400;
        color: var(--text-secondary);
      }
      .dash {
        color: var(--text-muted);
      }
    `,
  ],
})
export class RemoteEntry implements OnInit {
  private http = inject(HttpClient);

  forecasts = signal<WeatherForecast[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  ngOnInit() {
    this.http.get<WeatherForecast[]>('/weather').subscribe({
      next: (data) => {
        this.forecasts.set(data);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load weather data.');
        this.loading.set(false);
      },
    });
  }

  tempVariant(temp: number): string {
    if (temp < 0) return 'cold';
    if (temp < 15) return 'cool';
    if (temp < 25) return 'mild';
    if (temp < 35) return 'warm';
    return 'hot';
  }
}

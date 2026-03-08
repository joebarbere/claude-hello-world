import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

interface WeatherForecast {
  date: string;
  temperatureC: number;
  temperatureF: number;
  summary: string | null;
}

@Component({
  selector: 'app-page1-entry',
  template: `
    <h2>Weather Forecast</h2>
    @if (loading()) {
      <p>Loading...</p>
    } @else if (error()) {
      <p class="error">{{ error() }}</p>
    } @else {
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
              <td>{{ row.date }}</td>
              <td>{{ row.temperatureC }}</td>
              <td>{{ row.temperatureF }}</td>
              <td>{{ row.summary }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
  styles: [`
    h2 { font-family: sans-serif; }
    table { border-collapse: collapse; width: 100%; font-family: sans-serif; }
    th, td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
    th { background: #f0f0f0; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
    .error { color: red; font-family: sans-serif; }
  `],
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
}

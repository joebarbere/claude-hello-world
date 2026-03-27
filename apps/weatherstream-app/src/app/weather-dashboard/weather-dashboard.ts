import { Component, inject } from '@angular/core';
import { KafkaStreamService } from '../services/kafka-stream.service';
import { DatePipe, DecimalPipe } from '@angular/common';

@Component({
  selector: 'app-weather-dashboard',
  imports: [DatePipe, DecimalPipe],
  templateUrl: './weather-dashboard.html',
  styleUrl: './weather-dashboard.css',
})
export class WeatherDashboard {
  protected readonly stream = inject(KafkaStreamService);

  conditionIcon(condition: string): string {
    const icons: Record<string, string> = {
      Sunny: '☀️', Cloudy: '☁️', Rainy: '🌧️', Stormy: '⛈️',
      Snowy: '❄️', Windy: '💨', Foggy: '🌫️', Clear: '🌙',
      Hail: '🌨️', Drizzle: '🌦️',
    };
    return icons[condition] ?? '🌡️';
  }

  tempColor(temp: number): string {
    if (temp < 0) return '#3b82f6';
    if (temp < 15) return '#06b6d4';
    if (temp < 25) return '#22c55e';
    if (temp < 35) return '#f59e0b';
    return '#ef4444';
  }
}

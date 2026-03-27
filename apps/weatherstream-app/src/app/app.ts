import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { WeatherDashboard } from './weather-dashboard/weather-dashboard';

@Component({
  imports: [RouterModule, WeatherDashboard],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected title = 'weatherstream-app';
}

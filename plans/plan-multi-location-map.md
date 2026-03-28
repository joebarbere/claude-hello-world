# Plan: Multi-Location Forecast Comparison View with Map

## Goal

Add an interactive map-based view that displays current weather forecasts for all monitored locations simultaneously, allowing side-by-side comparison of conditions across cities using Leaflet.js markers and popups within the existing Module Federation architecture.

## Current State

- **WeatherForecast model** (`apps/weather-api/Models/WeatherForecast.cs`): Has `Id`, `Date`, `TemperatureC`, `Summary`, and computed `TemperatureF`. **No location, latitude, or longitude fields exist.** This is the primary blocker — the "Add location to WeatherForecast" idea in `IDEAS.md` must be completed first.
- **Weather API endpoints** (`apps/weather-api/Program.cs`): CRUD at `/weatherforecast` with `GetAll`, `GetById`, `Create`, `Update`, `Delete`. No filtering by location or summary/aggregate endpoint.
- **weather-app** (`apps/weather-app/`): A Module Federation remote exposing `./Routes` from `apps/weather-app/src/app/remote-entry/entry.routes.ts`. The entry component (`entry.ts`) fetches `GET /weather` and renders a flat table. Uses Angular signals for reactive state (required pattern for MF remotes per `CLAUDE.md`).
- **Shell app** (`apps/shell/module-federation.config.ts`): Hosts three remotes: `weather-app`, `weatheredit-app`, `admin-app`. Routes defined in `apps/shell/src/app/app.routes.ts`.
- **Traefik routing** (`traefik/traefik-dynamic.yml`): `/weather` and `/weather/{id}` are rewritten to `/weatherforecast` and `/weatherforecast/{id}` before forwarding to the weather-api at `host.containers.internal:5221`. New API paths must follow this pattern.
- **UI library** (`libs/ui/`): Provides `PageHeaderComponent`, `CardComponent`, `StatusBadgeComponent` — shared across remotes.
- **Module Federation config** (`apps/weather-app/module-federation.config.ts`): Exposes `./Routes` entry point. Any new map route can be added under this same remote.
- **Package manager**: npm (based on `package-lock.json`).

## Implementation Steps

### 1. Prerequisite: Add location fields to WeatherForecast (separate plan)

The map view is meaningless without geographic coordinates. This plan assumes the following already exist on the model:
- `Location` (string, nullable, max 100 chars)
- `Latitude` (double, nullable)
- `Longitude` (double, nullable)

An EF Core migration must have been applied. See IDEAS.md "Add location to WeatherForecast" for details.

### 2. Add a `/weatherforecast/summary` API endpoint

Edit `apps/weather-api/Program.cs` to add a new endpoint inside the `forecasts` MapGroup:

```csharp
forecasts.MapGet("/summary", async (IWeatherForecastRepository repo) =>
{
    var all = await repo.GetAllAsync();
    var summary = all
        .Where(f => f.Location != null && f.Latitude.HasValue && f.Longitude.HasValue)
        .GroupBy(f => f.Location)
        .Select(g => new
        {
            Location = g.Key,
            Latitude = g.First().Latitude,
            Longitude = g.First().Longitude,
            LatestDate = g.Max(f => f.Date),
            LatestTemperatureC = g.OrderByDescending(f => f.Date).First().TemperatureC,
            LatestTemperatureF = g.OrderByDescending(f => f.Date).First().TemperatureF,
            LatestSummary = g.OrderByDescending(f => f.Date).First().Summary,
            ForecastCount = g.Count()
        })
        .ToList();
    return Results.Ok(summary);
})
.WithName("GetWeatherForecastSummary");
```

### 3. Add Traefik route for `/weather/summary`

Edit `traefik/traefik-dynamic.yml` to add a new router above the existing `weather-sub-router` (which uses PathPrefix `/weather/`). The summary endpoint needs a specific route so it is not caught by the regex rewriter:

```yaml
weather-summary-router:
  rule: "Path(`/weather/summary`)"
  entryPoints:
    - websecure
  service: weather-api
  priority: 18
  middlewares:
    - weather-summary-replace-path
  tls: {}
```

Add middleware:
```yaml
weather-summary-replace-path:
  replacePath:
    path: "/weatherforecast/summary"
```

### 4. Install Leaflet.js dependencies

```bash
npm install leaflet @bluehalo/ngx-leaflet
npm install -D @types/leaflet
```

`@bluehalo/ngx-leaflet` is the maintained Angular wrapper for Leaflet (the original `@asymmetrik/ngx-leaflet` is archived). It works with Angular 21 standalone components.

### 5. Create the map component

Create `apps/weather-app/src/app/remote-entry/forecast-map.ts`:

```typescript
import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import { PageHeaderComponent, CardComponent } from '@org/ui';
import * as L from 'leaflet';

interface LocationSummary {
  location: string;
  latitude: number;
  longitude: number;
  latestDate: string;
  latestTemperatureC: number;
  latestTemperatureF: number;
  latestSummary: string | null;
  forecastCount: number;
}

@Component({
  selector: 'app-forecast-map',
  standalone: true,
  imports: [LeafletModule, PageHeaderComponent, CardComponent],
  template: `
    <div class="page-container">
      <ui-page-header
        title="Forecast Map"
        subtitle="Compare current conditions across all locations."
      ></ui-page-header>

      @if (loading()) {
        <ui-card>
          <div class="loading-state">
            <i class="pi pi-spin pi-spinner spinner-icon"></i>
            <span>Loading locations...</span>
          </div>
        </ui-card>
      } @else if (error()) {
        <div class="alert-error">
          <i class="pi pi-exclamation-circle"></i>
          {{ error() }}
        </div>
      } @else {
        <ui-card>
          <div class="map-container"
               leaflet
               [leafletOptions]="mapOptions"
               [leafletLayers]="markers()">
          </div>
        </ui-card>
      }
    </div>
  `,
  styles: [/* ... map-container height: 500px, border-radius, etc. */],
})
export class ForecastMapComponent implements OnInit {
  // Use signals per CLAUDE.md MF guidelines
  private http = inject(HttpClient);
  locations = signal<LocationSummary[]>([]);
  markers = signal<L.Marker[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  mapOptions: L.MapOptions = {
    layers: [
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
      }),
    ],
    zoom: 2,
    center: L.latLng(20, 0),
  };

  ngOnInit() {
    this.http.get<LocationSummary[]>('/weather/summary').subscribe({
      next: (data) => {
        this.locations.set(data);
        this.markers.set(this.buildMarkers(data));
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load location data.');
        this.loading.set(false);
      },
    });
  }

  private buildMarkers(locations: LocationSummary[]): L.Marker[] {
    return locations.map((loc) =>
      L.marker([loc.latitude, loc.longitude]).bindPopup(
        `<strong>${loc.location}</strong><br/>
         ${loc.latestTemperatureC}°C / ${loc.latestTemperatureF}°F<br/>
         ${loc.latestSummary ?? 'No summary'}<br/>
         <small>${loc.latestDate}</small>`
      )
    );
  }
}
```

### 6. Add route to the weather-app remote

Edit `apps/weather-app/src/app/remote-entry/entry.routes.ts` to add the map route:

```typescript
import { Route } from '@angular/router';
import { RemoteEntry } from './entry';

export const remoteRoutes: Route[] = [
  { path: '', component: RemoteEntry },
  {
    path: 'map',
    loadComponent: () =>
      import('./forecast-map').then((m) => m.ForecastMapComponent),
  },
];
```

The map will be accessible at `/weather-app/map` through the shell's existing route configuration — no changes needed to `apps/shell/src/app/app.routes.ts`.

### 7. Add Leaflet CSS to the build

Leaflet requires its CSS for tile rendering and marker display. Add to `apps/weather-app/project.json` under the `build` target's `styles` array:

```json
"styles": [
  "node_modules/leaflet/dist/leaflet.css",
  "apps/weather-app/src/styles.css"
]
```

Also copy the Leaflet marker icon images or configure the default icon path in the component to avoid the broken-icon issue:

```typescript
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';
L.Marker.prototype.options.icon = L.icon({ iconUrl, shadowUrl });
```

### 8. Add navigation link in the shell or weather-app

Add a "Map View" link/tab in the weather-app entry component or in the shell's navigation so users can switch between the table view and the map view.

## Files to Create/Modify

- **Create** `apps/weather-app/src/app/remote-entry/forecast-map.ts` — map component
- **Modify** `apps/weather-app/src/app/remote-entry/entry.routes.ts` — add `/map` route
- **Modify** `apps/weather-api/Program.cs` — add `/weatherforecast/summary` endpoint
- **Modify** `apps/weather-api/Models/WeatherForecast.cs` — add `Location`, `Latitude`, `Longitude` (prerequisite)
- **Modify** `apps/weather-api/Data/WeatherDbContext.cs` — no changes needed (auto-discovers new properties)
- **Create** EF Core migration for new columns (prerequisite)
- **Modify** `traefik/traefik-dynamic.yml` — add `weather-summary-router` and middleware
- **Modify** `apps/weather-app/project.json` — add Leaflet CSS to styles
- **Modify** `package.json` — add `leaflet`, `@bluehalo/ngx-leaflet`, `@types/leaflet`

## Testing

1. **Unit test**: Create `apps/weather-app/src/app/remote-entry/forecast-map.spec.ts` testing that the component renders markers from mock data. Use `HttpClientTestingModule` to mock the `/weather/summary` response.
2. **API test**: Add a test in `apps/weather-api-tests/` that calls `GET /weatherforecast/summary` with seeded data containing locations and asserts the grouped response shape.
3. **E2e test**: Add a Playwright test in `apps/weather-app-e2e/` that navigates to `/weather-app/map`, waits for the Leaflet map container to render, and asserts at least one marker is visible.
4. **Manual verification**:
   - Seed forecasts with location data for 3+ cities via the API.
   - Navigate to `https://localhost:8443/weather-app/map`.
   - Confirm map tiles load, markers appear at correct positions, and popups display temperature data.
   - Confirm the table view at `/weather-app` still works (no regressions).

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **Leaflet CSS not loaded in MF context** — styles may not be shared correctly across the shell and remote boundaries. | Include Leaflet CSS in the weather-app's own build styles, not the shell's. Test in both dev-server and production (built) modes. |
| **OpenStreetMap tile rate limiting** — OSM tiles have a usage policy requiring a custom User-Agent and limiting heavy use. | For production/heavy use, switch to a self-hosted tile server or a commercial provider (MapTiler, Mapbox). For dev, OSM is fine. |
| **No location data in existing forecasts** — the summary endpoint returns empty if no forecasts have location fields populated. | Seed test data with locations. Update the Minion scheduler to assign locations from the 10-city list so new forecasts always have coordinates. |
| **Large bundle size from Leaflet** — Leaflet adds ~40KB gzip to the bundle. | Lazy-load the map route (already done via `loadComponent`) so the cost is only paid when the user navigates to the map. |
| **Zone-based change detection failure in MF remote** — per `CLAUDE.md`, HTTP callbacks may run outside Angular's zone. | The component uses signals (`signal()`) for all reactive state, which is the correct pattern documented in the project guidelines. |

## Dependencies

- **Hard dependency**: "Add location to WeatherForecast" — without `Location`, `Latitude`, and `Longitude` fields on the model, there is nothing to plot on a map.
- **Beneficial**: "Add humidity and wind speed to WeatherForecast" — these fields could be shown in the marker popup for richer comparison.
- **Beneficial**: "Minion forecast generation guided by historical profiles" — ensures minion-generated forecasts have realistic per-city data to display.

## Estimated Complexity

**Medium** — The API endpoint and Traefik route are straightforward. The main effort is the Leaflet integration (CSS/icon quirks, Angular wrapper setup) and ensuring it works correctly within the Module Federation boundary. The hard prerequisite (location fields + migration) is a separate piece of work.

# Plan: Temperature Trend Sparklines in the weather-app Table

## Goal

Add inline SVG sparkline charts to each row in the weather-app forecast table, showing the 7-day temperature trend for that forecast's location, giving users immediate visual context for whether temperatures are rising or falling.

## Current State

- **weather-app entry component** (`apps/weather-app/src/app/remote-entry/entry.ts`): Renders a table with columns Date, Temp (C), Temp (F), and Summary. Each row shows a single point-in-time forecast. There is no trend visualization. The component fetches all forecasts from `GET /weather` in one call.
- **WeatherForecast model** (`apps/weather-api/Models/WeatherForecast.cs`): Has `Date` (DateOnly) and `TemperatureC` but no `Location` field. Without location, the sparkline cannot distinguish trends per city — it can only show the global 7-day sequence.
- **Repository** (`apps/weather-api/Repositories/EfWeatherForecastRepository.cs`): `GetAllAsync()` returns all rows with no date ordering.
- **Shared UI library** (`libs/shared/ui/src/`): Exports `CardComponent`, `PageHeaderComponent`, `StatusBadgeComponent`. No chart or sparkline component exists.
- **Package dependencies** (`package.json`): No charting library is currently installed. PrimeNG is available but its chart component wraps Chart.js, which is too heavy for inline table cells.

## Implementation Steps

### 1. Add a trend data API endpoint

Add a new endpoint to `apps/weather-api/Program.cs` in the `forecasts` map group:

```csharp
forecasts.MapGet("/trends", async (IWeatherForecastRepository repo) =>
{
    var all = await repo.GetAllAsync();
    var cutoff = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-7));

    // Group by date, take the average temperature per day
    var trends = all
        .Where(f => f.Date >= cutoff)
        .GroupBy(f => f.Date)
        .OrderBy(g => g.Key)
        .Select(g => new { date = g.Key, avgTempC = Math.Round(g.Average(f => f.TemperatureC), 1) })
        .ToList();

    return Results.Ok(trends);
})
.WithName("GetWeatherTrends");
```

Once the "Add location to WeatherForecast" idea is implemented, this endpoint should accept an optional `?location=` query parameter and group by `(location, date)`, returning per-location trend arrays.

### 2. Add a repository method for date-ranged queries (if not already added)

If the historical weather browser plan has already been implemented, reuse `GetByDateRangeAsync`. Otherwise, the trends endpoint can use `GetAllAsync()` with in-memory filtering for now (acceptable given the expected data volume of <10k rows).

### 3. Create a SparklineComponent in the shared UI library

Create `libs/shared/ui/src/lib/sparkline/sparkline.ts`:

```typescript
import { Component, input, computed } from '@angular/core';

@Component({
  selector: 'ui-sparkline',
  standalone: true,
  template: `
    <svg [attr.width]="width()" [attr.height]="height()" [attr.viewBox]="viewBox()">
      @if (normalizedPoints().length > 1) {
        <polyline
          [attr.points]="polylinePoints()"
          fill="none"
          [attr.stroke]="color()"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle
          [attr.cx]="lastPoint().x"
          [attr.cy]="lastPoint().y"
          r="2"
          [attr.fill]="color()"
        />
      }
    </svg>
  `,
  styles: [`
    :host { display: inline-flex; align-items: center; }
    svg { overflow: visible; }
  `],
})
export class SparklineComponent {
  data = input.required<number[]>();
  width = input<number>(80);
  height = input<number>(24);
  color = input<string>('var(--accent)');

  viewBox = computed(() => `0 0 ${this.width()} ${this.height()}`);

  normalizedPoints = computed(() => {
    const values = this.data();
    if (values.length < 2) return [];

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const padding = 2;
    const w = this.width() - padding * 2;
    const h = this.height() - padding * 2;

    return values.map((v, i) => ({
      x: padding + (i / (values.length - 1)) * w,
      y: padding + h - ((v - min) / range) * h,
    }));
  });

  polylinePoints = computed(() =>
    this.normalizedPoints().map(p => `${p.x},${p.y}`).join(' ')
  );

  lastPoint = computed(() => {
    const pts = this.normalizedPoints();
    return pts[pts.length - 1] ?? { x: 0, y: 0 };
  });
}
```

### 4. Export the SparklineComponent from the shared UI library

Edit `libs/shared/ui/src/index.ts`:

```typescript
export { SparklineComponent } from './lib/sparkline/sparkline';
```

### 5. Integrate sparklines into the weather-app table

Edit `apps/weather-app/src/app/remote-entry/entry.ts`:

- Add `SparklineComponent` to the component's `imports` array.
- Add a new signal `trendData = signal<number[]>([])` to hold the 7-day temperature sequence.
- In `ngOnInit()`, after loading forecasts, make a second call to `GET /weather/trends` and store the result.
- Add a new "Trend" column to the table header.
- In each row, render: `<ui-sparkline [data]="trendData()" [color]="trendColor(row.temperatureC)" />`.
- Initially, all rows show the same global trend (since there is no location field). Once location is added, the sparkline data can be per-location.

Add to the template between the Temp (F) and Summary columns:

```html
<th scope="col">7d Trend</th>
```

```html
<td>
  @if (trendData().length > 1) {
    <ui-sparkline [data]="trendData()" [color]="trendColor(row.temperatureC)" />
  } @else {
    <span class="dash">--</span>
  }
</td>
```

Add a helper method:

```typescript
trendColor(temp: number): string {
  if (temp < 0) return '#60a5fa';   // cold blue
  if (temp < 15) return '#22d3ee';  // cool cyan
  if (temp < 25) return '#4ade80';  // mild green
  if (temp < 35) return '#fbbf24';  // warm amber
  return '#f87171';                  // hot red
}
```

### 6. Add client-side caching

The trend data changes infrequently (at most every 15 minutes when minions generate new forecasts). Cache the trend response in a simple service:

Create `apps/weather-app/src/app/services/trend-cache.service.ts`:

```typescript
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { shareReplay, timer, switchMap } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class TrendCacheService {
  private http = inject(HttpClient);

  trends$ = timer(0, 5 * 60 * 1000).pipe(
    switchMap(() => this.http.get<{ date: string; avgTempC: number }[]>('/weather/trends')),
    shareReplay(1),
  );
}
```

Use this service in the RemoteEntry component instead of a raw HTTP call.

## Files to Create/Modify

- **Create**: `libs/shared/ui/src/lib/sparkline/sparkline.ts` — SVG sparkline component
- **Create**: `apps/weather-app/src/app/services/trend-cache.service.ts` — caching service
- **Modify**: `libs/shared/ui/src/index.ts` — export `SparklineComponent`
- **Modify**: `apps/weather-api/Program.cs` — add `/weatherforecast/trends` endpoint
- **Modify**: `apps/weather-app/src/app/remote-entry/entry.ts` — add Trend column with sparkline

## Testing

1. **API test**: Call `GET /weatherforecast/trends` with seeded forecasts spanning 7 days. Verify response is a sorted array of `{ date, avgTempC }` objects.
2. **Component unit test**: Create a spec for `SparklineComponent` that passes `[10, 15, 12, 18, 20, 22, 19]` as data and verifies the SVG contains a `<polyline>` with 7 points and a `<circle>` at the last point.
3. **Visual test**: Start the full stack, create forecasts across multiple dates, navigate to weather-app, and verify sparklines render inline in the table.
4. **Edge cases**: Test with 0 data points (should show `--`), 1 data point (should show `--`), and identical values (flat line, no division by zero).

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Without location, all rows show the same sparkline — low information value | Document this limitation and note the enhancement path. The sparkline infrastructure is still valuable once location is added. |
| SVG rendering performance with many rows (100+) | SVG sparklines are extremely lightweight (7 points each). No performance concern at this scale. If future tables grow to 1000+ rows, virtual scrolling would be needed regardless. |
| Trend endpoint returns no data if the database has fewer than 2 days of forecasts | Show a dash placeholder. The empty state is handled gracefully in the template. |
| The `/weather/trends` path could conflict with future routes | The path is under the existing `/weatherforecast` group with Traefik rewriting. `trends` is a clear, non-conflicting name. |

## Dependencies

- **Hard dependency**: None. The feature works with the current schema using a global (non-location-specific) trend.
- **Strongly benefits from**: "Add location to WeatherForecast" — once location exists, the trends endpoint returns per-location arrays and each table row gets a location-specific sparkline. This is the intended end state.
- **Nice to have first**: "Historical weather browser" — if that plan adds `GetByDateRangeAsync` to the repository, the trends endpoint can reuse it instead of filtering in memory.

## Estimated Complexity

**Medium** — One new API endpoint, one new shared UI component (pure SVG, no external dependencies), one caching service, and template modifications. The sparkline component is reusable across the workspace.

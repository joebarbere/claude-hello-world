# Plan: Historical Weather Browser in weather-app

## Goal

Add a historical weather browser to the weather-app remote, allowing users to query and paginate through past forecast records by date range, surfacing the accumulated CDC data to non-technical users.

## Current State

- **weather-app entry component** (`apps/weather-app/src/app/remote-entry/entry.ts`): Displays a single table of all forecasts returned by `GET /weather`. No filtering, no pagination, no date-range selection. The component uses Angular signals for reactive state and imports `PageHeaderComponent`, `CardComponent`, and `StatusBadgeComponent` from `@org/ui`.
- **weather-app routes** (`apps/weather-app/src/app/remote-entry/entry.routes.ts`): A single route `{ path: '', component: RemoteEntry }`. No "history" route exists.
- **Weather API** (`apps/weather-api/Program.cs`): The `/weatherforecast` group has `GET /` (all forecasts), `GET /{id}`, `POST /`, `PUT /{id}`, `DELETE /{id}`. There is no date-filtered or paginated endpoint.
- **Repository interface** (`apps/weather-api/Repositories/IWeatherForecastRepository.cs`): Exposes `GetAllAsync()` only. No method accepts date-range or pagination parameters.
- **EF Core repository** (`apps/weather-api/Repositories/EfWeatherForecastRepository.cs`): `GetAllAsync()` does `db.WeatherForecasts.ToListAsync()` with no filtering.
- **WeatherForecast model** (`apps/weather-api/Models/WeatherForecast.cs`): Has `Id`, `Date` (DateOnly), `TemperatureC`, `Summary`, and computed `TemperatureF`. No location field yet.
- **Traefik routing** (`traefik/traefik-dynamic.yml`): `/weather` maps to the weather-api via `weather-replace-path` middleware (rewrites to `/weatherforecast`). Sub-paths like `/weather/history` would be caught by `weather-sub-router` and rewritten to `/weatherforecast/history`.
- **Database**: PostgreSQL 17 via EF Core with Npgsql. The `WeatherForecasts` table has an index on `Id` (primary key) but no index on `Date`.

## Implementation Steps

### 1. Add a paginated history method to the repository interface

Edit `apps/weather-api/Repositories/IWeatherForecastRepository.cs`:

```csharp
Task<(IEnumerable<WeatherForecast> Items, int TotalCount)> GetByDateRangeAsync(
    DateOnly from, DateOnly to, int page, int pageSize);
```

### 2. Implement the method in EfWeatherForecastRepository

Edit `apps/weather-api/Repositories/EfWeatherForecastRepository.cs`:

```csharp
public async Task<(IEnumerable<WeatherForecast> Items, int TotalCount)> GetByDateRangeAsync(
    DateOnly from, DateOnly to, int page, int pageSize)
{
    var query = db.WeatherForecasts
        .Where(f => f.Date >= from && f.Date <= to)
        .OrderByDescending(f => f.Date)
        .ThenByDescending(f => f.Id);

    var totalCount = await query.CountAsync();
    var items = await query
        .Skip((page - 1) * pageSize)
        .Take(pageSize)
        .ToListAsync();

    return (items, totalCount);
}
```

### 3. Add a no-op implementation to InMemoryWeatherForecastRepository and RandomWeatherForecastRepository

Both files in `apps/weather-api/Repositories/` need stub implementations that filter their in-memory lists or throw `NotSupportedException`, matching the existing pattern for unsupported operations.

### 4. Register the API endpoint in Program.cs

Edit `apps/weather-api/Program.cs`, add inside the `forecasts` map group:

```csharp
forecasts.MapGet("/history", async (
    DateOnly? from,
    DateOnly? to,
    int? page,
    int? pageSize,
    IWeatherForecastRepository repo) =>
{
    var fromDate = from ?? DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-30));
    var toDate = to ?? DateOnly.FromDateTime(DateTime.UtcNow);
    var p = Math.Max(1, page ?? 1);
    var ps = Math.Clamp(pageSize ?? 50, 1, 200);

    var (items, totalCount) = await repo.GetByDateRangeAsync(fromDate, toDate, p, ps);
    return Results.Ok(new { items, totalCount, page = p, pageSize = ps });
})
.WithName("GetWeatherHistory");
```

### 5. Add a database index on Date for query performance

Create a new EF Core migration that adds an index:

```bash
cd apps/weather-api
dotnet ef migrations add AddDateIndex
```

In the migration `Up` method, add:
```csharp
migrationBuilder.CreateIndex(
    name: "IX_WeatherForecasts_Date",
    table: "WeatherForecasts",
    column: "Date");
```

### 6. Verify Traefik routing

The existing `weather-sub-router` in `traefik/traefik-dynamic.yml` uses `PathPrefix(/weather/)` and rewrites via regex to `/weatherforecast/...`. A request to `/weather/history?from=2026-01-01&to=2026-01-31` will be rewritten to `/weatherforecast/history?from=...&to=...`, which matches the new endpoint. No Traefik config changes needed.

### 7. Create the Angular HistoryComponent

Create `apps/weather-app/src/app/history/history.component.ts`:

- Import `HttpClient`, `signal`, `FormsModule` from Angular.
- Import `PageHeaderComponent`, `CardComponent`, `StatusBadgeComponent` from `@org/ui`.
- Template: date-range picker (two `<input type="date">` fields), a "Search" button, the results table (same column layout as the existing forecast table), and pagination controls (Previous / Next buttons with page N of M display).
- Signals: `results`, `loading`, `error`, `currentPage`, `totalPages`, `fromDate`, `toDate`.
- On init, default `fromDate` to 30 days ago and `toDate` to today.
- `search()` method: calls `GET /weather/history?from=...&to=...&page=...&pageSize=50` and updates signals.
- Reuse the existing `tempVariant()` helper for status badge coloring.
- Style with the same CSS variable conventions used in `entry.ts` (`.page-container`, `.table-wrapper`, etc.).

### 8. Add the history route

Edit `apps/weather-app/src/app/remote-entry/entry.routes.ts`:

```typescript
import { HistoryComponent } from '../history/history.component';

export const remoteRoutes: Route[] = [
  { path: '', component: RemoteEntry },
  { path: 'history', component: HistoryComponent },
];
```

### 9. Add navigation to the history view

Edit the existing `RemoteEntry` template in `apps/weather-app/src/app/remote-entry/entry.ts` to add a "View History" button in the `<ui-page-header>` actions slot, using `routerLink` to navigate to `history`. Add `RouterLink` to the component's imports.

## Files to Create/Modify

- **Create**: `apps/weather-app/src/app/history/history.component.ts`
- **Create**: EF Core migration file for Date index (auto-generated)
- **Modify**: `apps/weather-api/Repositories/IWeatherForecastRepository.cs` — add `GetByDateRangeAsync`
- **Modify**: `apps/weather-api/Repositories/EfWeatherForecastRepository.cs` — implement `GetByDateRangeAsync`
- **Modify**: `apps/weather-api/Repositories/InMemoryWeatherForecastRepository.cs` — stub implementation
- **Modify**: `apps/weather-api/Repositories/RandomWeatherForecastRepository.cs` — stub implementation
- **Modify**: `apps/weather-api/Program.cs` — add `/weatherforecast/history` endpoint
- **Modify**: `apps/weather-app/src/app/remote-entry/entry.routes.ts` — add history route
- **Modify**: `apps/weather-app/src/app/remote-entry/entry.ts` — add "View History" navigation link

## Testing

1. **API unit test**: Call `GET /weatherforecast/history?from=2026-01-01&to=2026-03-01&page=1&pageSize=10` against a seeded database. Verify the response contains `items`, `totalCount`, `page`, and `pageSize`. Verify pagination math (requesting page 2 with 10 items when there are 15 total returns 5 items).
2. **Boundary test**: Call with `from` > `to` — should return empty results. Call with no parameters — should default to last 30 days, page 1, size 50.
3. **E2e test**: In `apps/weather-app-e2e/`, add a Playwright test that navigates to `/weather-app/history`, sets a date range, clicks search, and verifies the table renders rows and pagination controls appear.
4. **Manual verification**: Start the full stack, create several forecasts with different dates via weatheredit-app, then navigate to the history view and confirm date filtering and pagination work.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Large date ranges return too much data, causing slow queries | The 200-row page size cap limits response size. The Date index ensures the query uses an index scan. |
| No forecasts exist in the requested range, confusing UX | Show a clear empty state message: "No forecasts found for this date range." |
| Traefik routing conflict with `/weather/history` vs `/weather/{id}` | The `weather-sub-router` uses regex rewriting. Since `history` is not an integer, the `/{id:int}` route constraint in Program.cs will not match it. The history endpoint is registered as a string path, not a parameterized one. No conflict. |
| The `RandomWeatherForecastRepository` has no persistent data to query | Return an empty result set with a message. This only affects local dev without Postgres. |

## Dependencies

- None strictly required. This works with the current schema.
- **Benefits from**: "Add location to WeatherForecast" — once location exists, the history browser can add a location filter dropdown, making the feature significantly more useful.

## Estimated Complexity

**Medium** — One new API endpoint with pagination logic, one new Angular component, one EF Core migration, and routing changes. No new infrastructure or external service dependencies.

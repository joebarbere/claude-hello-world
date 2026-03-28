# Plan: Quality Score Panel in admin-app

## Goal

Add a "Data Quality" card to the admin-app dashboard that displays the latest quality score from the daily quality report DAG, along with a trend indicator and a link to the raw report in MinIO.

## Current State

- **Quality report DAG** (`apps/datascience/airflow/dags/dag_quality_report.py`): Runs daily at 06:00 UTC. Produces a JSON report with a `quality_score` (0-100), `forecast_count`, `temperature_analysis`, and `label_consistency` fields. Saves to MinIO at `weather-analytics/reports/quality_YYYY-MM-DD.json`.
- **MinIO configuration**: MinIO runs in the datascience pod, accessible at `host.containers.internal:9000` with credentials configured in `k8s/datascience-pod.yaml`. The `weather-analytics` bucket is created by the DAG via `ensure_bucket()` in `apps/datascience/shared/minio_helper.py`.
- **Admin-app dashboard** (`apps/admin-app/src/app/remote-entry/entry.ts`): Displays categorized link cards (API, Identity, Observability, Infrastructure, Automation, Data Science). The Data Science category includes Airflow, Jupyter Lab, and MinIO Console. No quality score display exists.
- **Weather API** (`apps/weather-api/Program.cs`): No endpoint reads from MinIO. The API currently only talks to PostgreSQL. The `WeatherApi.csproj` does not include the MinIO NuGet package.
- **Traefik routing** (`traefik/traefik-dynamic.yml`): No route for a `/quality` or `/api/quality` path.

## Implementation Steps

### 1. Add the MinIO NuGet package to the Weather API

Edit `apps/weather-api/WeatherApi.csproj`:

```xml
<PackageReference Include="Minio" Version="6.*" />
```

### 2. Create a quality report service

Create `apps/weather-api/Services/QualityReportService.cs`:

```csharp
using Minio;
using Minio.DataModel.Args;
using System.Text.Json;

namespace WeatherApi.Services;

public record QualityReport(
    string Date,
    int ForecastCount,
    double? QualityScore,
    string? Message
);

public record QualityTrend(
    QualityReport Current,
    QualityReport? Previous,
    string TrendDirection  // "up", "down", "stable", "unknown"
);

public class QualityReportService
{
    private readonly IMinioClient _minio;
    private const string Bucket = "weather-analytics";

    public QualityReportService(IMinioClient minio)
    {
        _minio = minio;
    }

    public async Task<QualityTrend?> GetLatestWithTrendAsync()
    {
        var today = DateTime.UtcNow;

        // Try today and the last 7 days to find the most recent report
        QualityReport? current = null;
        QualityReport? previous = null;

        for (int i = 0; i <= 7; i++)
        {
            var date = today.AddDays(-i);
            var report = await TryGetReportAsync(date);
            if (report != null)
            {
                if (current == null)
                    current = report;
                else if (previous == null)
                {
                    previous = report;
                    break;
                }
            }
        }

        if (current == null) return null;

        var trend = "unknown";
        if (previous?.QualityScore != null && current.QualityScore != null)
        {
            var diff = current.QualityScore.Value - previous.QualityScore.Value;
            trend = diff > 1 ? "up" : diff < -1 ? "down" : "stable";
        }

        return new QualityTrend(current, previous, trend);
    }

    private async Task<QualityReport?> TryGetReportAsync(DateTime date)
    {
        var objectName = $"reports/quality_{date:yyyy-MM-dd}.json";
        try
        {
            using var ms = new MemoryStream();
            await _minio.GetObjectAsync(new GetObjectArgs()
                .WithBucket(Bucket)
                .WithObject(objectName)
                .WithCallbackStream(stream => stream.CopyTo(ms)));

            ms.Position = 0;
            var doc = await JsonDocument.ParseAsync(ms);
            var root = doc.RootElement;

            return new QualityReport(
                root.GetProperty("date").GetString() ?? date.ToString("yyyy-MM-dd"),
                root.GetProperty("forecast_count").GetInt32(),
                root.TryGetProperty("quality_score", out var qs) && qs.ValueKind != JsonValueKind.Null
                    ? qs.GetDouble() : null,
                root.TryGetProperty("message", out var msg) ? msg.GetString() : null
            );
        }
        catch
        {
            return null;  // Object doesn't exist or MinIO is unreachable
        }
    }
}
```

### 3. Register the MinIO client and service in Program.cs

Edit `apps/weather-api/Program.cs`, add after the repository switch block:

```csharp
// MinIO client for quality reports
var minioEndpoint = builder.Configuration.GetValue<string>("MinioEndpoint") ?? "host.containers.internal:9000";
var minioAccessKey = builder.Configuration.GetValue<string>("MinioAccessKey") ?? "minioadmin";
var minioSecretKey = builder.Configuration.GetValue<string>("MinioSecretKey") ?? "minioadmin";

builder.Services.AddMinio(configureClient => configureClient
    .WithEndpoint(minioEndpoint)
    .WithCredentials(minioAccessKey, minioSecretKey)
    .WithSSL(false)
    .Build());

builder.Services.AddSingleton<QualityReportService>();
```

Add the API endpoint:

```csharp
app.MapGet("/quality/latest", async (QualityReportService svc) =>
{
    var trend = await svc.GetLatestWithTrendAsync();
    return trend is null
        ? Results.NotFound(new { message = "No quality reports found. Run the quality_report DAG first." })
        : Results.Ok(trend);
})
.WithName("GetLatestQualityReport");
```

### 4. Add MinIO configuration to appsettings

Edit `apps/weather-api/appsettings.Development.json`:

```json
{
  "MinioEndpoint": "host.containers.internal:9000",
  "MinioAccessKey": "minioadmin",
  "MinioSecretKey": "minioadmin"
}
```

### 5. Add Traefik routing for the quality endpoint

Edit `traefik/traefik-dynamic.yml`:

```yaml
quality-router:
  rule: "PathPrefix(`/quality`)"
  entryPoints:
    - websecure
  service: weather-api
  priority: 20
  tls: {}
```

### 6. Create the QualityPanelComponent in admin-app

Create `apps/admin-app/src/app/quality-panel/quality-panel.component.ts`:

```typescript
import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CardComponent, StatusBadgeComponent } from '@org/ui';

interface QualityTrend {
  current: { date: string; forecastCount: number; qualityScore: number | null; message: string | null };
  previous: { date: string; forecastCount: number; qualityScore: number | null } | null;
  trendDirection: string;
}

@Component({
  selector: 'app-quality-panel',
  standalone: true,
  imports: [CardComponent, StatusBadgeComponent],
  template: `
    <ui-card>
      <div class="quality-panel">
        <div class="panel-header">
          <span class="panel-title">Data Quality Score</span>
          @if (trend()) {
            <ui-status-badge [variant]="scoreVariant()">
              {{ trend()!.current.date }}
            </ui-status-badge>
          }
        </div>

        @if (loading()) {
          <div class="loading-state">
            <i class="pi pi-spin pi-spinner"></i>
          </div>
        } @else if (error()) {
          <div class="error-state">{{ error() }}</div>
        } @else if (trend()) {
          <div class="score-display">
            <span class="score-value" [style.color]="scoreColor()">
              {{ trend()!.current.qualityScore !== null ? trend()!.current.qualityScore : '--' }}
            </span>
            <span class="score-max">/ 100</span>
            @if (trend()!.trendDirection === 'up') {
              <i class="pi pi-arrow-up trend-up"></i>
            } @else if (trend()!.trendDirection === 'down') {
              <i class="pi pi-arrow-down trend-down"></i>
            } @else if (trend()!.trendDirection === 'stable') {
              <i class="pi pi-minus trend-stable"></i>
            }
          </div>
          <div class="panel-meta">
            {{ trend()!.current.forecastCount }} forecasts evaluated
          </div>
        } @else {
          <div class="empty-state">No quality reports yet. Run the DAG first.</div>
        }
      </div>
    </ui-card>
  `,
  styles: [`
    .quality-panel { padding: 20px; }
    .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .panel-title { font-size: 0.8125rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
    .score-display { display: flex; align-items: baseline; gap: 4px; margin-bottom: 8px; }
    .score-value { font-size: 2.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .score-max { font-size: 1rem; color: var(--text-secondary); }
    .trend-up { color: #4ade80; font-size: 1.25rem; margin-left: 8px; }
    .trend-down { color: #f87171; font-size: 1.25rem; margin-left: 8px; }
    .trend-stable { color: var(--text-secondary); font-size: 1.25rem; margin-left: 8px; }
    .panel-meta { font-size: 0.8125rem; color: var(--text-secondary); }
    .loading-state { padding: 24px; text-align: center; color: var(--text-secondary); }
    .error-state { font-size: 0.8125rem; color: #f87171; }
    .empty-state { font-size: 0.8125rem; color: var(--text-secondary); padding: 12px 0; }
  `],
})
export class QualityPanelComponent implements OnInit {
  private http = inject(HttpClient);

  trend = signal<QualityTrend | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);

  ngOnInit() {
    this.http.get<QualityTrend>('/quality/latest').subscribe({
      next: (data) => {
        this.trend.set(data);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Unable to load quality data.');
        this.loading.set(false);
      },
    });
  }

  scoreVariant(): string {
    const score = this.trend()?.current.qualityScore;
    if (score === null || score === undefined) return 'neutral';
    if (score >= 80) return 'success';
    if (score >= 50) return 'warning';
    return 'danger';
  }

  scoreColor(): string {
    const score = this.trend()?.current.qualityScore;
    if (score === null || score === undefined) return 'var(--text-secondary)';
    if (score >= 80) return '#4ade80';
    if (score >= 50) return '#fbbf24';
    return '#f87171';
  }
}
```

### 7. Integrate the quality panel into the admin-app dashboard

Edit `apps/admin-app/src/app/remote-entry/entry.ts`:

- Import `QualityPanelComponent`.
- Add it to the `imports` array.
- Insert the component in the template after the Data Science section or as a standalone section above the link grid:

```html
<section class="link-section">
  <h2 class="section-title">Data Quality</h2>
  <div class="link-grid">
    <app-quality-panel></app-quality-panel>
  </div>
</section>
```

## Files to Create/Modify

- **Create**: `apps/weather-api/Services/QualityReportService.cs`
- **Create**: `apps/admin-app/src/app/quality-panel/quality-panel.component.ts`
- **Modify**: `apps/weather-api/WeatherApi.csproj` — add Minio NuGet package
- **Modify**: `apps/weather-api/Program.cs` — register MinIO client, QualityReportService, and `/quality/latest` endpoint
- **Modify**: `apps/weather-api/appsettings.Development.json` — add MinIO connection settings
- **Modify**: `traefik/traefik-dynamic.yml` — add quality router
- **Modify**: `apps/admin-app/src/app/remote-entry/entry.ts` — import and render QualityPanelComponent

## Testing

1. **API test (happy path)**: Run the quality report DAG to produce at least one report in MinIO. Call `GET /quality/latest`. Verify response contains `current` with `qualityScore`, `date`, and `forecastCount`, and that `trendDirection` is one of `up`, `down`, `stable`, or `unknown`.
2. **API test (no reports)**: Call `GET /quality/latest` when no reports exist in MinIO. Verify a 404 with a helpful message is returned.
3. **API test (MinIO unreachable)**: Stop MinIO and call the endpoint. Verify the service returns a 404 or 500 gracefully without crashing.
4. **Component test**: Create a spec for `QualityPanelComponent` that mocks the HTTP response and verifies the score, trend arrow, and color are rendered correctly for scores of 90 (green, up arrow), 60 (amber), and 30 (red).
5. **Visual test**: Start the full stack, run the quality report DAG, navigate to `/admin-app/`, and verify the Data Quality card renders with the correct score and trend indicator.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| MinIO is unreachable from the weather-api pod | The `QualityReportService.TryGetReportAsync` catches all exceptions and returns null. The API returns a 404 with a message. The admin-app shows "Unable to load quality data." gracefully. |
| MinIO credentials are hardcoded in appsettings | Use environment variables or the same `.env` pattern as other services. For local dev, the default `minioadmin/minioadmin` credentials are acceptable. |
| Quality report format changes break the JSON parsing | The service uses `JsonDocument` with `TryGetProperty` for optional fields, making it resilient to schema additions. Only `date`, `forecast_count`, and `quality_score` are required. |
| Adding the Minio NuGet package increases the API container image size | The Minio SDK is lightweight (~500KB). Negligible impact. |

## Dependencies

- **Hard dependency**: The `dag_quality_report.py` DAG must have run at least once to produce a report in MinIO. The feature degrades gracefully (404 / empty state) when no reports exist.
- **No dependency** on "Add location to WeatherForecast" or any other pending idea.
- **Benefits from**: "Quality score trend dashboard in Grafana" — the two features complement each other (admin-app for quick glance, Grafana for deep analysis).

## Estimated Complexity

**Small** — One new API service class, one new endpoint, one new Angular component, and minor wiring in the admin-app dashboard. No database changes. The MinIO client integration is the only new external dependency.

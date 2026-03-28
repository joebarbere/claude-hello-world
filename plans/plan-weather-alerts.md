# Plan: Weather Alert Notifications (In-App and Email)

## Goal

Implement a threshold-based weather alert system where users define alert rules (e.g., "notify me when temperature exceeds 40C in New York"), the system evaluates rules against incoming forecasts, and notifications are delivered via in-app toasts and email.

## Current State

- **WeatherForecast model** (`apps/weather-api/Models/WeatherForecast.cs`): Has `Id`, `Date`, `TemperatureC`, `Summary`. No `Location` field — alert definitions referencing a location require the "Add location" idea to be implemented first.
- **Database** (`apps/weather-api/Data/WeatherDbContext.cs`): Registers `DbSet<WeatherForecast>` and `DbSet<Minion>`. No alert-related tables exist.
- **EF Core migrations** (`apps/weather-api/Migrations/`): Two migrations exist (`InitialCreate`, `AddMinions`). A new migration will be needed for the alert tables.
- **Kafka infrastructure** (`apps/kafka/`): Kafka broker, Schema Registry, and Debezium Connect are running. The existing CDC pipeline uses the `weather.public.WeatherForecasts` topic. Creating new topics is straightforward.
- **Airflow** (`apps/datascience/airflow/dags/`): Three DAGs exist. The quality report DAG (`dag_quality_report.py`) already demonstrates the pattern of reading from MinIO/DuckDB and producing JSON output. A new evaluation DAG follows the same structure.
- **Angular apps**: The weather-app (`apps/weather-app/src/app/remote-entry/entry.ts`) and shell (`apps/shell/`) have no toast notification system. PrimeNG is available in the workspace but its `MessageService`/`Toast` module is not currently imported.
- **Traefik** (`traefik/traefik-dynamic.yml`): Routes API calls to weather-api. New endpoints under `/weatherforecast/alerts/...` will be caught by the existing `weather-sub-router`.
- **No WebSocket infrastructure exists**. The Angular apps communicate with the backend exclusively via REST.

## Implementation Steps

### 1. Define the WeatherAlert model

Create `apps/weather-api/Models/WeatherAlert.cs`:

```csharp
using System.ComponentModel.DataAnnotations;

namespace WeatherApi.Models;

public class WeatherAlert
{
    public int Id { get; set; }

    [Required]
    [MaxLength(100)]
    public string Location { get; set; } = string.Empty;

    [Required]
    [MaxLength(30)]
    public string Metric { get; set; } = "TemperatureC";  // TemperatureC, HumidityPercent, WindSpeedKmh

    [Required]
    [MaxLength(5)]
    public string Operator { get; set; } = ">";  // >, <, >=, <=, ==

    public double Threshold { get; set; }

    [MaxLength(200)]
    public string? NotifyEmail { get; set; }

    public bool IsActive { get; set; } = true;

    public DateTime? LastTriggeredAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
```

### 2. Create the AlertNotification model for deduplication

Create `apps/weather-api/Models/AlertNotification.cs`:

```csharp
namespace WeatherApi.Models;

public class AlertNotification
{
    public int Id { get; set; }
    public int AlertId { get; set; }
    public int ForecastId { get; set; }
    public double MetricValue { get; set; }
    public string Channel { get; set; } = "in-app";  // in-app, email
    public DateTime SentAt { get; set; } = DateTime.UtcNow;
}
```

### 3. Register DbSets and create EF Core migration

Edit `apps/weather-api/Data/WeatherDbContext.cs`:

```csharp
public DbSet<WeatherAlert> WeatherAlerts => Set<WeatherAlert>();
public DbSet<AlertNotification> AlertNotifications => Set<AlertNotification>();
```

Generate the migration:

```bash
cd apps/weather-api
dotnet ef migrations add AddWeatherAlerts
```

### 4. Create the alert repository

Create `apps/weather-api/Repositories/IWeatherAlertRepository.cs`:

```csharp
public interface IWeatherAlertRepository
{
    Task<IEnumerable<WeatherAlert>> GetAllAsync();
    Task<IEnumerable<WeatherAlert>> GetActiveAsync();
    Task<WeatherAlert?> GetByIdAsync(int id);
    Task<WeatherAlert> CreateAsync(WeatherAlert alert);
    Task<WeatherAlert?> UpdateAsync(int id, WeatherAlert alert);
    Task<bool> DeleteAsync(int id);
}
```

Create `apps/weather-api/Repositories/EfWeatherAlertRepository.cs` with standard EF Core CRUD, following the same pattern as `EfWeatherForecastRepository.cs`.

### 5. Register alert API endpoints in Program.cs

Edit `apps/weather-api/Program.cs`:

```csharp
var alerts = app.MapGroup("/alerts");

alerts.MapGet("/", async (IWeatherAlertRepository repo) =>
    Results.Ok(await repo.GetAllAsync()))
    .WithName("GetWeatherAlerts");

alerts.MapPost("/", async (WeatherAlert input, IWeatherAlertRepository repo) =>
{
    var created = await repo.CreateAsync(input);
    return Results.Created($"/alerts/{created.Id}", created);
})
.WithName("CreateWeatherAlert");

alerts.MapPut("/{id:int}", async (int id, WeatherAlert input, IWeatherAlertRepository repo) =>
{
    var updated = await repo.UpdateAsync(id, input);
    return updated is null ? Results.NotFound() : Results.Ok(updated);
})
.WithName("UpdateWeatherAlert");

alerts.MapDelete("/{id:int}", async (int id, IWeatherAlertRepository repo) =>
{
    var deleted = await repo.DeleteAsync(id);
    return deleted ? Results.NoContent() : Results.NotFound();
})
.WithName("DeleteWeatherAlert");

// Triggered alerts: recent notifications
alerts.MapGet("/notifications", async (WeatherDbContext db) =>
{
    var cutoff = DateTime.UtcNow.AddHours(-24);
    var recent = await db.AlertNotifications
        .Where(n => n.SentAt >= cutoff)
        .OrderByDescending(n => n.SentAt)
        .Take(50)
        .ToListAsync();
    return Results.Ok(recent);
})
.WithName("GetRecentNotifications");
```

### 6. Add Traefik routing for the alerts API

Edit `traefik/traefik-dynamic.yml` to add a router for `/alerts`:

```yaml
alerts-router:
  rule: "PathPrefix(`/alerts`)"
  entryPoints:
    - websecure
  service: weather-api
  priority: 20
  tls: {}
```

No path rewriting needed since the API endpoint path matches the public path.

### 7. Create a Kafka notification topic

The topic `weather.alerts.notifications` will carry triggered alert events for in-app consumption. Create the topic either via Kafka UI or by adding it to the Kafka pod startup script.

Topic configuration:
- Partitions: 1 (low volume)
- Retention: 7 days
- Cleanup policy: delete

### 8. Create the alert evaluation Airflow DAG

Create `apps/datascience/airflow/dags/dag_alert_evaluation.py`:

- **Schedule**: every 15 minutes (`*/15 * * * *`).
- **Task 1: load_active_alerts** — Call `GET /alerts` (filtered to `isActive=true`) via the weather-api internal URL (`http://host.containers.internal:5221/alerts`).
- **Task 2: load_latest_forecasts** — Call `GET /weatherforecast` to get current forecast data.
- **Task 3: evaluate_alerts** — For each active alert, find the matching forecast(s) by location and check the threshold condition. Apply deduplication: skip if the same (alertId, forecastId) pair was already notified in the last evaluation window (query the notifications endpoint).
- **Task 4: send_notifications** — For each triggered alert:
  - **In-app**: Produce a message to the `weather.alerts.notifications` Kafka topic with the alert details and triggering forecast.
  - **Email**: If `NotifyEmail` is set, use Airflow's `EmailOperator` or `send_email` utility to send a formatted alert email. This requires SMTP configuration in Airflow (set `AIRFLOW__SMTP__*` environment variables in `k8s/datascience-pod.yaml`).
- **Task 5: record_notifications** — POST each sent notification back to the API for deduplication tracking.

DAG dependency graph: `load_active_alerts >> load_latest_forecasts >> evaluate_alerts >> send_notifications >> record_notifications`.

### 9. Add in-app toast notifications to the Angular shell

The shell app (`apps/shell/`) is the host that renders all remote apps. Adding toast notifications at the shell level ensures they appear regardless of which remote is active.

Option A (simple polling):
- Create a `NotificationService` in the shell that polls `GET /alerts/notifications` every 60 seconds.
- Track the last-seen notification ID in localStorage.
- When new notifications appear, show a PrimeNG `Toast` or a custom toast component.

Option B (Kafka SSE bridge — more complex):
- Add a small Server-Sent Events (SSE) endpoint to the weather-api that consumes from the `weather.alerts.notifications` Kafka topic and streams events to connected clients.
- The Angular shell subscribes to the SSE endpoint via `EventSource`.

**Recommended**: Start with Option A (polling). It requires no new infrastructure and the 60-second delay is acceptable for weather alerts.

### 10. Create a toast component (if not using PrimeNG)

If PrimeNG Toast is not wired into the shell, create a lightweight custom toast:

Create `libs/shared/ui/src/lib/toast/toast.ts`:

- A component that renders a fixed-position notification in the top-right corner.
- Inputs: `message`, `severity` (info, warning, danger), `duration` (auto-dismiss after N seconds).
- Uses CSS animations for slide-in/fade-out.

Export from `libs/shared/ui/src/index.ts`.

### 11. Add alert management UI to admin-app

Create `apps/admin-app/src/app/alerts/alerts.component.ts`:

- Table listing all alert definitions (location, metric, operator, threshold, active status, last triggered).
- Form to create/edit alerts (similar to the weatheredit-app form pattern).
- Toggle button to activate/deactivate alerts.
- Delete with confirmation (same pattern as weatheredit-app).

Add the route in `apps/admin-app/src/app/remote-entry/entry.routes.ts`:

```typescript
{ path: 'alerts', component: AlertsComponent },
```

Add a link card in the admin-app dashboard (`entry.ts`) under a new "Alerts" category.

## Files to Create/Modify

- **Create**: `apps/weather-api/Models/WeatherAlert.cs`
- **Create**: `apps/weather-api/Models/AlertNotification.cs`
- **Create**: `apps/weather-api/Repositories/IWeatherAlertRepository.cs`
- **Create**: `apps/weather-api/Repositories/EfWeatherAlertRepository.cs`
- **Create**: EF Core migration (auto-generated)
- **Create**: `apps/datascience/airflow/dags/dag_alert_evaluation.py`
- **Create**: `apps/admin-app/src/app/alerts/alerts.component.ts`
- **Create**: `libs/shared/ui/src/lib/toast/toast.ts` (if not using PrimeNG)
- **Modify**: `apps/weather-api/Data/WeatherDbContext.cs` — add DbSets
- **Modify**: `apps/weather-api/Program.cs` — add alert and notification endpoints
- **Modify**: `traefik/traefik-dynamic.yml` — add alerts router
- **Modify**: `apps/admin-app/src/app/remote-entry/entry.routes.ts` — add alerts route
- **Modify**: `apps/admin-app/src/app/remote-entry/entry.ts` — add alerts link card
- **Modify**: `apps/shell/` — add notification polling service and toast rendering
- **Modify**: `libs/shared/ui/src/index.ts` — export toast component
- **Modify**: `k8s/datascience-pod.yaml` — add SMTP configuration for email notifications (optional)

## Testing

1. **API tests**: CRUD operations on `/alerts` — create, list, update, delete. Verify validation (invalid operator rejected, threshold is numeric).
2. **Evaluation DAG test**: Seed the database with a forecast where TemperatureC = 45 and an alert rule "TemperatureC > 40". Trigger the DAG manually. Verify a notification is created and the `LastTriggeredAt` field is updated.
3. **Deduplication test**: Run the evaluation DAG twice without changing the forecast. Verify only one notification is sent (the second run detects the existing notification and skips).
4. **Email test**: Configure Airflow SMTP with a test mailbox (e.g., Mailpit container for local dev). Create an alert with `NotifyEmail` set. Trigger it and verify the email arrives.
5. **Toast test**: With the Angular shell running, create a forecast that triggers an alert. Wait up to 60 seconds and verify the toast notification appears in the browser.
6. **Admin UI test**: Navigate to `/admin-app/alerts`, create a new alert rule, verify it appears in the list, toggle it off, delete it.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| No location field on WeatherForecast yet — alerts cannot target specific cities | Phase 1: alerts match on temperature globally (all forecasts). Phase 2: add location filtering after the "Add location" idea is done. The alert model already has a `Location` field ready. |
| Email delivery requires SMTP configuration — adds operational complexity | Make email optional. If SMTP is not configured, the DAG logs a warning and skips email, sending only in-app notifications. |
| Polling every 60 seconds is wasteful if no alerts are active | The notifications endpoint is lightweight (single indexed query). Polling could be reduced to every 5 minutes if needed, or gated by checking if any alerts exist first. |
| Alert evaluation DAG every 15 minutes may miss rapidly changing conditions | 15 minutes is appropriate for a weather platform. Sub-minute alerting would require a streaming architecture (Kafka Streams / Flink), which is out of scope. |
| Kafka topic creation requires manual intervention | Document the topic creation step. Alternatively, use `auto.create.topics.enable=true` on the broker (already common in dev setups). |

## Dependencies

- **Hard dependency**: "Add location to WeatherForecast" — without location, alerts can only match globally, which severely limits usefulness. The alert model includes `Location` from the start, but evaluation logic must handle the case where forecasts have no location yet.
- **Benefits from**: "Add humidity and wind speed to WeatherForecast" — enables alerts on metrics beyond temperature.
- **Benefits from**: "Use Postgres for Airflow metadata" — the evaluation DAG benefits from LocalExecutor for faster task execution, though it works fine on SequentialExecutor.

## Estimated Complexity

**Large** — This spans the full stack: new database tables and migration, new API endpoints, a new Airflow DAG, Kafka topic creation, Angular notification service, toast UI component, and admin management UI. Recommend splitting into phases:
- **Phase 1**: Alert model, API, admin UI, and manual triggering (Medium).
- **Phase 2**: Evaluation DAG and in-app toasts (Medium).
- **Phase 3**: Email notifications (Small).

# Plan: Profile-Guided Minion Forecast Generation

## Goal

Replace the fully random forecast generation in `MinionSchedulerService` with statistically realistic sampling driven by `weather_profiles_v1.json` from MinIO, so minion-generated forecasts match historical weather patterns and the quality score from `dag_quality_report.py` improves measurably.

## Current State

- **Minion scheduler**: `apps/weather-api/Services/MinionSchedulerService.cs` generates forecasts in `GenerateRandomForecast()` (line 115):
  - Temperature: `Random.Shared.Next(-20, 55)` -- uniform random, no seasonal or geographic awareness.
  - Summary: randomly chosen from the 10-element `Summaries` array, independent of temperature.
  - No humidity or wind fields (those depend on plan-add-humidity-wind.md).
- **Weather profiles**: Notebook 04 (`apps/datascience/jupyter/notebooks/04_weather_profiles.ipynb`) produces `weather_profiles_v1.json` and uploads it to MinIO at `weather-analytics/profiles/weather_profiles_v1.json`. The profile structure per city per month:
  ```json
  {
    "temp_mean": 0.5,
    "temp_std": 4.8,
    "temp_min": -15.2,
    "temp_max": 12.1,
    "day_count": 150,
    "labels": {
      "Freezing": 0.25,
      "Bracing": 0.30,
      ...
    }
  }
  ```
- **Quality report**: `apps/datascience/airflow/dags/dag_quality_report.py` scores forecasts 0-100 based on temperature z-scores and label consistency. Currently the score is expected to be low because minions generate random data.
- **MinIO access**: No MinIO SDK is currently referenced in `apps/weather-api/WeatherApi.csproj`. The .NET API connects to PostgreSQL via EF Core and has no direct MinIO/S3 integration.
- **NuGet packages**: `apps/weather-api/WeatherApi.csproj` has `Cronos`, `Npgsql.EntityFrameworkCore.PostgreSQL`, `prometheus-net.AspNetCore`, `Scalar.AspNetCore`, and EF Core Design tooling. No MinIO or AWS S3 SDK.
- **MinIO credentials**: Used in Airflow DAGs and Jupyter notebooks via the shared `minio_helper.py`. The MinIO endpoint, access key, and secret key are configured via environment variables (`MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`).

## Implementation Steps

### 1. Add the MinIO .NET SDK NuGet package

**File**: `apps/weather-api/WeatherApi.csproj`

Add the Minio NuGet package:

```xml
<PackageReference Include="Minio" Version="6.*" />
```

Run `dotnet restore` from the `apps/weather-api/` directory.

### 2. Create a WeatherProfile model and service

**Create file**: `apps/weather-api/Models/WeatherProfile.cs`

Define C# models to deserialize the profile JSON:

```csharp
namespace WeatherApi.Models;

public class MonthProfile
{
    public double TempMean { get; set; }
    public double TempStd { get; set; }
    public double TempMin { get; set; }
    public double TempMax { get; set; }
    public int DayCount { get; set; }
    public Dictionary<string, double> Labels { get; set; } = new();
}
```

**Create file**: `apps/weather-api/Services/WeatherProfileService.cs`

This service downloads the profile from MinIO, caches it in memory, and refreshes daily:

```csharp
using System.Text.Json;
using Minio;
using Minio.DataModel.Args;
using WeatherApi.Models;

namespace WeatherApi.Services;

public class WeatherProfileService : IHostedService, IDisposable
{
    private readonly IMinioClient _minio;
    private readonly ILogger<WeatherProfileService> _logger;
    private Timer? _refreshTimer;

    private const string Bucket = "weather-analytics";
    private const string ObjectKey = "profiles/weather_profiles_v1.json";
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromHours(24);

    // Thread-safe cached profile: location -> month (as string) -> MonthProfile
    private volatile Dictionary<string, Dictionary<string, MonthProfile>>? _profile;

    public WeatherProfileService(IMinioClient minio, ILogger<WeatherProfileService> logger)
    {
        _minio = minio;
        _logger = logger;
    }

    public Dictionary<string, Dictionary<string, MonthProfile>>? Profile => _profile;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await RefreshProfile();
        _refreshTimer = new Timer(_ => _ = RefreshProfile(), null, RefreshInterval, RefreshInterval);
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _refreshTimer?.Change(Timeout.Infinite, 0);
        return Task.CompletedTask;
    }

    private async Task RefreshProfile()
    {
        try
        {
            using var ms = new MemoryStream();
            var args = new GetObjectArgs()
                .WithBucket(Bucket)
                .WithObject(ObjectKey)
                .WithCallbackStream(stream => stream.CopyTo(ms));
            await _minio.GetObjectAsync(args);

            ms.Position = 0;
            var options = new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
                PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            };
            var profile = JsonSerializer.Deserialize<
                Dictionary<string, Dictionary<string, MonthProfile>>
            >(ms, options);

            _profile = profile;
            _logger.LogInformation(
                "Loaded weather profile: {Count} locations",
                profile?.Count ?? 0
            );
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to load weather profile from MinIO — using fallback");
        }
    }

    public void Dispose() => _refreshTimer?.Dispose();
}
```

### 3. Register MinIO client and profile service in DI

**File**: `apps/weather-api/Program.cs`

Inside the `case "EfCore":` block (after registering the minion scheduler), add:

```csharp
// MinIO client for profile downloads
var minioEndpoint = builder.Configuration.GetValue<string>("MinioEndpoint") ?? "localhost:9000";
var minioAccessKey = builder.Configuration.GetValue<string>("MinioAccessKey") ?? "minioadmin";
var minioSecretKey = builder.Configuration.GetValue<string>("MinioSecretKey") ?? "minioadmin";

builder.Services.AddMinio(configureClient => configureClient
    .WithEndpoint(minioEndpoint)
    .WithCredentials(minioAccessKey, minioSecretKey)
    .WithSSL(false)
    .Build());

builder.Services.AddSingleton<WeatherProfileService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<WeatherProfileService>());
```

The `WeatherProfileService` is registered as a singleton so the `MinionSchedulerService` can inject it to access the cached profile.

### 4. Update MinionSchedulerService to use the profile

**File**: `apps/weather-api/Services/MinionSchedulerService.cs`

Inject the profile service:

```csharp
public class MinionSchedulerService(
    IServiceScopeFactory scopeFactory,
    WeatherProfileService profileService,
    ILogger<MinionSchedulerService> logger) : BackgroundService
```

Replace `GenerateRandomForecast` with a profile-aware version:

```csharp
private WeatherForecast GenerateProfileForecast(string minionName)
{
    var profile = profileService.Profile;
    var month = DateTime.UtcNow.Month.ToString();

    // Pick a random location from the profile, or fall back to random
    if (profile is not null && profile.Count > 0)
    {
        var locations = profile.Keys.ToList();
        var location = locations[Random.Shared.Next(locations.Count)];
        var monthProfile = profile[location].GetValueOrDefault(month);

        if (monthProfile is not null)
        {
            var tempC = SampleTruncatedNormal(
                monthProfile.TempMean,
                monthProfile.TempStd,
                monthProfile.TempMin,
                monthProfile.TempMax
            );

            var summary = SampleWeightedLabel(monthProfile.Labels);

            return new WeatherForecast
            {
                Date = DateOnly.FromDateTime(DateTime.Now.AddDays(Random.Shared.Next(1, 10))),
                TemperatureC = (int)Math.Round(tempC),
                Summary = $"[Minion: {minionName}] {summary}",
                // If Location field exists (from plan-add-location-field):
                // Location = location,
            };
        }
    }

    // Fallback: original random behavior
    return GenerateRandomForecast(minionName);
}
```

Add the truncated normal sampling method:

```csharp
/// <summary>
/// Sample from a normal distribution, clipped to [min, max].
/// Uses the Box-Muller transform to generate a standard normal variate,
/// then scales and clips it.
/// </summary>
private static double SampleTruncatedNormal(double mean, double std, double min, double max)
{
    // Box-Muller transform
    double u1 = 1.0 - Random.Shared.NextDouble(); // (0, 1] to avoid log(0)
    double u2 = Random.Shared.NextDouble();
    double stdNormal = Math.Sqrt(-2.0 * Math.Log(u1)) * Math.Sin(2.0 * Math.PI * u2);

    double value = mean + std * stdNormal;
    return Math.Clamp(value, min, max);
}
```

Add the weighted label sampling method:

```csharp
/// <summary>
/// Select a label based on weighted probabilities from the profile.
/// </summary>
private static string SampleWeightedLabel(Dictionary<string, double> labelProbabilities)
{
    double roll = Random.Shared.NextDouble();
    double cumulative = 0;

    foreach (var (label, probability) in labelProbabilities)
    {
        cumulative += probability;
        if (roll <= cumulative)
            return label;
    }

    // Fallback (shouldn't happen if probabilities sum to 1.0)
    return labelProbabilities.Keys.Last();
}
```

Update the `ProcessActiveMinions` method to call `GenerateProfileForecast` instead of `GenerateRandomForecast`:

```csharp
var forecast = GenerateProfileForecast(minion.Name);
```

### 5. Add MinIO configuration to the pod YAML

The weather-api container needs MinIO connection details. Add environment variables to the relevant pod YAML (likely `k8s/apps-pod.yaml` or equivalent):

```yaml
- name: MinioEndpoint
  value: "host.containers.internal:9000"
- name: MinioAccessKey
  value: "minioadmin"
- name: MinioSecretKey
  value: "minioadmin"
```

These match the credentials used by the datascience stack.

### 6. Add graceful degradation

The profile may not be available (MinIO down, profile not yet generated by Notebook 04). The implementation must handle this gracefully:

- `WeatherProfileService.Profile` returns `null` if loading failed.
- `GenerateProfileForecast` falls back to the original random generation when the profile is null.
- Log a warning on startup if the profile cannot be loaded, but do not crash.

This is already handled in the code above via the `if (profile is not null)` guard.

### 7. Validate quality score improvement

After deploying, the quality score should improve. To measure:

1. Record the current baseline quality score by triggering `weather_quality_report` DAG.
2. Deploy the profile-guided minion changes.
3. Let minions generate forecasts for 24 hours.
4. Trigger the quality report DAG again.
5. Compare scores. Expected improvement:
   - Temperature z-scores should drop (forecasts closer to historical means).
   - Label violations should drop to near zero (labels now match temperature).
   - Overall quality score should increase from the baseline (likely < 50) to > 80.

## Files to Create/Modify

- **Modify**: `apps/weather-api/WeatherApi.csproj` -- add `Minio` NuGet package
- **Create**: `apps/weather-api/Models/WeatherProfile.cs` -- MonthProfile model for deserialization
- **Create**: `apps/weather-api/Services/WeatherProfileService.cs` -- MinIO download, caching, refresh
- **Modify**: `apps/weather-api/Program.cs` -- register MinIO client and WeatherProfileService in DI
- **Modify**: `apps/weather-api/Services/MinionSchedulerService.cs` -- inject profile service, add SampleTruncatedNormal, SampleWeightedLabel, GenerateProfileForecast
- **Modify**: Pod YAML (e.g., `k8s/apps-pod.yaml`) -- add MinIO env vars for the weather-api container

## Testing

1. **Unit test SampleTruncatedNormal**: Generate 10,000 samples with known mean/std/min/max. Verify the sample mean is within 0.5 of the expected mean, no values exceed min/max bounds.
2. **Unit test SampleWeightedLabel**: With probabilities `{"A": 0.7, "B": 0.2, "C": 0.1}`, generate 10,000 samples and verify proportions are within 5% of expected.
3. **Integration test -- profile loading**: Start the weather-api with MinIO running and the profile uploaded. Verify `WeatherProfileService.Profile` is non-null and contains the expected locations and months.
4. **Integration test -- fallback**: Start the weather-api with MinIO down. Verify the service starts without crashing and minions fall back to random generation. Check logs for the warning.
5. **End-to-end quality validation**:
   - Trigger a minion to generate 100 forecasts.
   - Run the quality report DAG.
   - Assert quality score > 70 (profile-guided forecasts should score well).
6. **Manual smoke test**: Query the database for recent minion-generated forecasts. Verify temperatures cluster around seasonal means (e.g., January forecasts for New York should be near 0 C, not randomly scattered between -20 and 55).
7. **JSON deserialization**: Verify the C# `MonthProfile` correctly maps the snake_case JSON keys (`temp_mean`, `temp_std`, etc.) using `JsonNamingPolicy.SnakeCaseLower`.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| MinIO is unreachable at startup | Profile is null, minions generate random data | Graceful fallback to random generation. Log a warning. Retry on the daily refresh timer. |
| Profile JSON format changes (new version) | Deserialization fails | Use `JsonSerializerOptions` with `PropertyNameCaseInsensitive = true` and ignore unknown fields. Version the profile object key (`v1`, `v2`). |
| Box-Muller transform edge cases | NaN or Infinity from `Math.Log(0)` | Use `1.0 - NextDouble()` to ensure input is in `(0, 1]` range. `Math.Clamp` provides final safety. |
| Minio NuGet version conflicts | Build failure | Pin to a specific major version (`6.*`). Test the build after adding the package. |
| Profile cached indefinitely if refresh fails | Stale data after profile update | The `RefreshProfile` method catches exceptions and keeps the existing cache. The 24h timer ensures periodic retries. Add a log entry on refresh failure. |
| Label probabilities don't sum to exactly 1.0 due to rounding | `SampleWeightedLabel` never reaches the last label | The fallback `return labelProbabilities.Keys.Last()` handles this. |
| Temperature and label are now correlated but not jointly sampled | A "Freezing" label could be paired with a 25 C temp if profile data is sparse | After sampling temperature, verify the label is consistent: pick the label whose temperature range includes the sampled temperature. Alternatively, sample label first, then sample temperature conditional on the label range. |

## Dependencies

- **Required**: `weather_profiles_v1.json` must exist in MinIO. This is produced by running Notebook 04 (`apps/datascience/jupyter/notebooks/04_weather_profiles.ipynb`). Without it, minions fall back to random generation (no crash, but no improvement).
- **Strongly recommended**: "Add Location to WeatherForecast" (plan-add-location-field.md) -- without a Location field on the model, the scheduler picks a random city for each forecast but cannot record which city it chose. The forecast loses its geographic context.
- **Nice to have**: "Add Humidity and Wind Speed" (plan-add-humidity-wind.md) -- once humidity/wind fields exist on the model, the profile-guided generation can be extended to sample humidity from seasonal norms (requires extending `weather_profiles_v1.json` with humidity/wind statistics in a future Notebook 04 update).

## Estimated Complexity

**Medium** -- The core algorithm (truncated normal sampling, weighted label selection) is straightforward. The main complexity is the MinIO SDK integration (new dependency, DI registration, async download, caching) and ensuring graceful degradation. No database migration is required for this change.

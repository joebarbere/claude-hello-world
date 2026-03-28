# Plan: Add HumidityPercent and WindSpeedKmh to WeatherForecast

## Goal

Add `HumidityPercent` (int, 0-100) and `WindSpeedKmh` (decimal, 0-400) fields to the `WeatherForecast` model so the platform can store richer meteorological data and the minion scheduler can generate more realistic multi-dimensional forecasts.

## Current State

- **Model**: `apps/weather-api/Models/WeatherForecast.cs` has `Id`, `Date`, `TemperatureC`, `Summary`. No humidity or wind fields.
- **Minion scheduler**: `apps/weather-api/Services/MinionSchedulerService.cs` generates random forecasts in `GenerateRandomForecast()` (line 115) with only `Date`, `TemperatureC`, and `Summary`. The Summaries array maps to temperature labels but there is no weather condition richness.
- **Repository**: `apps/weather-api/Repositories/EfWeatherForecastRepository.cs` -- `UpdateAsync` explicitly maps `Date`, `TemperatureC`, `Summary`.
- **weatheredit-app form**: `apps/weatheredit-app/src/app/remote-entry/entry.ts` -- `ForecastFormData` has `date`, `temperatureC`, `summary`. The form grid uses `grid-template-columns: repeat(3, 1fr)`.
- **weather-app table**: `apps/weather-app/src/app/remote-entry/entry.ts` -- displays Date, Temp C, Temp F, Summary in four columns.
- **CDC pipeline**: DuckDB schema in `apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py` has `id, date, temperature_c, summary` columns.
- **Quality report**: `apps/datascience/airflow/dags/dag_quality_report.py` only evaluates temperature z-scores and label consistency. No humidity/wind checks.
- **Weather profiles**: Notebook 04 (`apps/datascience/jupyter/notebooks/04_weather_profiles.ipynb`) produces `weather_profiles_v1.json` with per-city per-month `temp_mean`, `temp_std`, `temp_min`, `temp_max`, and label probabilities. No humidity/wind statistics yet.

## Implementation Steps

### 1. Update the WeatherForecast model

**File**: `apps/weather-api/Models/WeatherForecast.cs`

Add two nullable properties with validation attributes:

```csharp
[Range(0, 100)]
public int? HumidityPercent { get; set; }

[Range(0, 400)]
[Column(TypeName = "numeric(5,1)")]
public decimal? WindSpeedKmh { get; set; }
```

Both are nullable for backward compatibility. `WindSpeedKmh` uses `decimal` with `numeric(5,1)` to allow one decimal place (e.g., 15.3 km/h). The `[Range]` attributes provide server-side validation.

### 2. Create an EF Core migration

Run from `apps/weather-api/`:

```bash
dotnet ef migrations add AddHumidityAndWindSpeed
```

Generated migration adds:
- `HumidityPercent` (integer, nullable)
- `WindSpeedKmh` (numeric(5,1), nullable)

If this is combined with the Location field change, use a single migration:
```bash
dotnet ef migrations add AddLocationHumidityWindSpeed
```

### 3. Update the EF repository

**File**: `apps/weather-api/Repositories/EfWeatherForecastRepository.cs`

In `UpdateAsync`, add:

```csharp
existing.HumidityPercent = forecast.HumidityPercent;
existing.WindSpeedKmh = forecast.WindSpeedKmh;
```

### 4. Update the Minion scheduler

**File**: `apps/weather-api/Services/MinionSchedulerService.cs`

Update `GenerateRandomForecast()` to produce humidity and wind values:

```csharp
private static WeatherForecast GenerateRandomForecast(string minionName)
{
    var tempC = Random.Shared.Next(-20, 55);
    return new WeatherForecast
    {
        Date = DateOnly.FromDateTime(DateTime.Now.AddDays(Random.Shared.Next(1, 10))),
        TemperatureC = tempC,
        Summary = $"[Minion: {minionName}] {Summaries[Random.Shared.Next(Summaries.Length)]}",
        HumidityPercent = Random.Shared.Next(10, 100),
        WindSpeedKmh = Math.Round((decimal)(Random.Shared.NextDouble() * 80), 1),
    };
}
```

This is a naive random approach. The profile-guided improvement (plan-profile-guided-minions.md) will replace this with statistically realistic sampling. However, having the fields present and populated with any values is valuable for testing the full pipeline immediately.

### 5. Update the CDC-to-DuckDB DAG

**File**: `apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py`

Update the DDL:

```sql
CREATE TABLE IF NOT EXISTS weather_forecasts_cdc (
    id              INTEGER PRIMARY KEY,
    date            DATE,
    temperature_c   INTEGER,
    summary         VARCHAR,
    humidity_pct    INTEGER,
    wind_speed_kmh  DECIMAL(5,1),
    op              VARCHAR,
    event_ts        TIMESTAMP,
    loaded_at       TIMESTAMP
);
```

Add DuckDB migration for existing files:

```python
con.execute("ALTER TABLE weather_forecasts_cdc ADD COLUMN IF NOT EXISTS humidity_pct INTEGER")
con.execute("ALTER TABLE weather_forecasts_cdc ADD COLUMN IF NOT EXISTS wind_speed_kmh DECIMAL(5,1)")
```

Update the upsert in `_load_batch_to_duckdb`:

```python
humidity = after.get("HumidityPercent")
wind_speed = after.get("WindSpeedKmh")

con.execute(
    """
    INSERT OR REPLACE INTO weather_forecasts_cdc
        (id, date, temperature_c, summary, humidity_pct, wind_speed_kmh, op, event_ts, loaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """,
    [row_id, date_str, temp_c, summary, humidity, wind_speed, op, event_ts, loaded_at],
)
```

Also update the `_DDL_DAILY_SUMMARY` view to include aggregates:

```sql
CREATE OR REPLACE VIEW daily_summary AS
SELECT
    date,
    COUNT(*)                        AS forecast_count,
    AVG(temperature_c)              AS avg_temp_c,
    MIN(temperature_c)              AS min_temp_c,
    MAX(temperature_c)              AS max_temp_c,
    AVG(humidity_pct)               AS avg_humidity_pct,
    AVG(wind_speed_kmh)             AS avg_wind_speed_kmh,
    COUNT(CASE WHEN op = 'd' THEN 1 END) AS delete_count
FROM weather_forecasts_cdc
GROUP BY date
ORDER BY date;
```

### 6. Update the quality report DAG

**File**: `apps/datascience/airflow/dags/dag_quality_report.py`

Add validation checks for the new fields:

- **Humidity range check**: flag forecasts with humidity outside 0-100.
- **Wind speed range check**: flag forecasts with wind > 200 km/h (extremely rare in real weather).
- **Cross-field consistency**: high wind speed (> 60 km/h) with "Balmy" summary is suspicious.

Update the `_load_recent_forecasts` query to select `humidity_pct` and `wind_speed_kmh`.

Add to the quality score calculation:

```python
# Check 3: Humidity range
if humidity is not None and (humidity < 0 or humidity > 100):
    humidity_violations.append(...)

# Check 4: Wind speed plausibility
if wind_speed is not None and wind_speed > 200:
    wind_anomalies.append(...)
```

### 7. Update the weather-app display

**File**: `apps/weather-app/src/app/remote-entry/entry.ts`

Add fields to the interface:

```typescript
interface WeatherForecast {
  date: string;
  temperatureC: number;
  temperatureF: number;
  summary: string | null;
  humidityPercent: number | null;
  windSpeedKmh: number | null;
}
```

Add table columns after Temp F:

```html
<th scope="col">Humidity</th>
<th scope="col">Wind (km/h)</th>
...
<td class="cell-temp muted">{{ row.humidityPercent !== null ? row.humidityPercent + '%' : '—' }}</td>
<td class="cell-temp muted">{{ row.windSpeedKmh !== null ? row.windSpeedKmh : '—' }}</td>
```

### 8. Update the weatheredit-app form and table

**File**: `apps/weatheredit-app/src/app/remote-entry/entry.ts`

Add to interfaces:

```typescript
interface ForecastFormData {
  date: string;
  temperatureC: number;
  summary: string;
  humidityPercent: number | null;
  windSpeedKmh: number | null;
}
```

Add form inputs with validation:

```html
<div class="form-group">
  <label for="humidity">Humidity (%)</label>
  <input id="humidity" type="number" class="form-input"
    [(ngModel)]="formData.humidityPercent" name="humidityPercent"
    min="0" max="100" placeholder="0-100" />
</div>
<div class="form-group">
  <label for="wind">Wind (km/h)</label>
  <input id="wind" type="number" class="form-input"
    [(ngModel)]="formData.windSpeedKmh" name="windSpeedKmh"
    min="0" max="400" step="0.1" placeholder="0-400" />
</div>
```

Update the form grid to accommodate more fields. Either expand to `repeat(5, 1fr)` or use two rows with `repeat(3, 1fr)`.

Add table columns for humidity and wind in the edit table display.

Update `openCreate()` and `openEdit()` to initialize/populate the new fields.

## Files to Create/Modify

- **Modify**: `apps/weather-api/Models/WeatherForecast.cs` -- add HumidityPercent, WindSpeedKmh
- **Create**: `apps/weather-api/Migrations/<timestamp>_AddHumidityAndWindSpeed.cs` -- auto-generated migration
- **Modify**: `apps/weather-api/Repositories/EfWeatherForecastRepository.cs` -- map new fields in UpdateAsync
- **Modify**: `apps/weather-api/Services/MinionSchedulerService.cs` -- generate random humidity/wind values
- **Modify**: `apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py` -- DDL, upsert, daily_summary view
- **Modify**: `apps/datascience/airflow/dags/dag_quality_report.py` -- new validation checks
- **Modify**: `apps/weather-app/src/app/remote-entry/entry.ts` -- interface + table columns
- **Modify**: `apps/weatheredit-app/src/app/remote-entry/entry.ts` -- interface + form fields + table columns

## Testing

1. **Migration**: Run `dotnet ef database update`. Verify columns with `\d "WeatherForecasts"` -- expect `HumidityPercent integer NULL` and `WindSpeedKmh numeric(5,1) NULL`.
2. **API validation**: POST a forecast with `humidityPercent: 150`. Expect a 400 Bad Request due to the `[Range(0, 100)]` attribute.
3. **API validation**: POST with `windSpeedKmh: -5`. Expect rejection.
4. **Minion output**: Start a minion and verify generated forecasts include non-null humidity and wind values in the database.
5. **CDC pipeline**: Create a forecast via the API. Trigger `kafka_cdc_to_duckdb` DAG. Query DuckDB and confirm `humidity_pct` and `wind_speed_kmh` columns are populated.
6. **Quality report**: Trigger `weather_quality_report` DAG. Verify the report JSON includes humidity and wind analysis sections.
7. **weather-app**: Load the UI table. Confirm Humidity and Wind columns appear. Existing forecasts without these fields show "---".
8. **weatheredit-app**: Create a forecast with all fields filled. Edit it. Confirm values round-trip correctly.
9. **Backward compat**: Confirm existing forecasts (with NULL humidity/wind) display gracefully in all UIs and do not cause errors in the CDC pipeline.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Decimal precision mismatch | Wind speed stored as integer when decimal expected | Use `[Column(TypeName = "numeric(5,1)")]` annotation and verify the migration output. |
| Table too wide on mobile | weatheredit-app table overflows horizontally | The existing `table-wrapper` has `overflow-x: auto`. Consider hiding wind/humidity columns on narrow screens with a CSS media query. |
| Minion random wind values unrealistic | Quality scores do not improve | This is expected -- random generation is a placeholder. Profile-guided generation (plan-profile-guided-minions.md) addresses this. |
| Two-phase Avro schema evolution | If Location and Humidity/Wind are added separately, two schema versions are created in quick succession | Batch both changes into one migration to produce a single schema evolution. |

## Dependencies

- **Optional but recommended**: "Add Location to WeatherForecast" (plan-add-location-field.md) -- batching both into one migration reduces schema evolution churn. Not a hard dependency; humidity/wind can be added independently.
- **Unlocks**: "Profile-guided minion forecasts" (plan-profile-guided-minions.md) -- the minion scheduler needs these fields to exist before it can populate them with profile-driven values.
- **Enhances**: The quality report will be more comprehensive once it can evaluate humidity and wind alongside temperature.

## Estimated Complexity

**Small-Medium** -- Follows the same pattern as the Location field change. The model/migration/repository/form/table changes are mechanical. The minion scheduler update is a simple addition. The DAG updates are the most labor-intensive but follow established patterns.

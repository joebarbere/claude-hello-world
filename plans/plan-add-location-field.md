# Plan: Add Location Field to WeatherForecast

## Goal

Add a `Location` (string) and optional `Latitude`/`Longitude` (double) fields to the `WeatherForecast` model so forecasts have geographic context, enabling comparison against historical actuals and map-based visualizations.

## Current State

- **Model**: `apps/weather-api/Models/WeatherForecast.cs` has four persisted fields: `Id`, `Date`, `TemperatureC`, `Summary`. No location awareness.
- **Database**: PostgreSQL table `WeatherForecasts` created by `apps/weather-api/Migrations/20260308200545_InitialCreate.cs`. Two migrations exist (InitialCreate, AddMinions).
- **DbContext**: `apps/weather-api/Data/WeatherDbContext.cs` exposes `DbSet<WeatherForecast>`.
- **Repository**: `apps/weather-api/Repositories/EfWeatherForecastRepository.cs` handles CRUD. The `UpdateAsync` method explicitly maps `Date`, `TemperatureC`, and `Summary` -- new fields must be added here.
- **API**: `apps/weather-api/Program.cs` maps `/weatherforecast` endpoints. Traefik rewrites `/weather` to `/weatherforecast` in `traefik/traefik-dynamic.yml`.
- **CDC Pipeline**: Debezium connector registered in `apps/kafka/debezium-init/register-connector.sh` captures `public.*` tables with Avro encoding via Schema Registry. The Kafka topic `weather.public.WeatherForecasts` carries an Avro envelope with fields `Id`, `Date`, `TemperatureC`, `Summary`.
- **DuckDB schema**: `apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py` defines `weather_forecasts_cdc` with columns `id, date, temperature_c, summary, op, event_ts, loaded_at`.
- **Quality report**: `apps/datascience/airflow/dags/dag_quality_report.py` uses the first location in the profile as a baseline (line 247: "for loc_key in profile") because forecasts have no location field.
- **weather-app**: `apps/weather-app/src/app/remote-entry/entry.ts` displays a table with columns Date, Temp C, Temp F, Summary. The `WeatherForecast` interface has `date`, `temperatureC`, `temperatureF`, `summary`.
- **weatheredit-app**: `apps/weatheredit-app/src/app/remote-entry/entry.ts` has a form with `date`, `temperatureC`, `summary` fields. The `ForecastFormData` interface mirrors these.

## Implementation Steps

### 1. Update the WeatherForecast model

**File**: `apps/weather-api/Models/WeatherForecast.cs`

Add three nullable properties (nullable for backward compatibility with existing rows):

```csharp
[MaxLength(100)]
public string? Location { get; set; }

public double? Latitude { get; set; }

public double? Longitude { get; set; }
```

All three are nullable so existing rows get `NULL` without requiring a data backfill.

### 2. Create an EF Core migration

Run from the `apps/weather-api/` directory:

```bash
dotnet ef migrations add AddLocationToWeatherForecast
```

This generates a migration that adds three columns to the `WeatherForecasts` table:
- `Location` (varchar(100), nullable)
- `Latitude` (double precision, nullable)
- `Longitude` (double precision, nullable)

Verify the generated migration SQL by inspecting the `Up()` method. Confirm it uses `AddColumn` with `nullable: true`.

### 3. Update the EF repository

**File**: `apps/weather-api/Repositories/EfWeatherForecastRepository.cs`

In `UpdateAsync`, add mappings for the new fields:

```csharp
existing.Location = forecast.Location;
existing.Latitude = forecast.Latitude;
existing.Longitude = forecast.Longitude;
```

### 4. Handle Debezium / Avro schema evolution

The Debezium connector (`apps/kafka/debezium-init/register-connector.sh`) captures all columns from `public.*` tables. After the EF Core migration runs and adds the new columns to PostgreSQL:

- Debezium automatically detects the schema change and registers a new Avro schema version in the Schema Registry.
- Because the new columns are **nullable**, the Avro schema evolution is **backward-compatible** (new fields have `["null", "string"]` or `["null", "double"]` union types with default `null`).
- The Schema Registry's default compatibility mode is `BACKWARD`, which permits adding nullable fields.
- **No manual Avro schema registration is needed.** Debezium auto-evolves the schema.

**Verification**: After the migration, check the Schema Registry:
```bash
curl http://localhost:8081/subjects/weather.public.WeatherForecasts-value/versions/latest | jq .
```
Confirm the new schema version includes `Location`, `Latitude`, and `Longitude` fields.

### 5. Update the CDC-to-DuckDB DAG

**File**: `apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py`

Update the DuckDB DDL to include the new columns:

```sql
CREATE TABLE IF NOT EXISTS weather_forecasts_cdc (
    id             INTEGER PRIMARY KEY,
    date           DATE,
    temperature_c  INTEGER,
    summary        VARCHAR,
    location       VARCHAR,
    latitude       DOUBLE,
    longitude      DOUBLE,
    op             VARCHAR,
    event_ts       TIMESTAMP,
    loaded_at      TIMESTAMP
);
```

Update the `_load_batch_to_duckdb` function's upsert logic to extract and insert the new fields from the Debezium `after` payload:

```python
location = after.get("Location")
latitude = after.get("Latitude")
longitude = after.get("Longitude")
```

**Important**: For existing DuckDB files that lack these columns, add an `ALTER TABLE ADD COLUMN IF NOT EXISTS` migration block before the main upsert loop:

```python
con.execute("ALTER TABLE weather_forecasts_cdc ADD COLUMN IF NOT EXISTS location VARCHAR")
con.execute("ALTER TABLE weather_forecasts_cdc ADD COLUMN IF NOT EXISTS latitude DOUBLE")
con.execute("ALTER TABLE weather_forecasts_cdc ADD COLUMN IF NOT EXISTS longitude DOUBLE")
```

### 6. Update the quality report DAG

**File**: `apps/datascience/airflow/dags/dag_quality_report.py`

Replace the "use the first location as a baseline" logic (lines 246-250) with location-aware lookup:

```python
location = f.get("location")
if profile and month and location and location in profile:
    month_data = profile[location].get(str(month), {})
    mean = month_data.get("temp_mean")
    std = month_data.get("temp_std")
    if mean is not None and std is not None and std > 0:
        z = abs(temp_c - mean) / std
```

Also update the `_load_recent_forecasts` SQL query to include the `location` column.

### 7. Update the weather-app display

**File**: `apps/weather-app/src/app/remote-entry/entry.ts`

Add `location` to the `WeatherForecast` interface:

```typescript
interface WeatherForecast {
  date: string;
  temperatureC: number;
  temperatureF: number;
  summary: string | null;
  location: string | null;
}
```

Add a "Location" column to the table between Date and Temp C:

```html
<th scope="col">Location</th>
...
<td>{{ row.location ?? '—' }}</td>
```

### 8. Update the weatheredit-app form

**File**: `apps/weatheredit-app/src/app/remote-entry/entry.ts`

Add `location` to the `WeatherForecast` and `ForecastFormData` interfaces:

```typescript
interface ForecastFormData {
  date: string;
  temperatureC: number;
  summary: string;
  location: string;
}
```

Add a location dropdown to the form grid, populated with the 10 known cities:

```html
<div class="form-group">
  <label for="location">Location</label>
  <select id="location" class="form-input"
    [(ngModel)]="formData.location" name="location">
    <option value="">Select a city...</option>
    <option value="new_york">New York</option>
    <option value="london">London</option>
    <option value="tokyo">Tokyo</option>
    <!-- ... remaining cities from the profiles -->
  </select>
</div>
```

Update the form grid from `grid-template-columns: repeat(3, 1fr)` to `repeat(4, 1fr)` (or keep 3 and let it wrap).

Add `location` to the table display and to the `openEdit` pre-population logic.

## Files to Create/Modify

- **Modify**: `apps/weather-api/Models/WeatherForecast.cs` -- add Location, Latitude, Longitude properties
- **Create**: `apps/weather-api/Migrations/<timestamp>_AddLocationToWeatherForecast.cs` -- EF Core migration (auto-generated)
- **Modify**: `apps/weather-api/Repositories/EfWeatherForecastRepository.cs` -- map new fields in UpdateAsync
- **Modify**: `apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py` -- DDL update, upsert update, DuckDB migration
- **Modify**: `apps/datascience/airflow/dags/dag_quality_report.py` -- location-aware z-score lookup
- **Modify**: `apps/weather-app/src/app/remote-entry/entry.ts` -- interface + table column
- **Modify**: `apps/weatheredit-app/src/app/remote-entry/entry.ts` -- interface + form field + table column

## Testing

1. **Migration**: Run `dotnet ef database update` and verify the three new columns exist in PostgreSQL with `\d "WeatherForecasts"`.
2. **API**: POST a forecast with `"location": "new_york", "latitude": 40.7128, "longitude": -74.0060` and GET it back. Confirm all fields round-trip.
3. **API backward compat**: POST a forecast without the location fields. Confirm it succeeds with null values.
4. **Debezium**: After creating a forecast with location, check the Kafka topic for the new fields:
   ```bash
   kafka-console-consumer --topic weather.public.WeatherForecasts --from-beginning --max-messages 1
   ```
5. **Schema Registry**: Verify the new schema version is registered and backward-compatible.
6. **DuckDB DAG**: Trigger the `kafka_cdc_to_duckdb` DAG and verify the new columns appear in the DuckDB table.
7. **Quality report**: Trigger the `weather_quality_report` DAG with forecasts that have locations. Confirm z-scores use per-location profiles.
8. **weather-app**: Load the UI and verify the Location column appears with correct values.
9. **weatheredit-app**: Create and edit forecasts using the location dropdown. Verify values persist.
10. **Playwright e2e**: Run existing e2e tests (`nx e2e weather-app-e2e` and `nx e2e weatheredit-app-e2e`) to ensure no regressions.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Avro schema evolution breaks existing consumers | CDC pipeline stops | Use nullable fields only. Verify backward compatibility with Schema Registry before deploying. |
| Existing DuckDB file lacks new columns | DAG crashes on upsert | Add `ALTER TABLE ADD COLUMN IF NOT EXISTS` migration in the DAG before the upsert loop. |
| Old forecasts have NULL location | Quality report cannot do location-aware scoring | Fall back to the existing "first location" baseline when location is null. |
| Lat/Lon validation missing | Invalid coordinates stored | Add `[Range(-90, 90)]` and `[Range(-180, 180)]` data annotations on the model. |
| Location string is freeform | Inconsistent values (e.g., "NYC" vs "new_york") | Use a dropdown in the UI and validate against a known city list on the API side. |

## Dependencies

- **None required before this change.** This is a foundational change that many other ideas depend on.
- **Benefits from doing together**: "Add humidity and wind speed" (plan-add-humidity-wind.md) -- batching both into one migration avoids two sequential schema changes and two Avro schema evolutions.

## Estimated Complexity

**Medium** -- Touches the full vertical stack (model, migration, API, CDC pipeline, two Airflow DAGs, two Angular apps) but each individual change is straightforward. The Debezium/Avro schema evolution is the riskiest piece but should be automatic for nullable fields.

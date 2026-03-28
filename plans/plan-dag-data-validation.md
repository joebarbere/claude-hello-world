# Plan: DAG to Validate Ingested Weather Data Against Climatological Norms

## Goal

Create a new Airflow DAG that automatically validates weather data ingested by `dag_download_weather.py`, catching sensor errors, API anomalies, and gross outliers before they corrupt downstream profiles and quality scores.

## Current State

- `apps/datascience/airflow/dags/dag_download_weather.py` ingests GHCN-Daily CSVs and Open-Meteo CSVs into the `weather-raw` MinIO bucket. It runs daily at 02:00 UTC. No validation is performed on ingested data.
- `apps/datascience/airflow/dags/dag_quality_report.py` evaluates minion-generated forecasts (from the CDC pipeline) against historical profiles, but does **not** validate the source data itself.
- `apps/datascience/shared/weather_sources.py` defines the station list (`GHCN_STATIONS`: 5 stations) and location list (`OPEN_METEO_LOCATIONS`: 5 cities).
- `apps/datascience/shared/minio_helper.py` provides `get_client()`, `object_exists()`, `read_csv()`, `read_parquet()`, and `upload_dataframe()`.
- Weather profiles in `weather-analytics/profiles/weather_profiles_v1.json` contain per-location, per-month temperature means and standard deviations (produced by Notebook 04).
- The Prometheus Pushgateway does not yet exist (see `plan-quality-score-dashboard.md`), but metrics can be pushed via the same pattern once deployed.
- Airflow uses SequentialExecutor with SQLite (`k8s/datascience-pod.yaml`), so all tasks run serially.

## Implementation Steps

### Step 1: Define Validation Rules

Create `apps/datascience/shared/validation_rules.py` containing:

```python
"""
validation_rules.py
===================
Climatological bounds and validation functions for weather data quality checks.
"""

# Global physical bounds (absolute extremes ever recorded on Earth)
GLOBAL_BOUNDS = {
    "temperature_c":    (-89.2, 56.7),    # Vostok / Death Valley
    "precipitation_mm": (0.0, 305.0),     # max daily rainfall ~300mm
    "wind_speed_kmh":   (0.0, 410.0),     # highest recorded gust
    "humidity_pct":     (0.0, 100.0),
    "snowfall_mm":      (0.0, 2000.0),    # extreme single-event snowfall
}

# GHCN column mapping to standard names
# GHCN stores values in tenths (temperature in tenths of C, precip in tenths of mm)
GHCN_COLUMN_MAP = {
    "TMAX": ("temperature_c", 0.1),   # multiply by 0.1 to convert
    "TMIN": ("temperature_c", 0.1),
    "PRCP": ("precipitation_mm", 0.1),
    "SNOW": ("snowfall_mm", 1.0),
    "SNWD": ("snowfall_mm", 1.0),
}

# Open-Meteo columns to validate
OPEN_METEO_CHECKS = {
    "temperature_2m_max":  "temperature_c",
    "temperature_2m_min":  "temperature_c",
    "temperature_2m_mean": "temperature_c",
    "precipitation_sum":   "precipitation_mm",
    "wind_speed_10m_max":  "wind_speed_kmh",
    "snowfall_sum":        "snowfall_mm",
}
```

The module should also expose:
- `check_global_bounds(value, metric_name) -> bool` -- returns True if within bounds.
- `check_profile_bounds(value, location, month, profile, sigma=4.0) -> bool` -- returns True if within `mean +/- sigma * std` from the weather profile.
- `validate_dataframe(df, source_type, profile=None) -> ValidationReport` -- runs all checks on a DataFrame, returning a structured report.

### Step 2: Create the Validation DAG

Create `apps/datascience/airflow/dags/dag_validate_weather.py`:

**Schedule**: Use Airflow's dataset-based scheduling (Airflow 2.4+) or a time-based trigger at 03:00 UTC (after `dag_download_weather.py` completes at 02:00).

For simplicity with SequentialExecutor, use time-based scheduling:
```python
schedule_interval="0 3 * * *"  # 03:00 UTC, 1 hour after download DAG
```

**Task graph**:
```
load_profile  ──►  validate_ghcn_[station]  ──┐
                   validate_meteo_[location] ──┼──►  aggregate_report  ──►  save_report  ──►  push_metrics
                                               │
```

**Tasks**:

1. **`load_profile`** -- Download `weather-analytics/profiles/weather_profiles_v1.json` from MinIO. If absent, fall back to global bounds only.

2. **`validate_ghcn_{station_id}`** (one per station) -- For each GHCN CSV in `weather-raw/ghcn/{station_id}.csv`:
   - Read the CSV via `minio_helper.read_csv()`.
   - Filter to the last 7 days of data (recent ingestion window).
   - For each row, apply:
     - **Global bounds check**: Is the raw value within physically possible limits?
     - **Profile bounds check**: Is the converted temperature within 4 sigma of the monthly mean for this location?
     - **Null rate check**: Are more than 20% of expected rows missing?
     - **Duplicate check**: Are there duplicate `(station, date, element)` tuples?
   - Return a per-station validation summary via XCom.

3. **`validate_meteo_{location}`** (one per location) -- For each Open-Meteo CSV in `weather-raw/open-meteo/{location}.csv`:
   - Read the CSV.
   - Filter to the last 7 days.
   - Apply global bounds and profile bounds checks on each mapped column.
   - Check for monotonicity violations: `temperature_2m_min > temperature_2m_max`.
   - Return a per-location validation summary via XCom.

4. **`aggregate_report`** -- Pull all validation summaries from XCom. Combine into a single report:
   ```json
   {
     "run_date": "2026-03-28",
     "sources_validated": 10,
     "total_rows_checked": 12345,
     "total_flags": 42,
     "flag_rate": 0.0034,
     "by_source": {
       "ghcn/USW00094728": { "rows": 2500, "flags": 3, "details": [...] },
       "open-meteo/new_york": { "rows": 1826, "flags": 0, "details": [] }
     },
     "flag_types": {
       "global_bounds_violation": 2,
       "profile_bounds_violation": 35,
       "null_rate_exceeded": 1,
       "duplicate_rows": 4,
       "min_exceeds_max": 0
     }
   }
   ```

5. **`save_report`** -- Upload the report to `weather-analytics/validation/validation_YYYY-MM-DD.json` in MinIO.

6. **`push_metrics`** (optional, depends on Pushgateway from quality-score plan) -- Push gauge metrics to Prometheus:
   - `weather_validation_flag_count` (total flags)
   - `weather_validation_flag_rate` (flags / rows)
   - `weather_validation_sources_checked`

### Step 3: Add Validation Panels to Grafana

If the Pushgateway is deployed (per `plan-quality-score-dashboard.md`), add two panels to the quality score dashboard or create a dedicated "Data Validation" row:

- **Validation Flag Rate (timeseries)** -- `weather_validation_flag_rate` with a threshold at 0.01 (1%).
- **Validation Flag Count (stat)** -- `weather_validation_flag_count`.

Alternatively, add these panels to `apps/observability/grafana/provisioning/dashboards/quality-score.json` as an additional row.

### Step 4: Symlink Shared Module

The `shared/` directory is mounted into the Airflow container at `/opt/airflow/dags/shared` (see `k8s/datascience-pod.yaml` volumeMount). The new `validation_rules.py` file placed in `apps/datascience/shared/` will be automatically available to the DAG via the existing `sys.path.insert(0, _SHARED_DIR)` pattern.

## Files to Create/Modify

- **Create** `apps/datascience/shared/validation_rules.py` -- validation bounds, check functions, report dataclass
- **Create** `apps/datascience/airflow/dags/dag_validate_weather.py` -- the validation DAG
- **Modify** `apps/observability/grafana/provisioning/dashboards/quality-score.json` -- add validation panels (if Pushgateway exists)

## Testing

1. **Unit tests for `validation_rules.py`**:
   - `check_global_bounds(60.0, "temperature_c")` should return False (above 56.7).
   - `check_global_bounds(25.0, "temperature_c")` should return True.
   - `check_profile_bounds(50.0, "london", 1, profile, sigma=4)` should return False (January London mean is ~5C).
   - Test with an empty profile (should fall back to global bounds).

2. **Integration test**:
   - Ensure the `weather-raw` bucket has at least one GHCN and one Open-Meteo file.
   - Trigger the DAG manually in Airflow.
   - Verify the validation report JSON appears in `weather-analytics/validation/`.
   - Verify the report JSON is well-formed and contains expected keys.

3. **Inject bad data**: Manually insert a row with temperature 999 into a CSV copy, upload to MinIO under a test key, and verify the validation DAG flags it as a global bounds violation.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Profile not yet generated (Notebook 04 not run) | The DAG falls back to global-only bounds and logs a warning. Validation is still useful without the profile. |
| GHCN CSVs are large (multi-MB); filtering to 7 days in-memory is slow | Read the full CSV but immediately filter by date before running checks. Pandas handles multi-MB files in seconds. |
| False positives from overly tight profile bounds | Use 4-sigma (not 3) for profile bounds. Log flagged rows so operators can inspect and adjust. |
| SequentialExecutor makes per-station tasks slow | With 10 sources and lightweight validation logic, total runtime should be under 5 minutes. Acceptable for daily batch. |
| Airflow dataset-based scheduling not available on older Airflow versions | Use time-based schedule (03:00 UTC) as the default. Add a comment noting dataset triggers as a future improvement. |

## Dependencies

- **Soft dependency on** `plan-quality-score-dashboard.md` -- the Pushgateway is needed for Prometheus metrics. Without it, the DAG still produces MinIO reports but has no Grafana integration.
- **Benefits from** "Use Postgres for Airflow metadata" (IDEAS.md) -- LocalExecutor would allow per-station tasks to run in parallel.
- **Benefits from** "Incremental/delta ingestion for GHCN-Daily" (`plan-incremental-ghcn.md`) -- if incremental ingestion tracks the latest date, the validation DAG can use it to determine which rows are new.

## Estimated Complexity

**Medium** -- The validation logic itself is straightforward (bounds checks and null counts), but there are 10 source files to iterate, a new shared module to create, and optional Prometheus integration.

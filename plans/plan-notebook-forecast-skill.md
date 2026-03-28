# Plan: Notebook 05 -- Forecast Skill Evaluation

## Goal

Create Jupyter Notebook 05 that evaluates forecast accuracy by joining Open-Meteo forecasts against GHCN/Open-Meteo actuals, computing MAE/RMSE at each lead time (day+1 through day+7), and comparing against the minion baseline from the quality report.

## Current State

- **Notebook 01** (`apps/datascience/jupyter/notebooks/01_eda_open_meteo.ipynb`): EDA on Open-Meteo historical data.
- **Notebook 02** (`02_cdc_duckdb_analysis.ipynb`): Analyzes CDC forecast data in DuckDB.
- **Notebook 03** (`03_cleaning_and_munging.ipynb`): Cleans GHCN and Open-Meteo data, saves to `clean-weather` bucket as Parquet (`ghcn_daily_cleaned.parquet`, `open_meteo_daily_cleaned.parquet`), and loads into DuckDB table `weather_observations_clean`.
- **Notebook 04** (`04_weather_profiles.ipynb`): Builds `weather_profiles_v1.json` with per-location, per-month temperature statistics and label probability distributions. Uploaded to `weather-analytics/profiles/`.
- **Open-Meteo forecast data does not yet exist** in the MinIO bucket. The current `dag_download_weather.py` only fetches historical/archive data from `archive-api.open-meteo.com`. IDEAS.md describes a planned "DAG to fetch Open-Meteo forecast data" that would store daily 7-day forecasts to `weather-raw/open-meteo-forecast/{location}/{YYYY-MM-DD}.json`.
- **Minion forecasts** are captured via Kafka CDC into the DuckDB table `weather_forecasts_cdc` (populated by `dag_kafka_cdc_to_duckdb.py`). These forecasts have `id`, `date`, `temperature_c`, `summary`, `op`, `event_ts`, and `loaded_at`.
- **DuckDB** is stored at `weather-analytics/duckdb/weather.duckdb` in MinIO and contains both `weather_forecasts_cdc` and `weather_observations_clean` tables.
- **Shared helpers**: `minio_helper.py` provides `get_client()`, `read_csv()`, `read_parquet()`, `object_exists()`. Available in Jupyter at `/home/jovyan/work/shared`.
- The 5 shared locations between GHCN and Open-Meteo are: New York, Los Angeles/London, Tokyo, Melbourne, Singapore (see `weather_sources.py`).

## Implementation Steps

### Step 1: Prerequisite -- Open-Meteo Forecast Ingestion

This notebook requires forecast data to exist. Two paths forward:

**Path A (recommended)**: Implement the Open-Meteo forecast DAG first. This creates versioned forecast files:
- Extend `apps/datascience/shared/weather_sources.py` with `download_open_meteo_forecast()` calling `https://api.open-meteo.com/v1/forecast`.
- Store at `weather-raw/open-meteo-forecast/{location}/{YYYY-MM-DD}.json`, where the filename is the **run date** (the date the forecast was issued).
- Each file contains 7 days of daily forecasts (day+1 through day+7).

**Path B (fallback for immediate development)**: Use the existing historical Open-Meteo data as a simulated forecast. Shift the date range by N days to create pseudo-forecasts, acknowledging this is not a real skill evaluation but demonstrates the methodology.

The notebook should support both paths, defaulting to Path A if forecast files exist and falling back to Path B with a clear warning.

### Step 2: Create Notebook 05

Create `apps/datascience/jupyter/notebooks/05_forecast_skill_evaluation.ipynb` with the following cell structure:

**Cell 0 (markdown)**: Title and overview
- "Notebook 05 -- Forecast Skill Evaluation"
- Explanation of forecast skill, lead time, MAE, RMSE
- Prerequisites: Notebooks 03-04 must have been run; Open-Meteo forecast DAG should be running

**Cell 1**: Imports and setup
```python
import sys, os, json, io
SHARED_PATH = '/home/jovyan/work/shared'
if SHARED_PATH not in sys.path:
    sys.path.insert(0, SHARED_PATH)

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
import duckdb
from minio_helper import get_client, read_csv, read_parquet, object_exists

client = get_client()
```

**Cell 2**: Load actuals from cleaned data
- Load `clean-weather/open_meteo_daily_cleaned.parquet` (ground truth for Open-Meteo locations).
- Load `clean-weather/ghcn_daily_cleaned.parquet` (ground truth for GHCN locations).
- Combine into a single `actuals_df` with columns: `date`, `location`, `temp_actual_c`, `summary_actual`.

**Cell 3**: Load forecast data
- Attempt to load from `weather-raw/open-meteo-forecast/{location}/*.json`.
- Each forecast JSON contains a `daily` block with `time` (array of dates) and `temperature_2m_mean` (array of forecasted values).
- Parse into a DataFrame with columns: `issue_date`, `forecast_date`, `location`, `temp_forecast_c`, `lead_days`.
- `lead_days = (forecast_date - issue_date).days`.
- If no forecast files exist, fall back to Path B (simulated forecasts) with a prominent warning cell.

**Cell 4**: Load minion forecasts from DuckDB
- Download `weather-analytics/duckdb/weather.duckdb` from MinIO.
- Query `weather_forecasts_cdc` for all create/update/snapshot ops.
- Note: minion forecasts currently lack a `location` field, so they can only be evaluated in aggregate (not per-city). Document this limitation and reference the "Add location to WeatherForecast" idea from IDEAS.md.

**Cell 5 (markdown)**: Explain the join strategy
- Forecasts are joined to actuals on `(location, date)`.
- For Open-Meteo forecasts: inner join `forecast_df` to `actuals_df` on `(location, forecast_date == date)`.
- For minion forecasts: join on `date` only (no location). Compare against the global average actual temperature for that date.

**Cell 6**: Join forecasts to actuals
```python
# Open-Meteo forecast vs actuals
joined = forecast_df.merge(
    actuals_df[['date', 'location', 'temp_actual_c']],
    left_on=['location', 'forecast_date'],
    right_on=['location', 'date'],
    how='inner',
)
joined['error'] = joined['temp_forecast_c'] - joined['temp_actual_c']
joined['abs_error'] = joined['error'].abs()
joined['sq_error'] = joined['error'] ** 2
```

**Cell 7**: Compute MAE and RMSE by lead time
```python
skill_by_lead = (
    joined.groupby('lead_days')
    .agg(
        mae=('abs_error', 'mean'),
        rmse=('sq_error', lambda x: np.sqrt(x.mean())),
        bias=('error', 'mean'),
        count=('error', 'count'),
    )
    .round(3)
)
```

**Cell 8**: Plot the error growth curve
- X-axis: lead time (1-7 days). Y-axis: MAE and RMSE.
- Classic "error growth" pattern: errors increase with lead time.
- Two line series: MAE (solid) and RMSE (dashed).
- This is the signature visualization of forecast skill evaluation.

**Cell 9**: Compute minion baseline MAE
- For each date in minion forecasts, compute `|minion_temp - global_mean_actual_temp_for_that_date|`.
- This is the "unskilled" baseline. Any real forecast model should beat it.
- Display as a horizontal dashed line on the error growth plot from Cell 8.

**Cell 10**: MAE by location
- Group by `(location, lead_days)` and compute MAE.
- Faceted line plot: one subplot per location.
- Expect tropical locations (Singapore) to have lower MAE (less variable) and mid-latitude cities (New York, Tokyo) to have higher MAE.

**Cell 11**: Bias analysis
- Plot `mean_error` (not absolute) by lead time and location.
- Positive bias = forecast too warm. Negative = too cold.
- Heatmap: rows = locations, columns = lead days, values = mean bias.

**Cell 12**: Seasonal skill decomposition
- Group by `(month, lead_days)` and compute MAE.
- Heatmap showing whether forecasts are better in summer vs winter.
- Mid-latitude locations typically show lower skill in transitional seasons (spring/fall).

**Cell 13**: Summary statistics table
- Table comparing Open-Meteo day+1 MAE, day+3 MAE, day+7 MAE, and minion baseline MAE.
- Per-location and overall.

**Cell 14**: Save skill evaluation results to MinIO
```python
skill_report = {
    "run_date": pd.Timestamp.now().strftime("%Y-%m-%d"),
    "forecast_source": "open_meteo",
    "actuals_source": "open_meteo_cleaned + ghcn_cleaned",
    "locations": sorted(joined['location'].unique().tolist()),
    "lead_time_skill": skill_by_lead.to_dict(),
    "minion_baseline_mae": float(minion_mae),
}
# Upload to weather-analytics/skill/forecast_skill_YYYY-MM-DD.json
```

**Cell 15 (markdown)**: Conclusions and next steps
- Summarize key findings.
- Note that forecast skill can be tracked over time as more forecast runs accumulate.
- Reference Notebook 06 (anomaly detection) as a natural follow-up.

### Step 3: Handle the No-Location Problem for Minion Forecasts

The `weather_forecasts_cdc` table does not have a `location` column. The notebook should:
1. Acknowledge this limitation prominently.
2. Compare minion forecasts against the **global daily mean** actual temperature (average across all locations for that date).
3. Include a code comment noting that once "Add location to WeatherForecast" (IDEAS.md) is implemented, the join can be made per-location.

## Files to Create/Modify

- **Create** `apps/datascience/jupyter/notebooks/05_forecast_skill_evaluation.ipynb` -- the notebook
- **Potentially create** `apps/datascience/shared/weather_sources.py` addition -- `download_open_meteo_forecast()` function (if the forecast DAG is implemented as a prerequisite)

## Testing

1. **Notebook runs end-to-end**: Open in Jupyter, Run All Cells. Should complete without errors even if forecast data is missing (falls back to Path B simulation).
2. **Verify join correctness**: Check that the joined DataFrame has no orphan rows where `temp_actual_c` is NaN.
3. **Sanity check MAE values**: Open-Meteo day+1 MAE for temperature should be roughly 1-3C for most locations. If MAE is >10C, something is wrong with the join or unit conversion.
4. **Minion baseline sanity**: The minion baseline MAE should be significantly higher than the Open-Meteo MAE (since minions generate random temperatures). If it is lower, the comparison logic is wrong.
5. **Verify MinIO artifact**: After running, confirm `weather-analytics/skill/forecast_skill_YYYY-MM-DD.json` exists in MinIO.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Open-Meteo forecast DAG not yet implemented | Path B fallback uses shifted historical data. Notebook clearly labels this as simulated. |
| Forecast and actual dates do not overlap | Inner join will produce an empty DataFrame. Add an assertion with a clear error message: "No matching dates found. Ensure forecast and actuals cover the same date range." |
| Minion forecasts lack location field | Compare against global daily mean. Document the limitation. |
| DuckDB file not present in MinIO | Wrap DuckDB loading in a try/except; skip minion comparison with a warning. |
| Notebook 03 not run (no cleaned data) | Raise `FileNotFoundError` with a clear message pointing to Notebook 03. |

## Dependencies

- **Hard dependency on** Notebooks 03 and 04 having been run (cleaned data and profiles must exist in MinIO).
- **Soft dependency on** the Open-Meteo forecast DAG (described in IDEAS.md). Without it, only the simulated Path B is available.
- **Benefits from** "Add location to WeatherForecast" (IDEAS.md) -- enables per-location minion skill comparison.
- **Enables** "DAG to retrain and publish weather profiles monthly" (IDEAS.md) -- skill metrics could inform profile updates.

## Estimated Complexity

**Medium** -- The notebook itself is a standard data science workflow (load, join, compute, plot). The main complexity is handling the two data paths (real forecasts vs simulated) and the missing location field on minion data.

# Plan: Notebook 07 -- Multi-Source Data Fusion

## Goal

Build a Jupyter notebook that joins GHCN-Daily and Open-Meteo historical data on (location, date), analyzes inter-source agreement and disagreement, applies ensemble averaging to produce a canonical "ground truth" dataset, and exports the fused dataset to MinIO for downstream use.

## Current State

- **Two data sources are already cleaned and stored in MinIO** (produced by Notebook 03):
  - `clean-weather/ghcn_daily_cleaned.parquet` -- columns: `date`, `location`, `station_id`, `source` (value: `"ghcn"`), `temp_max_c`, `temp_min_c`, `temp_mean_c`, `precipitation_mm`, `summary`.
  - `clean-weather/open_meteo_daily_cleaned.parquet` -- columns: `date`, `location`, `source` (value: `"open_meteo"`), `temperature_2m_max`, `temperature_2m_min`, `temperature_2m_mean`, `precipitation_sum`, `summary`. Note the different column names from GHCN.
- **Overlapping locations**: Both sources cover 5 cities. GHCN stations: New York (USW00094728), Los Angeles (USW00023174), London (UKW00035065), Tokyo (JA000047662), Melbourne (ASN00086282). Open-Meteo locations: New York, London, Tokyo, Melbourne, Singapore. Four cities overlap: New York, London, Tokyo, Melbourne. Los Angeles is GHCN-only; Singapore is Open-Meteo-only.
- **Overlapping date range**: Both sources cover 2020-01-01 to 2024-12-31 (the Open-Meteo download range set in `weather_sources.py` line 197; GHCN is filtered to `>= 2019-01-01` in Notebook 03 cell 4).
- **Column name mismatch**: GHCN uses `temp_mean_c`, `temp_max_c`, `temp_min_c`, `precipitation_mm`. Open-Meteo uses `temperature_2m_mean`, `temperature_2m_max`, `temperature_2m_min`, `precipitation_sum`. These must be aligned before joining.
- **No existing fusion logic** -- Notebook 04 concatenates both sources with common columns (cell 2) but does not join or compare them row-by-row for the same (location, date).
- **Shared helpers**: `minio_helper.py` provides all needed MinIO operations. `upload_dataframe()` supports both CSV and Parquet export.
- **DuckDB**: The `weather-analytics/duckdb/weather.duckdb` file has a `weather_observations_clean` table populated by Notebook 03 (cell 22) with both sources interleaved. However, this table does not fuse records -- it stores them side by side.

## Implementation Steps

### 1. Create the notebook file

Create `apps/datascience/jupyter/notebooks/07_data_fusion.ipynb` following the established pattern (markdown intro, imports, load, analyze, export).

### 2. Introductory markdown cell

Explain the motivation: when multiple data sources cover the same locations and dates, they often disagree due to measurement methodology differences (GHCN uses point-station observations; Open-Meteo uses gridded reanalysis model output). Fusing them into a single ground truth dataset provides a more robust baseline for forecast evaluation and anomaly detection.

### 3. Imports and setup cell

```python
import sys
SHARED_PATH = '/home/jovyan/work/shared'
if SHARED_PATH not in sys.path:
    sys.path.insert(0, SHARED_PATH)

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns

from minio_helper import get_client, read_parquet, object_exists, ensure_bucket, upload_dataframe

%matplotlib inline
sns.set_theme(style='whitegrid', palette='tab10')
plt.rcParams['figure.dpi'] = 120
client = get_client()
```

### 4. Load and align data from MinIO

Load both Parquet files. Standardize column names so both sources use the same schema:

```python
# Rename Open-Meteo columns to match GHCN naming
meteo_rename = {
    'temperature_2m_mean': 'temp_mean_c',
    'temperature_2m_max': 'temp_max_c',
    'temperature_2m_min': 'temp_min_c',
    'precipitation_sum': 'precipitation_mm',
}
meteo_df = meteo_df.rename(columns=meteo_rename)
```

Ensure `date` is `datetime64` in both DataFrames. Ensure `location` values match exactly (both already use lowercase underscore names like `new_york`).

### 5. Data alignment analysis

Before joining, analyze the alignment:
- **Temporal overlap**: For each shared location, count the number of dates present in both sources, only GHCN, or only Open-Meteo. Display as a stacked bar chart.
- **Location coverage table**: Show which locations come from which sources. Highlight the 4 overlapping cities and the 2 single-source cities.

### 6. Inner join on (location, date)

Perform a merge to pair same-day observations from both sources:

```python
merged = ghcn_df.merge(
    meteo_df,
    on=['location', 'date'],
    how='inner',
    suffixes=('_ghcn', '_meteo'),
)
```

Report the number of matched rows per location.

### 7. Inter-source disagreement analysis

For each paired variable (`temp_mean_c`, `temp_max_c`, `temp_min_c`, `precipitation_mm`):

- **Compute differences**: `diff = ghcn_value - meteo_value`
- **Summary statistics**: mean difference (bias), std of difference, MAE, RMSE, Pearson correlation.
- **Scatter plots**: GHCN vs. Open-Meteo for each variable, with a 1:1 line. One subplot per variable, colored by location.
- **Histogram of differences**: Show the distribution of disagreements. Annotate the mean bias.
- **Time series of differences**: For one city (e.g., New York), plot the daily temperature difference over time to check for seasonal patterns in disagreement.

### 8. Conflict resolution strategy

Explain the three common strategies in a markdown cell:
1. **Prefer one source** -- Use GHCN as primary (actual station measurement) and Open-Meteo as fill-in where GHCN is missing.
2. **Simple average** -- Equal-weight ensemble: `fused = (ghcn + meteo) / 2`.
3. **Weighted average** -- Weight by inverse variance or data quality score.

Implement strategy 2 (simple average) as the default, with strategy 1 as a fallback for single-source locations:

```python
# For overlapping locations+dates: ensemble average
merged['temp_mean_c_fused'] = (merged['temp_mean_c_ghcn'] + merged['temp_mean_c_meteo']) / 2
merged['temp_max_c_fused'] = (merged['temp_max_c_ghcn'] + merged['temp_max_c_meteo']) / 2
merged['temp_min_c_fused'] = (merged['temp_min_c_ghcn'] + merged['temp_min_c_meteo']) / 2
merged['precipitation_mm_fused'] = (merged['precipitation_mm_ghcn'] + merged['precipitation_mm_meteo']) / 2
```

For single-source locations (Los Angeles from GHCN, Singapore from Open-Meteo), use the single source's values directly.

### 9. Build the fused ground truth dataset

Combine:
- Fused rows for the 4 overlapping locations
- Single-source rows for Los Angeles (GHCN) and Singapore (Open-Meteo)

Output schema:
```
date, location, temp_mean_c, temp_max_c, temp_min_c, precipitation_mm,
summary, source_count, sources
```

Where `source_count` is 1 or 2 and `sources` is a comma-separated string (`"ghcn,open_meteo"` or `"ghcn"` or `"open_meteo"`).

Reassign the `summary` label using `pd.cut()` on the fused `temp_mean_c` with the standard bins from Notebook 03 (cell 14).

### 10. Validate the fused dataset

- **Distribution comparison**: For each overlapping city, plot three overlapping histograms (GHCN, Open-Meteo, Fused) to confirm the fused distribution sits between the two sources.
- **Monthly means comparison**: Line plot showing GHCN, Open-Meteo, and Fused monthly means for one city. The fused line should always be between the other two.
- **Sanity checks**: Assert no NaN values in fused temperature columns. Assert all `summary` labels are valid. Assert date range covers the expected span.

### 11. Quantify fusion benefit

Show that the fused dataset has:
- Lower variance than either source alone (averaging reduces noise).
- Complete location coverage (6 cities vs. 5 per source).
- Consistent summary labels derived from fused temperatures.

### 12. Export fused dataset to MinIO

```python
ensure_bucket(client, 'weather-analytics')

# Per-location Parquet files
for location in fused_df['location'].unique():
    loc_df = fused_df[fused_df['location'] == location]
    upload_dataframe(
        client, 'weather-analytics',
        f'ground-truth/{location}.parquet',
        loc_df,
        file_format='parquet',
    )

# Also upload a single combined file
upload_dataframe(
    client, 'weather-analytics',
    'ground-truth/all_locations.parquet',
    fused_df,
    file_format='parquet',
)
```

### 13. Summary markdown cell

Summarize key findings: inter-source bias (is one source systematically warmer?), which variables agree most/least, and whether the fusion approach is ready for use by the quality report DAG and future forecast evaluation.

## Files to Create/Modify

- **Create**: `apps/datascience/jupyter/notebooks/07_data_fusion.ipynb`
- **No modifications** to existing files -- this notebook reads from MinIO and writes new objects without changing existing artifacts

## Testing

1. **Data loading**: Confirm both Parquet files load and have the expected columns. If either file is missing, the notebook should fail with a clear error referencing Notebook 03.
2. **Column alignment**: After renaming, both DataFrames should have identical column names for the variables being fused. Assert column existence before merging.
3. **Join completeness**: For the 4 overlapping cities, the inner join should produce > 0 rows per city. Log the match rate (matched / total available).
4. **Fused values plausibility**: For temperature, the fused value should always be between the GHCN and Open-Meteo values (since it is an average). Assert `min(ghcn, meteo) <= fused <= max(ghcn, meteo)` for all rows.
5. **Summary label consistency**: After reassigning labels from fused temperatures, verify no row has an impossible combination (e.g., "Scorching" below 40 degrees C).
6. **MinIO export**: Verify Parquet files appear under `weather-analytics/ground-truth/` in MinIO. Download one and confirm it has the expected schema and row count.
7. **End-to-end**: Run all cells top to bottom in a fresh kernel.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Location names don't match between sources | Notebook 03 already standardizes to lowercase underscore names (`new_york`, `london`, etc.). Verify this in cell 4 by printing unique locations from each source before merging. |
| Date ranges don't overlap | Both sources are configured for 2020-2024. If GHCN data starts later for some stations, the inner join naturally handles this. Log the overlap date range per location. |
| Precipitation averaging is inappropriate (rain is discrete) | Acknowledge this in a markdown cell. For precipitation, consider using the maximum of the two sources rather than the average, since under-reporting is more common than over-reporting. Offer both options. |
| Open-Meteo grid-cell data is fundamentally different from GHCN station data | Explain in the intro that GHCN measures at a point (weather station) while Open-Meteo interpolates to a grid cell (~10 km). Some systematic bias is expected. The disagreement analysis (step 7) quantifies this. |
| Large merged DataFrame if more sources are added later | The current 2-source fusion for 6 cities and 5 years produces ~10K fused rows. This is trivially small. The notebook design (merge on location+date) scales to additional sources with minimal changes. |

## Dependencies

- **Required before starting**: Notebook 03 must have been run to produce cleaned Parquet files in the `clean-weather/` MinIO bucket.
- **Benefits from**: "DAG to collect weather data from weather.gov" and "DAG to collect weather data from NOAA (ISD)" ideas would add a third and fourth source, making the fusion analysis more valuable and the ensemble average more robust.
- **Feeds into**: The ground truth dataset produced here can replace the raw profile training data in "DAG to retrain and publish weather profiles monthly" for higher-quality profiles. The quality report DAG could compare forecasts against fused ground truth rather than profiles built from a single source.
- **Feeds into**: "Notebook 05: Forecast skill evaluation" needs a ground truth dataset to compare forecasts against -- this notebook produces exactly that.

## Estimated Complexity

**Medium** -- The merge and averaging logic is straightforward pandas. The bulk of the work is in the disagreement analysis and visualizations. Expect 3-4 hours of implementation and testing.

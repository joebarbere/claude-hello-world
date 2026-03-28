# Plan: DAG to Retrain and Publish Weather Profiles Monthly

## Goal

Create an Airflow DAG that runs on the first day of each month, rebuilds the weather profiles from the latest cleaned historical data, publishes a versioned artifact to MinIO, and emits a Prometheus metric with the profile version number.

## Current State

- **Profile-building logic** lives entirely in Notebook 04 (`apps/datascience/jupyter/notebooks/04_weather_profiles.ipynb`). The key operations are:
  1. Load cleaned Parquet files from MinIO bucket `clean-weather/` (cells 2).
  2. Compute monthly temperature statistics via `groupby(['location', 'month'])['temp_mean_c'].agg(['mean', 'std', 'min', 'max', 'count'])` (cell 4).
  3. Compute label probability distributions with Laplace smoothing using the `compute_label_probs()` function (cell 8).
  4. Assemble a nested JSON profile: `{location: {month: {temp_mean, temp_std, temp_min, temp_max, day_count, labels: {...}}}}` (cell 11).
  5. Upload to `weather-analytics/profiles/weather_profiles_v1.json` (cell 14).
- **Current profile artifact**: `weather-analytics/profiles/weather_profiles_v1.json` -- a static, manually produced file with no versioning. Consumers (e.g., `dag_quality_report.py`) read this fixed path.
- **Quality report DAG** (`apps/datascience/airflow/dags/dag_quality_report.py`) loads the profile from `weather-analytics/profiles/weather_profiles_v1.json` via the `PROFILE_OBJECT` constant (line 64). It uses profile data for z-score computation (lines 244-253).
- **Existing DAG patterns**: All three DAGs use the same structure -- `_DEFAULT_ARGS`, PythonOperator tasks, MinIO via `get_client()` from `apps/datascience/shared/minio_helper.py`, XCom for inter-task data passing.
- **Shared helpers**: `minio_helper.py` provides `get_client()`, `read_parquet()`, `upload_dataframe()`, `ensure_bucket()`, `object_exists()`. The DAGs import from a `shared/` directory symlinked into the dags folder.
- **Summary labels and bins**: Defined in Notebook 03 (cell 14) and also in `dag_quality_report.py` as `LABEL_RANGES` (lines 69-80). The bin edges are: `[-inf, -5, 0, 5, 12, 18, 24, 30, 35, 40, inf]`.
- **No Prometheus pushgateway** is confirmed in the current stack, but the IDEAS.md references Prometheus metrics as a future direction. The observability stack likely includes Prometheus based on the Grafana provisioning files.

## Implementation Steps

### 1. Extract profile-building logic into a shared module

Create `apps/datascience/shared/profile_builder.py` containing the core logic extracted from Notebook 04:

```python
"""
profile_builder.py
==================
Reusable logic for building weather profiles from cleaned historical data.
Used by both Notebook 04 (interactive exploration) and the monthly
retrain DAG (automated production).
"""

import logging
import pandas as pd
import numpy as np

log = logging.getLogger(__name__)

SUMMARY_LABELS = [
    'Freezing', 'Bracing', 'Chilly', 'Cool', 'Mild',
    'Warm', 'Balmy', 'Hot', 'Sweltering', 'Scorching',
]

SUMMARY_BINS = [-np.inf, -5, 0, 5, 12, 18, 24, 30, 35, 40, np.inf]

LAPLACE_ALPHA = 1


def compute_label_probs(group, labels=SUMMARY_LABELS, alpha=LAPLACE_ALPHA):
    """Compute Laplace-smoothed label probabilities for one location+month group."""
    counts = group['summary'].value_counts()
    smoothed = {label: counts.get(label, 0) + alpha for label in labels}
    total = sum(smoothed.values())
    return {label: round(count / total, 4) for label, count in smoothed.items()}


def build_profiles(df: pd.DataFrame) -> dict:
    """
    Build weather profiles from a cleaned DataFrame.

    Parameters
    ----------
    df : pd.DataFrame
        Must contain columns: date, location, temp_mean_c, summary.

    Returns
    -------
    dict
        Nested profile: {location: {month_str: {temp_mean, temp_std, ...}}}
    """
    df = df.copy()
    df['date'] = pd.to_datetime(df['date'])
    df['month'] = df['date'].dt.month

    temp_stats = (
        df.groupby(['location', 'month'])['temp_mean_c']
        .agg(['mean', 'std', 'min', 'max', 'count'])
        .round(2)
    )
    temp_stats.columns = ['temp_mean', 'temp_std', 'temp_min', 'temp_max', 'day_count']

    label_probs = {}
    for (location, month), group in df.groupby(['location', 'month']):
        label_probs[(location, month)] = compute_label_probs(group)

    profile = {}
    for location in sorted(df['location'].unique()):
        profile[location] = {}
        for month in range(1, 13):
            if (location, month) in temp_stats.index:
                stats = temp_stats.loc[(location, month)]
                temp_info = {
                    'temp_mean': float(stats['temp_mean']),
                    'temp_std': float(stats['temp_std']),
                    'temp_min': float(stats['temp_min']),
                    'temp_max': float(stats['temp_max']),
                    'day_count': int(stats['day_count']),
                }
            else:
                temp_info = {
                    'temp_mean': 15.0, 'temp_std': 5.0,
                    'temp_min': 0.0, 'temp_max': 30.0, 'day_count': 0,
                }

            labels = label_probs.get((location, month), {})
            if not labels:
                labels = {l: round(1.0 / len(SUMMARY_LABELS), 4) for l in SUMMARY_LABELS}

            profile[location][str(month)] = {**temp_info, 'labels': labels}

    return profile
```

### 2. Refactor Notebook 04 to use the shared module

Replace the inline profile-building code in Notebook 04 cells 4, 8, and 11 with:

```python
from profile_builder import build_profiles, SUMMARY_LABELS
profile = build_profiles(df)
```

Keep the visualization cells unchanged. This ensures the notebook and DAG always use the same logic.

### 3. Create the retraining DAG

Create `apps/datascience/airflow/dags/dag_retrain_profiles.py`:

**Task 1: `load_cleaned_data`**
- Download `clean-weather/open_meteo_daily_cleaned.parquet` and `clean-weather/ghcn_daily_cleaned.parquet` from MinIO using `read_parquet()`.
- Concatenate into a single DataFrame with standardized columns (`date`, `location`, `temp_mean_c`, `summary`).
- Serialize to JSON and push via XCom (or write to a temp Parquet file and push the path).

**Task 2: `build_profile`**
- Pull the DataFrame from XCom.
- Call `profile_builder.build_profiles(df)`.
- Serialize the profile dict to JSON.
- Push the JSON string via XCom.

**Task 3: `publish_versioned_profile`**
- Pull the profile JSON from XCom.
- Determine the version number: list existing objects under `weather-analytics/profiles/weather_profiles_v*.json`, parse version numbers, increment.
- Upload to `weather-analytics/profiles/weather_profiles_v{N}.json`.
- Also upload to (or overwrite) `weather-analytics/profiles/weather_profiles_latest.json` as the "latest" pointer.
- Log the version number and upload paths.

**Task 4: `emit_prometheus_metric`**
- Push a gauge metric `weather_profile_version` with the version number to the Prometheus Pushgateway (if available).
- Also push `weather_profile_locations` (count of locations) and `weather_profile_retrain_timestamp` (Unix timestamp of the run).
- If the Pushgateway is not available, log a warning and skip (do not fail the DAG).

**DAG configuration:**
- `dag_id`: `retrain_weather_profiles`
- `schedule_interval`: `0 4 1 * *` (04:00 UTC on the 1st of each month)
- `start_date`: `datetime(2024, 1, 1)`
- `catchup`: `False`
- `tags`: `['profiles', 'retrain', 'minio']`
- `max_active_runs`: `1`
- Task dependencies: `load_cleaned_data >> build_profile >> publish_versioned_profile >> emit_prometheus_metric`

### 4. Update the quality report DAG to read the latest profile

Modify `dag_quality_report.py`:
- Change `PROFILE_OBJECT` from `'profiles/weather_profiles_v1.json'` to `'profiles/weather_profiles_latest.json'`.
- Add a fallback: if `latest` does not exist, try `v1` (backward compatibility).

### 5. Ensure the shared symlink includes profile_builder.py

The DAG directory uses a symlink at `apps/datascience/airflow/dags/shared/` pointing to `apps/datascience/shared/`. Verify this symlink exists and that `profile_builder.py` is accessible from within the Airflow container. The existing DAGs already import from this path.

## Files to Create/Modify

- **Create**: `apps/datascience/shared/profile_builder.py` -- extracted profile-building logic
- **Create**: `apps/datascience/airflow/dags/dag_retrain_profiles.py` -- the monthly DAG
- **Modify**: `apps/datascience/jupyter/notebooks/04_weather_profiles.ipynb` -- refactor to use `profile_builder.py`
- **Modify**: `apps/datascience/airflow/dags/dag_quality_report.py` -- update `PROFILE_OBJECT` to read `latest`

## Testing

1. **Unit test `profile_builder.py`**: Create a small synthetic DataFrame with known values (e.g., 3 locations, 2 months, 100 rows). Call `build_profiles()` and assert that the output has the expected structure, correct mean/std values, and label probabilities that sum to 1.0.
2. **DAG import test**: Run `python -c "import dag_retrain_profiles"` in the Airflow container to verify no import errors.
3. **Manual trigger**: Trigger the DAG manually in the Airflow UI. Verify:
   - Task logs show data loaded from both Parquet files.
   - A new versioned profile JSON appears in MinIO under `weather-analytics/profiles/`.
   - The `weather_profiles_latest.json` object exists and contains valid JSON.
   - The quality report DAG still runs successfully with the new `latest` path.
4. **Version increment**: Trigger the DAG twice. Verify the second run creates `v3` (or the next version), not overwriting `v2`.
5. **Prometheus metric** (if Pushgateway available): Query `weather_profile_version` in Prometheus and confirm the value matches the latest version number.
6. **Notebook regression**: Re-run Notebook 04 after the refactor. Confirm it produces the same profile JSON as before (or acceptably close, given floating-point rounding).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| XCom size limit for large DataFrames | The cleaned dataset is ~15-20K rows, which serializes to a few MB of JSON. This is within Airflow's default XCom limit for SQLite. If it exceeds limits, write to a temp file and pass the path via XCom (same pattern as `dag_kafka_cdc_to_duckdb.py`). |
| Profile version number parsing breaks on unexpected filenames | Use a strict regex pattern `weather_profiles_v(\d+)\.json` when listing objects. Ignore files that don't match. |
| Prometheus Pushgateway not deployed | The metric emission task should be best-effort: catch connection errors and log a warning. Use `trigger_rule="all_done"` so DAG success is not gated on metric push. |
| Notebook 04 refactor breaks existing visualizations | The refactor only changes the profile computation cells, not the visualization cells. Run the notebook end-to-end after refactoring to confirm. |
| Race condition: quality report reads `latest` while retrain is writing | MinIO object writes are atomic (PUT is all-or-nothing). The quality report will read either the old or new version, never a partial file. |

## Dependencies

- **Required before starting**: Notebooks 03 and 04 must have been run at least once to establish the `clean-weather/` bucket contents and the initial `weather_profiles_v1.json`.
- **Benefits from**: "DAG to collect weather data from weather.gov" and "DAG to fetch Open-Meteo forecast data" ideas would add more training data, making the retrained profiles richer.
- **Benefits from**: "Use Postgres for Airflow metadata" would allow parallel task execution if the DAG is later expanded with per-location tasks.
- **Feeds into**: "Minion forecast generation guided by historical profiles" -- the retrain DAG keeps profiles current so minions always sample from up-to-date distributions.

## Estimated Complexity

**Medium** -- The profile-building logic is already written in Notebook 04 and just needs extraction. The DAG follows established patterns from the three existing DAGs. The versioning and Prometheus metric add moderate complexity. Expect 3-4 hours of implementation and testing.

# Plan: Notebook 06 -- Temperature Anomaly Detection with Isolation Forest

## Goal

Build a Jupyter notebook that applies scikit-learn's Isolation Forest to detect multi-dimensional weather anomalies, compare its output against the existing z-score method used by the quality report DAG, and export the trained model to MinIO for potential use in production.

## Current State

- **Existing anomaly detection**: `apps/datascience/airflow/dags/dag_quality_report.py` (lines 243-263) computes a univariate z-score on `temperature_c` against the monthly profile mean/std from `weather_profiles_v1.json`. It flags forecasts with z > 3.0 as anomalous.
- **Cleaned historical data**: Notebook 03 (`apps/datascience/jupyter/notebooks/03_cleaning_and_munging.ipynb`) saves cleaned Parquet files to MinIO bucket `clean-weather/`:
  - `open_meteo_daily_cleaned.parquet` -- columns include `temperature_2m_mean`, `temperature_2m_max`, `temperature_2m_min`, `precipitation_sum`, `wind_speed_10m_max`, `shortwave_radiation_sum`, plus `location`, `date`, `summary`.
  - `ghcn_daily_cleaned.parquet` -- columns include `temp_mean_c`, `temp_max_c`, `temp_min_c`, `precipitation_mm`, `location`, `date`, `summary`.
- **Weather profiles**: Notebook 04 (`apps/datascience/jupyter/notebooks/04_weather_profiles.ipynb`) produces `weather-analytics/profiles/weather_profiles_v1.json` with per-location, per-month `temp_mean`, `temp_std`, `temp_min`, `temp_max`, and label probabilities.
- **Shared helpers**: `apps/datascience/shared/minio_helper.py` provides `get_client()`, `read_parquet()`, `upload_file()`, `upload_dataframe()`, `object_exists()`, and `ensure_bucket()`.
- **Open-Meteo variables** available in `weather_sources.py` include `temperature_2m_mean`, `precipitation_sum`, `wind_speed_10m_max`, `wind_gusts_10m_max`, and `shortwave_radiation_sum` -- all usable as Isolation Forest features.
- **No existing notebook** covers anomaly detection beyond the z-score approach in the DAG.

## Implementation Steps

### 1. Create the notebook file

Create `apps/datascience/jupyter/notebooks/06_anomaly_detection.ipynb` following the same structure as Notebooks 03 and 04 (markdown intro cell, imports cell, data loading, analysis, export).

### 2. Introductory markdown cell

Explain the motivation: z-scores are univariate and assume Gaussian distributions. Isolation Forest handles multi-dimensional, non-Gaussian anomalies. The notebook will validate whether the simpler method is adequate or whether multi-feature detection catches anomalies the z-score misses.

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
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
import joblib
import io
import json

from minio_helper import get_client, read_parquet, object_exists, ensure_bucket, upload_file
```

Add `scikit-learn` and `joblib` to the Jupyter container's requirements if not already present (check `apps/datascience/jupyter/` for a Containerfile or requirements file).

### 4. Load cleaned data from MinIO

Load `clean-weather/open_meteo_daily_cleaned.parquet` using `read_parquet()`. This is the preferred source because it has multi-dimensional weather features (temperature, precipitation, wind speed). Also load the weather profiles JSON from `weather-analytics/profiles/weather_profiles_v1.json` for the z-score comparison.

### 5. Feature selection and engineering

Select features for Isolation Forest:
- `temperature_2m_mean` (or `temp_mean_c` for GHCN)
- `precipitation_sum`
- `wind_speed_10m_max`

Engineer additional features:
- `temp_deviation`: difference between daily temperature and monthly mean from the profile
- `month` (as a numeric feature to capture seasonality)
- Drop rows with NaN in any feature column

Explain in a markdown cell why these features capture different anomaly dimensions: a day can have a normal temperature but extreme wind, or normal wind but unusual precipitation.

### 6. Standardize features

Use `sklearn.preprocessing.StandardScaler` to normalize all features to zero mean and unit variance before passing to Isolation Forest. Store the scaler for export alongside the model.

### 7. Train Isolation Forest

```python
iso_forest = IsolationForest(
    n_estimators=200,
    contamination=0.02,  # expect ~2% anomalies
    random_state=42,
    n_jobs=-1,
)
iso_forest.fit(X_scaled)
```

Add the anomaly scores and labels (-1 = anomaly, 1 = normal) to the DataFrame.

### 8. Compute z-score anomalies for comparison

For each row, compute the z-score using the profile's monthly mean and std (same logic as `dag_quality_report.py` lines 244-253). Flag rows with |z| > 3.0 as z-score anomalies.

### 9. Compare the two methods

- **Overlap analysis**: Venn diagram or confusion matrix showing agreement/disagreement between z-score and Isolation Forest flags.
- **Scatter plot**: 2D scatter of temperature vs. wind speed, colored by anomaly method (z-score only, IF only, both, neither).
- **Table**: Show the top 20 anomalies from each method with all feature values, highlighting cases caught by one method but not the other.
- **Summary statistics**: Total anomaly count per method, overlap percentage, unique anomalies per method.

### 10. Per-location anomaly analysis

Group anomalies by location. Show a bar chart of anomaly rates per city for each method. Discuss whether tropical cities (Singapore) have different anomaly patterns than temperate ones (New York).

### 11. Feature importance via anomaly score correlation

Compute Spearman correlation between each feature and the Isolation Forest anomaly score. Show which features contribute most to anomaly detection. This guides whether multi-feature detection adds value over temperature-only z-scores.

### 12. Export the trained model to MinIO

```python
# Save model and scaler
joblib.dump(iso_forest, '/tmp/isolation_forest_v1.joblib')
joblib.dump(scaler, '/tmp/scaler_v1.joblib')

client = get_client()
ensure_bucket(client, 'weather-analytics')
upload_file(client, 'weather-analytics', 'models/isolation_forest_v1.joblib', '/tmp/isolation_forest_v1.joblib')
upload_file(client, 'weather-analytics', 'models/scaler_v1.joblib', '/tmp/scaler_v1.joblib')
```

Also save a metadata JSON alongside the model recording: training date, feature names, contamination parameter, number of training samples, and anomaly rate.

### 13. Conclusion markdown cell

Summarize whether Isolation Forest catches meaningful anomalies that z-scores miss. Recommend whether the quality report DAG should be updated to use multi-feature detection, or whether the z-score is sufficient for the current use case.

## Files to Create/Modify

- **Create**: `apps/datascience/jupyter/notebooks/06_anomaly_detection.ipynb`
- **Possibly modify**: Jupyter container's requirements/Containerfile to add `scikit-learn` and `joblib` (check if already present)
- **No changes** to `dag_quality_report.py` in this notebook -- the notebook is exploratory; DAG integration would be a separate step

## Testing

1. **Data loading**: Verify the notebook loads Open-Meteo cleaned Parquet from MinIO without errors. Confirm expected columns exist.
2. **Model training**: Confirm Isolation Forest trains without errors and produces anomaly scores for all rows. Check that ~2% of rows are flagged (matching the `contamination` parameter).
3. **Z-score comparison**: Verify that the z-score implementation matches the logic in `dag_quality_report.py` by spot-checking a few known values against the profile JSON.
4. **Visualizations**: Confirm all plots render (scatter, bar charts, confusion matrix). Check that the overlap analysis produces plausible numbers (some overlap expected, not 100%).
5. **Model export**: Verify the joblib files appear in MinIO under `weather-analytics/models/`. Download and reload the model to confirm it produces the same predictions.
6. **End-to-end**: Run all cells top to bottom in a fresh kernel to confirm no cell-order dependencies.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `scikit-learn` not installed in the Jupyter container | Check container image. If missing, add to requirements and rebuild. The notebook should fail fast on import with a clear error message. |
| Open-Meteo cleaned data missing wind/precipitation columns | The feature selection step should check for column existence and fall back to temperature-only features with a warning. |
| Isolation Forest contamination parameter poorly tuned | Use 0.02 as a starting point (industry default for rare anomalies). Include a cell that tests contamination values from 0.01 to 0.05 and shows how the anomaly count changes. |
| Pickle/joblib model files are not portable across Python versions | Document the Python and scikit-learn versions in the metadata JSON. Consider also exporting model parameters as JSON for reproducibility. |
| Large dataset causes memory issues in the Jupyter container | The Open-Meteo dataset is ~5 cities x 5 years x 365 days = ~9,000 rows. This is small and will not cause memory issues. |

## Dependencies

- **Required before starting**: Notebooks 03 and 04 must have been run at least once to populate `clean-weather/` and `weather-analytics/profiles/` in MinIO.
- **Benefits from**: The "DAG to fetch Open-Meteo forecast data" idea would provide forecast vs. actual comparison data, enabling anomaly detection on forecast errors rather than just historical observations.
- **Feeds into**: If Isolation Forest proves valuable, the model could be loaded in a future version of `dag_quality_report.py` to supplement or replace z-score anomaly detection.

## Estimated Complexity

**Medium** -- The core scikit-learn implementation is straightforward, but the comparison analysis, visualizations, and model export add scope. Expect 3-5 hours of implementation and testing.

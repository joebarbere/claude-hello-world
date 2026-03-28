# Plan: Incremental/Delta Ingestion for GHCN-Daily

## Goal

Replace the full-file re-download strategy in `dag_download_weather.py` with incremental ingestion that tracks the latest ingested date per station, downloads only new rows, and avoids redundant storage growth in MinIO and DuckDB.

## Current State

- `apps/datascience/airflow/dags/dag_download_weather.py` downloads the **entire** GHCN station CSV on every run (via `download_ghcn_station()` in `apps/datascience/shared/weather_sources.py`). Files can be 10-50 MB per station (150+ years of daily data for long-record stations like New York Central Park).
- The download is guarded by a `ShortCircuitOperator` that checks if the MinIO object `weather-raw/ghcn/{STATION_ID}.csv` already exists. If it does, the download is skipped entirely. This means the data is **never updated** after the first successful download -- new daily observations are silently lost.
- The GHCN HTTPS endpoint (`https://www.ncei.noaa.gov/pub/data/ghcn/daily/by_station/{STATION_ID}.csv`) only serves the full station file; there is no delta/incremental API.
- Five stations are configured: New York (USW00094728), Los Angeles (USW00023174), London (UKW00035065), Tokyo (JA000047662), Melbourne (ASN00086282).
- Cleaned data ends up in `clean-weather/*.parquet` (via Notebook 03) and `weather_observations_clean` in DuckDB (via Notebook 03, Cell 22).
- The DuckDB file is stored at `weather-analytics/duckdb/weather.duckdb` in MinIO.
- Airflow uses SequentialExecutor with SQLite. No Postgres database is available to the DAG without additional configuration, though Postgres is accessible at `host.containers.internal:5432`.

## Implementation Steps

### Step 1: Choose a Metadata Tracking Strategy

Since the DAG currently has no durable metadata store beyond MinIO and the SQLite-backed Airflow, the most robust option is to **store metadata in MinIO itself** as a small JSON file.

**Metadata file**: `weather-analytics/metadata/ghcn_ingestion_state.json`
```json
{
  "USW00094728": {
    "latest_date": "2026-03-27",
    "row_count": 56823,
    "last_ingested_at": "2026-03-28T02:15:00Z",
    "file_size_bytes": 15234567
  },
  "USW00023174": {
    "latest_date": "2026-03-27",
    "row_count": 29456,
    "last_ingested_at": "2026-03-28T02:16:00Z",
    "file_size_bytes": 8234123
  }
}
```

Alternative: store metadata in DuckDB alongside the observation data. This is simpler but couples the ingestion DAG to DuckDB, which is currently only used by the analytics pipeline.

**Recommendation**: MinIO JSON file. It is self-contained, readable, and does not require additional dependencies.

### Step 2: Create Ingestion State Helper

Add `apps/datascience/shared/ingestion_state.py`:

```python
"""
ingestion_state.py
==================
Track the latest ingested date per GHCN station to enable incremental ingestion.
State is stored as a JSON file in MinIO.
"""
import json
import io
import logging
from datetime import datetime, timezone
from minio_helper import get_client, ensure_bucket, object_exists

log = logging.getLogger(__name__)

STATE_BUCKET = "weather-analytics"
STATE_OBJECT = "metadata/ghcn_ingestion_state.json"


def load_state(client=None):
    """Load the ingestion state dict from MinIO. Returns {} if not found."""
    if client is None:
        client = get_client()
    if not object_exists(client, STATE_BUCKET, STATE_OBJECT):
        return {}
    response = client.get_object(STATE_BUCKET, STATE_OBJECT)
    try:
        return json.loads(response.read().decode("utf-8"))
    finally:
        response.close()
        response.release_conn()


def save_state(state, client=None):
    """Persist the ingestion state dict to MinIO."""
    if client is None:
        client = get_client()
    ensure_bucket(client, STATE_BUCKET)
    data = json.dumps(state, indent=2).encode("utf-8")
    buf = io.BytesIO(data)
    client.put_object(
        STATE_BUCKET, STATE_OBJECT, buf,
        length=len(data), content_type="application/json",
    )


def get_latest_date(state, station_id):
    """Return the latest ingested date string for a station, or None."""
    entry = state.get(station_id, {})
    return entry.get("latest_date")


def update_station(state, station_id, latest_date, row_count, file_size):
    """Update state for one station."""
    state[station_id] = {
        "latest_date": latest_date,
        "row_count": row_count,
        "last_ingested_at": datetime.now(timezone.utc).isoformat(),
        "file_size_bytes": file_size,
    }
```

### Step 3: Modify the Download DAG

Refactor `apps/datascience/airflow/dags/dag_download_weather.py`:

**Remove** the `ShortCircuitOperator` check for GHCN stations. The current logic skips downloads entirely if the file exists, which prevents updates.

**Replace** `_download_and_upload_ghcn()` with `_incremental_ghcn_ingest()`:

```python
def _incremental_ghcn_ingest(station_id: str, **context) -> None:
    """
    Download the full GHCN CSV, filter to only new rows since the last
    ingestion, and upload the delta + update the full file in MinIO.
    """
    import pandas as pd
    from ingestion_state import load_state, save_state, get_latest_date, update_station

    client = get_client()
    state = load_state(client)
    latest_date = get_latest_date(state, station_id)

    # Download full CSV (GHCN has no delta endpoint)
    local_path = download_ghcn_station(station_id, output_dir="/tmp")
    file_size = os.path.getsize(local_path)

    # Read and parse
    df = pd.read_csv(
        local_path,
        header=None,
        names=["station", "date", "element", "value",
               "m_flag", "q_flag", "s_flag", "obs_time"],
        parse_dates=["date"],
        dtype={"station": str, "element": str, "value": float},
    )

    new_latest = df["date"].max().strftime("%Y-%m-%d")

    if latest_date:
        # Filter to rows newer than the last ingestion
        delta = df[df["date"] > pd.Timestamp(latest_date)]
        log.info(
            "Station %s: %d total rows, %d new since %s",
            station_id, len(df), len(delta), latest_date,
        )
    else:
        delta = df
        log.info(
            "Station %s: first ingestion, %d rows",
            station_id, len(df),
        )

    # Upload the full file (replace) -- downstream notebooks expect the full file
    upload_file(client, _BUCKET, f"ghcn/{station_id}.csv", local_path, "text/csv")

    # Upload the delta as a separate Parquet file for efficient downstream use
    if len(delta) > 0:
        from minio_helper import upload_dataframe
        upload_dataframe(
            client, _BUCKET,
            f"ghcn-delta/{station_id}/{new_latest}.parquet",
            delta,
            file_format="parquet",
        )
        log.info("Uploaded delta: %d rows", len(delta))

    # Update state
    update_station(state, station_id, new_latest, len(df), file_size)
    save_state(state, client)

    # Cleanup
    os.remove(local_path)
```

**Key design decisions**:
- The **full CSV is still uploaded** to `weather-raw/ghcn/{STATION_ID}.csv` because Notebooks 03 and 04 expect the full file there. This ensures backward compatibility.
- A **delta Parquet file** is additionally saved to `weather-raw/ghcn-delta/{STATION_ID}/{YYYY-MM-DD}.parquet`. This enables efficient incremental loading into DuckDB without re-processing the entire history.
- The ShortCircuitOperator for GHCN is removed so the DAG runs every day, but the actual network download still happens (GHCN has no delta endpoint). The optimization is in **downstream processing**, not download avoidance.

### Step 4: Add HTTP Caching Headers (Optional Optimization)

Check if the GHCN HTTPS server supports `If-Modified-Since` or `ETag` headers. If so, add conditional GET logic to `download_ghcn_station()`:

```python
def download_ghcn_station(station_id, output_dir="/tmp", timeout_seconds=120,
                          last_modified=None):
    headers = {}
    if last_modified:
        headers["If-Modified-Since"] = last_modified

    response = requests.get(url, headers=headers, timeout=timeout_seconds, stream=True)
    if response.status_code == 304:
        log.info("Station %s: not modified since %s, skipping download", station_id, last_modified)
        return None  # signal to caller that no download was needed

    response.raise_for_status()
    # ... proceed with download
```

Store the `Last-Modified` response header in the ingestion state JSON. This avoids downloading multi-MB files when the upstream data has not changed.

### Step 5: Optimize DuckDB Loading (Future)

Once delta Parquet files exist in `weather-raw/ghcn-delta/`, Notebook 03 or a future DAG can load **only the deltas** instead of re-processing the full CSV:

```python
# In Notebook 03 or a new incremental loading DAG
delta_objects = client.list_objects(BUCKET, prefix=f"ghcn-delta/{station_id}/")
for obj in delta_objects:
    if obj.object_name > last_loaded_delta:
        delta_df = read_parquet(client, BUCKET, obj.object_name)
        # Insert into DuckDB (append, not replace)
```

This step is not part of the initial implementation but is enabled by it.

## Files to Create/Modify

- **Create** `apps/datascience/shared/ingestion_state.py` -- metadata tracking helper
- **Modify** `apps/datascience/airflow/dags/dag_download_weather.py` -- replace GHCN ShortCircuit + download/upload with incremental ingest tasks
- **Modify** `apps/datascience/shared/weather_sources.py` -- add `last_modified` support to `download_ghcn_station()` (optional)

## Testing

1. **First run (no state exists)**:
   - Delete `weather-analytics/metadata/ghcn_ingestion_state.json` from MinIO.
   - Trigger the DAG. All rows should be treated as new.
   - Verify the state file is created with correct `latest_date` for each station.
   - Verify full CSV exists at `weather-raw/ghcn/{STATION_ID}.csv`.
   - Verify delta Parquet exists at `weather-raw/ghcn-delta/{STATION_ID}/{date}.parquet`.

2. **Second run (state exists, no new data)**:
   - Trigger again immediately. The delta should contain 0 new rows (since GHCN updates daily).
   - Verify the state file `latest_date` is unchanged.
   - Verify no new delta Parquet file is created (or an empty one is created -- decide on convention).

3. **Simulate new data**:
   - Manually set `latest_date` in the state file to 7 days ago.
   - Trigger the DAG. The delta should contain ~7 days of rows per station.
   - Verify the delta Parquet file contains only those rows.

4. **Backward compatibility**: Run Notebook 03 after the DAG. It should still load the full CSV from `weather-raw/ghcn/{STATION_ID}.csv` without any changes.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Full file download still required (GHCN has no delta API) | The network cost is unchanged, but downstream processing is faster. Document that the optimization is on the storage/processing side, not the download side. |
| State file corruption (e.g., partial write to MinIO) | MinIO writes are atomic (PUT). If the write fails, the old state is preserved and the next run re-processes from the old checkpoint. |
| State file deleted accidentally | The DAG falls back to "first run" behavior and re-ingests everything. No data loss, just redundant work. |
| Delta Parquet files accumulate over time | Add a cleanup task to the DAG that deletes delta files older than 30 days. Or set a MinIO lifecycle policy on the `ghcn-delta/` prefix. |
| GHCN CSV format changes (columns added/removed) | The column list is hardcoded in `weather_sources.py`. A format change would break both the current and incremental code equally. No new risk introduced. |
| `pandas` import adds overhead to Airflow task | `pandas` is already installed in the Airflow container (used by `minio_helper.py`). No new dependency. |

## Dependencies

- **None strictly required.** This change is self-contained within the existing download DAG.
- **Benefits from** "Use Postgres for Airflow metadata" (IDEAS.md) -- metadata could be stored in Postgres instead of a MinIO JSON file, providing transactional guarantees.
- **Enables** `plan-dag-data-validation.md` -- the validation DAG can use the `latest_date` from the state file to know which rows are new and need validation.
- **Enables** `plan-notebook-forecast-skill.md` -- incremental ingestion ensures actuals are always up-to-date for forecast verification.

## Estimated Complexity

**Small-Medium** -- The core change is adding a metadata JSON file and a pandas date filter to the existing download task. The HTTP caching and DuckDB optimization are optional follow-ups. No new containers, no schema changes, no new DAGs.

# Plan: DAG End-to-End Integration Tests

## Goal

Add automated pytest-based integration tests that execute the Airflow DAG task functions directly (without the Airflow scheduler) against a test MinIO bucket with fixture data, verifying the full pipeline from data ingestion through DuckDB upsert to quality report generation.

## Current State

- **DAGs**: Three DAGs exist in `apps/datascience/airflow/dags/`:
  - `dag_download_weather.py` — downloads GHCN-Daily and Open-Meteo data to MinIO bucket `weather-raw`.
  - `dag_kafka_cdc_to_duckdb.py` — consumes Kafka CDC events, upserts to DuckDB, uploads to MinIO bucket `weather-analytics`.
  - `dag_quality_report.py` — loads profiles and recent forecasts from DuckDB, generates a quality score, uploads report to MinIO bucket `weather-analytics`.
- **Shared helpers**: `apps/datascience/shared/minio_helper.py` provides `get_client()`, `ensure_bucket()`, `object_exists()`, `upload_file()`, `read_csv()`. `apps/datascience/shared/weather_sources.py` provides download functions and station/location constants.
- **MinIO configuration**: All helpers default to `localhost:9000` with `minioadmin/minioadmin` credentials, configurable via `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` environment variables.
- **DuckDB schema**: `dag_kafka_cdc_to_duckdb.py` defines DDL for `weather_forecasts_cdc`, `weather_observations_raw`, and a `daily_summary` view (lines 123-167).
- **Quality report logic**: `dag_quality_report.py` compares forecasts against a weather profile JSON, computing z-scores and label consistency checks. Expects the profile at `weather-analytics/profiles/weather_profiles_v1.json`.
- **No DAG tests exist today.** The DAGs are only tested manually via the Airflow UI. There are no pytest fixtures, no test MinIO buckets, and no CI integration for DAG validation.
- **CI pipeline**: `.github/workflows/ci.yml` runs .NET and Angular tests but has no Python test jobs for the datascience code.
- **Airflow container**: `apps/datascience/airflow/Containerfile` installs `duckdb`, `minio`, `pandas`, `confluent-kafka[schema-registry]`, `fastavro`, among others.

## Implementation Steps

### 1. Create the test project structure

Create `apps/datascience/tests/` with:

```
apps/datascience/tests/
  conftest.py
  requirements.txt
  fixtures/
    ghcn_sample.csv
    open_meteo_sample.csv
    weather_profiles_v1.json
    cdc_batch_sample.json
  test_dag_download_weather.py
  test_dag_kafka_cdc_to_duckdb.py
  test_dag_quality_report.py
  test_minio_helper.py
```

### 2. Create requirements.txt

```
duckdb>=1.0
fastavro>=1.9.0
minio>=7.2
pandas>=2.0
pytest>=8.0
pytest-mock>=3.12
responses>=0.25
```

Note: `apache-airflow` is NOT listed as a dependency. The tests call the DAG task functions directly, mocking only the Airflow-specific `ti` (TaskInstance) XCom interface. This avoids the heavyweight Airflow install and SQLite database setup.

### 3. Create test fixtures

**`fixtures/ghcn_sample.csv`**: A minimal GHCN-Daily CSV with 10 rows for station `USW00094728` (Central Park, NY) covering a known date range. Use real data format:

```csv
STATION,DATE,DATATYPE,VALUE,ATTRIBUTES
USW00094728,2024-01-01,TMAX,56,
USW00094728,2024-01-01,TMIN,28,
...
```

**`fixtures/open_meteo_sample.csv`**: A minimal Open-Meteo daily CSV with 10 rows for New York. Headers match the `OPEN_METEO_DAILY_VARIABLES` from `weather_sources.py`.

**`fixtures/weather_profiles_v1.json`**: A minimal profile with one location and two months of statistics, matching the structure expected by `dag_quality_report.py`:

```json
{
  "new_york": {
    "1": {"temp_mean": 1.5, "temp_std": 5.2},
    "7": {"temp_mean": 25.3, "temp_std": 4.1}
  }
}
```

**`fixtures/cdc_batch_sample.json`**: A batch of 5 CDC events in the format produced by `_consume_cdc_events()`, with a mix of `c`, `u`, and `d` operations:

```json
[
  {
    "offset": 0, "partition": 0, "timestamp_ms": 1710000000000,
    "value": {
      "before": null,
      "after": {"Id": 1, "Date": 19723, "TemperatureC": 22, "Summary": "Warm"},
      "op": "c", "ts_ms": 1710000000000
    }
  },
  ...
]
```

### 4. Create conftest.py with MinIO test bucket management

```python
"""
conftest.py — shared fixtures for DAG integration tests.

Uses a dedicated MinIO bucket prefix (test-*) to avoid polluting
production buckets. Requires a running MinIO instance at localhost:9000
(or the URL specified by MINIO_ENDPOINT).
"""
import os
import json
import pytest
from pathlib import Path
from unittest.mock import MagicMock

# Point shared helpers at test buckets
FIXTURES_DIR = Path(__file__).parent / "fixtures"

@pytest.fixture
def mock_ti():
    """Mock Airflow TaskInstance for XCom pull/push."""
    ti = MagicMock()
    xcom_store = {}

    def xcom_push(key, value):
        xcom_store[key] = value

    def xcom_pull(task_ids=None, key="return_value"):
        return xcom_store.get(f"{task_ids}:{key}") or xcom_store.get(task_ids)

    ti.xcom_push = xcom_push
    ti.xcom_pull = xcom_pull
    ti._xcom_store = xcom_store
    return ti

@pytest.fixture
def minio_test_client():
    """Return a MinIO client and create test buckets. Cleanup after test."""
    from minio import Minio
    client = Minio(
        os.environ.get("MINIO_ENDPOINT", "localhost:9000"),
        access_key=os.environ.get("MINIO_ACCESS_KEY", "minioadmin"),
        secret_key=os.environ.get("MINIO_SECRET_KEY", "minioadmin"),
        secure=False,
    )

    test_buckets = ["test-weather-raw", "test-weather-analytics"]
    for bucket in test_buckets:
        if not client.bucket_exists(bucket):
            client.make_bucket(bucket)

    yield client

    # Cleanup: remove all objects and buckets
    for bucket in test_buckets:
        if client.bucket_exists(bucket):
            for obj in client.list_objects(bucket, recursive=True):
                client.remove_object(bucket, obj.object_name)
            client.remove_bucket(bucket)

@pytest.fixture
def fixtures_dir():
    return FIXTURES_DIR
```

### 5. Write test_minio_helper.py

Test the shared helper functions in isolation:

```python
def test_ensure_bucket_creates_missing_bucket(minio_test_client):
    """ensure_bucket should create the bucket if it does not exist."""
    ...

def test_object_exists_returns_false_for_missing(minio_test_client):
    """object_exists should return False for a non-existent object."""
    ...

def test_upload_and_read_csv_roundtrip(minio_test_client, tmp_path):
    """Upload a CSV file and read it back as a DataFrame."""
    ...
```

### 6. Write test_dag_download_weather.py

Test the download DAG's check and upload logic with mocked HTTP responses:

```python
import responses

@responses.activate
def test_download_ghcn_station_stores_to_minio(minio_test_client, monkeypatch):
    """Mock the NOAA HTTP endpoint and verify the CSV lands in MinIO."""
    responses.add(
        responses.GET,
        "https://www.ncei.noaa.gov/data/global-historical-climatology-network-daily/access/USW00094728.csv",
        body=open(FIXTURES_DIR / "ghcn_sample.csv").read(),
        status=200,
    )
    # Monkeypatch the bucket name to use test bucket
    ...

def test_check_minio_object_skips_when_exists(minio_test_client):
    """ShortCircuitOperator callable returns False when object exists."""
    ...
```

### 7. Write test_dag_kafka_cdc_to_duckdb.py

Test the DuckDB upsert logic without a running Kafka broker:

```python
def test_load_batch_creates_duckdb_and_upserts(minio_test_client, mock_ti, tmp_path, fixtures_dir):
    """
    Given a pre-written CDC batch JSON file, _load_batch_to_duckdb should:
    1. Create a new DuckDB file with the expected schema.
    2. Upsert all create/update events.
    3. Apply delete events.
    4. Upload the DuckDB file to MinIO.
    """
    ...

def test_load_batch_handles_empty_batch(minio_test_client, mock_ti, tmp_path):
    """An empty batch file should be a no-op."""
    ...

def test_load_batch_upsert_is_idempotent(minio_test_client, mock_ti, tmp_path, fixtures_dir):
    """Loading the same batch twice should not create duplicate rows."""
    ...

def test_delete_operation_removes_row(minio_test_client, mock_ti, tmp_path, fixtures_dir):
    """A CDC delete event should remove the row from DuckDB."""
    ...
```

### 8. Write test_dag_quality_report.py

Test the quality report generation with controlled fixture data:

```python
def test_quality_report_with_realistic_forecasts(mock_ti, fixtures_dir):
    """
    Given a profile and forecasts within normal ranges,
    the quality score should be close to 100.
    """
    ...

def test_quality_report_with_anomalous_forecasts(mock_ti, fixtures_dir):
    """
    Given forecasts with extreme temperatures (z > 3),
    the quality score should be significantly below 100.
    """
    ...

def test_quality_report_with_label_violations(mock_ti, fixtures_dir):
    """
    Given forecasts where Summary labels don't match TemperatureC
    (e.g., 'Scorching' at 10C), violation_count should be non-zero.
    """
    ...

def test_quality_report_no_forecasts(mock_ti):
    """With no forecasts, report should have null quality_score."""
    ...

def test_save_report_uploads_to_minio(minio_test_client, mock_ti):
    """_save_report should upload the report JSON to the correct MinIO path."""
    ...
```

### 9. Add an Nx project target

Add to `apps/datascience/project.json`:

```json
{
  "targets": {
    "integration-test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "python -m pytest apps/datascience/tests/ -v --tb=short",
        "cwd": "{workspaceRoot}"
      }
    }
  }
}
```

### 10. Add to CI pipeline

Add a new job to `.github/workflows/ci.yml`:

```yaml
  dag-integration-tests:
    runs-on: ubuntu-latest
    services:
      minio:
        image: minio/minio:latest
        ports:
          - 9000:9000
        env:
          MINIO_ROOT_USER: minioadmin
          MINIO_ROOT_PASSWORD: minioadmin
        options: >-
          --health-cmd "curl -f http://localhost:9000/minio/health/live || exit 1"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        # minio server command passed via entrypoint workaround
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install test dependencies
        run: pip install -r apps/datascience/tests/requirements.txt

      - name: Run DAG integration tests
        env:
          MINIO_ENDPOINT: localhost:9000
          MINIO_ACCESS_KEY: minioadmin
          MINIO_SECRET_KEY: minioadmin
        run: python -m pytest apps/datascience/tests/ -v --tb=short --junitxml=dag-test-results.xml

      - name: Publish test results
        if: always()
        uses: dorny/test-reporter@v2
        with:
          name: DAG Integration Tests
          path: dag-test-results.xml
          reporter: java-junit
          fail-on-error: 'false'
```

Note: The MinIO service container provides a real MinIO instance for the tests. The tests that validate DuckDB logic and quality report generation do NOT need MinIO (they work with local files), so a subset of tests can run even if the service container fails.

### 11. Add pytest markers for selective execution

In `apps/datascience/tests/conftest.py`, register markers:

```python
def pytest_configure(config):
    config.addinivalue_line("markers", "minio: requires a running MinIO instance")
    config.addinivalue_line("markers", "slow: tests that take >5 seconds")
```

Tests that require MinIO get the `@pytest.mark.minio` decorator. Developers without MinIO running can skip them: `pytest -m "not minio"`.

## Files to Create/Modify

- **Create** `apps/datascience/tests/requirements.txt`
- **Create** `apps/datascience/tests/conftest.py`
- **Create** `apps/datascience/tests/fixtures/ghcn_sample.csv`
- **Create** `apps/datascience/tests/fixtures/open_meteo_sample.csv`
- **Create** `apps/datascience/tests/fixtures/weather_profiles_v1.json`
- **Create** `apps/datascience/tests/fixtures/cdc_batch_sample.json`
- **Create** `apps/datascience/tests/test_minio_helper.py`
- **Create** `apps/datascience/tests/test_dag_download_weather.py`
- **Create** `apps/datascience/tests/test_dag_kafka_cdc_to_duckdb.py`
- **Create** `apps/datascience/tests/test_dag_quality_report.py`
- **Modify** `apps/datascience/project.json` — add `integration-test` target
- **Modify** `.github/workflows/ci.yml` — add `dag-integration-tests` job

## Testing

1. **Local without MinIO**: Run `python -m pytest apps/datascience/tests/ -m "not minio" -v`. Tests for quality report logic and DuckDB upsert work with local temp files only.
2. **Local with MinIO**: Start MinIO (`nx kube-up kafka` or `podman run -p 9000:9000 minio/minio server /data`), then run the full suite: `python -m pytest apps/datascience/tests/ -v`.
3. **Verify fixture data**: Manually inspect that `cdc_batch_sample.json` events produce the expected DuckDB rows by running `test_load_batch_creates_duckdb_and_upserts` in isolation.
4. **CI**: Push a branch and verify the `dag-integration-tests` job passes with the MinIO service container.
5. **Break it on purpose**: Modify the DuckDB DDL in `dag_kafka_cdc_to_duckdb.py` (e.g., rename a column) and confirm the integration tests fail.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| MinIO service container may not start reliably in CI | Tests are split into `minio` and non-`minio` markers. Core logic tests (quality report, DuckDB upsert with local files) run without MinIO. |
| Importing DAG modules pulls in `airflow` package, which is heavy | The test imports the task callable functions directly, not the DAG module. Use `monkeypatch` or restructure: extract pure logic into `apps/datascience/shared/` and test those functions. |
| `sys.path` manipulation in DAG files (`_SHARED_DIR`) may cause import issues in pytest | The `conftest.py` fixture adds `apps/datascience/shared/` and `apps/datascience/airflow/dags/shared/` (the symlinked location) to `sys.path` before tests run. |
| Fixture data becomes stale if DAG schemas change | Fixture files are minimal (5-10 rows each) and documented. Include a comment in each fixture with the date it was created and the schema version. |
| DuckDB version mismatch between test environment and Airflow container | Pin `duckdb` version in `requirements.txt` to match `apps/datascience/airflow/Containerfile`. |

## Dependencies

- None strictly required.
- **Benefits from**: "Use Postgres for Airflow metadata" (IDEAS.md / `plans/plan-airflow-postgres-metadata.md`) — once Airflow uses Postgres, integration tests could optionally use the Airflow test runner, but the direct-function-call approach works regardless.
- **Benefits from**: "Kafka Avro schema contract tests" (`plans/plan-kafka-contract-tests.md`) — the CDC batch fixture data should match the Avro schema verified by the contract tests.
- **Pairs well with**: "Hot-reload for DAG development" (IDEAS.md) — both improve the DAG development inner loop.

## Estimated Complexity

**Medium** — Requires creating fixture data, handling `sys.path` for DAG imports, and setting up the MinIO service container in CI. The test logic itself is straightforward since the DAG task functions are pure Python. Estimated 4-6 hours of implementation.

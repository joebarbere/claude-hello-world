"""
dag_download_weather.py
=======================
DAG 1: Download open weather datasets and store them in MinIO.

Schedule: daily at 02:00 UTC
Catchup: disabled (we do not want to backfill years of downloads)

Task graph
----------
check_ghcn_[station]  ──►  download_ghcn_[station]  ──►  upload_ghcn_[station]  ─┐
                                                                                   ├──► all_done
check_meteo_[loc]     ──►  download_meteo_[loc]      ──►  upload_meteo_[loc]     ─┘

The "check" tasks query MinIO for today's object key. If the object already
exists the corresponding download+upload tasks are skipped via short-circuit.
This prevents redundant HTTP downloads on manual re-runs.

Data sources
------------
- NOAA GHCN-Daily per-station CSVs (no API key)
- Open-Meteo Historical Weather API (no API key)

MinIO layout
------------
Bucket: weather-raw
  ghcn/{STATION_ID}.csv              — full station history, replaced daily
  open-meteo/{location_label}.csv    — full date-range history, replaced daily

Note on SequentialExecutor
--------------------------
This Airflow instance uses SequentialExecutor (SQLite backend), which runs
one task at a time. The graph above is therefore serialised at runtime even
though dependencies allow parallelism. Tasks are kept small and idempotent
so re-running them is always safe.
"""

import logging
import os
import sys
from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.python import PythonOperator, ShortCircuitOperator

# ---------------------------------------------------------------------------
# Path setup
# The shared/ helpers are mounted at the same hostPath as the dags/ directory
# (see k8s/datascience-pod.yaml). We append the parent of the dags/ directory
# so that `import minio_helper` resolves correctly.
# ---------------------------------------------------------------------------
_DAG_DIR = os.path.dirname(os.path.abspath(__file__))
_SHARED_DIR = os.path.join(_DAG_DIR, "..", "shared")
if _SHARED_DIR not in sys.path:
    sys.path.insert(0, _SHARED_DIR)

from minio_helper import get_client, object_exists, upload_file  # noqa: E402
from weather_sources import (  # noqa: E402
    GHCN_STATIONS,
    OPEN_METEO_LOCATIONS,
    download_ghcn_station,
    download_open_meteo,
)

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# DAG-level defaults
# ---------------------------------------------------------------------------
_DEFAULT_ARGS = {
    "owner": "datascience",
    "depends_on_past": False,
    # Retry once after a 5-minute wait before marking the task as failed.
    # This handles transient network errors from external APIs.
    "retries": 1,
    "retry_delay": timedelta(minutes=5),
    # Alert if a task takes longer than 20 minutes — GHCN files can be large
    "execution_timeout": timedelta(minutes=20),
    "email_on_failure": False,
    "email_on_retry": False,
}

# MinIO bucket where raw files are stored
_BUCKET = "weather-raw"

# Open-Meteo date range — adjust end_date as needed
_METEO_START = "2020-01-01"
_METEO_END = "2024-12-31"

# ---------------------------------------------------------------------------
# Task callables
# ---------------------------------------------------------------------------


def _check_minio_object(bucket: str, object_name: str) -> bool:
    """
    ShortCircuitOperator callable.

    Returns False  → downstream tasks are SKIPPED (object already in MinIO).
    Returns True   → downstream tasks run normally (object needs to be fetched).
    """
    client = get_client()
    exists = object_exists(client, bucket, object_name)
    if exists:
        log.info("SKIP: %s/%s already exists in MinIO", bucket, object_name)
        return False  # short-circuit: skip downstream
    log.info("PROCEED: %s/%s not found in MinIO", bucket, object_name)
    return True


def _download_and_upload_ghcn(station_id: str, **context) -> None:
    """Download one GHCN station CSV and upload it to MinIO."""
    local_path = download_ghcn_station(station_id, output_dir="/tmp")
    client = get_client()
    upload_file(
        client,
        bucket=_BUCKET,
        object_name=f"ghcn/{station_id}.csv",
        file_path=local_path,
        content_type="text/csv",
    )
    # Clean up the temp file to avoid filling the container's /tmp
    os.remove(local_path)
    log.info("Removed temp file: %s", local_path)


def _download_and_upload_meteo(
    latitude: float,
    longitude: float,
    label: str,
    **context,
) -> None:
    """Download Open-Meteo data for one location and upload it to MinIO."""
    local_path = download_open_meteo(
        latitude=latitude,
        longitude=longitude,
        location_label=label,
        start_date=_METEO_START,
        end_date=_METEO_END,
        output_dir="/tmp",
    )
    client = get_client()
    upload_file(
        client,
        bucket=_BUCKET,
        object_name=f"open-meteo/{label}.csv",
        file_path=local_path,
        content_type="text/csv",
    )
    os.remove(local_path)
    log.info("Removed temp file: %s", local_path)


# ---------------------------------------------------------------------------
# DAG definition
# ---------------------------------------------------------------------------
with DAG(
    dag_id="download_weather_datasets",
    description=(
        "Download NOAA GHCN-Daily and Open-Meteo historical weather data "
        "into MinIO. Skips files that are already present (MinIO-first check)."
    ),
    default_args=_DEFAULT_ARGS,
    schedule_interval="0 2 * * *",  # 02:00 UTC daily
    start_date=datetime(2024, 1, 1),
    catchup=False,
    tags=["weather", "ingestion", "minio"],
    # Document the DAG for the Airflow UI
    doc_md=__doc__,
) as dag:

    # Accumulate terminal tasks so we can wire them all into a final "done" task
    terminal_tasks = []

    # ------------------------------------------------------------------
    # GHCN-Daily: one check + download/upload pair per station
    # ------------------------------------------------------------------
    for station_id, station_label in GHCN_STATIONS:
        object_name = f"ghcn/{station_id}.csv"

        check = ShortCircuitOperator(
            task_id=f"check_ghcn_{station_id}",
            python_callable=_check_minio_object,
            op_kwargs={"bucket": _BUCKET, "object_name": object_name},
            doc_md=(
                f"Check whether {object_name} already exists in MinIO. "
                "If it does, skip the download."
            ),
        )

        fetch = PythonOperator(
            task_id=f"download_upload_ghcn_{station_id}",
            python_callable=_download_and_upload_ghcn,
            op_kwargs={"station_id": station_id},
            doc_md=(
                f"Download GHCN-Daily CSV for station {station_id} "
                f"({station_label}) and upload to MinIO."
            ),
        )

        check >> fetch
        terminal_tasks.append(fetch)

    # ------------------------------------------------------------------
    # Open-Meteo: one check + download/upload pair per location
    # ------------------------------------------------------------------
    for lat, lon, label in OPEN_METEO_LOCATIONS:
        object_name = f"open-meteo/{label}.csv"

        check = ShortCircuitOperator(
            task_id=f"check_meteo_{label}",
            python_callable=_check_minio_object,
            op_kwargs={"bucket": _BUCKET, "object_name": object_name},
            doc_md=(
                f"Check whether {object_name} already exists in MinIO. "
                "If it does, skip the download."
            ),
        )

        fetch = PythonOperator(
            task_id=f"download_upload_meteo_{label}",
            python_callable=_download_and_upload_meteo,
            op_kwargs={"latitude": lat, "longitude": lon, "label": label},
            doc_md=(
                f"Download Open-Meteo daily data for {label} "
                f"({lat:.4f}, {lon:.4f}) and upload to MinIO."
            ),
        )

        check >> fetch
        terminal_tasks.append(fetch)

    # ------------------------------------------------------------------
    # Final task: log completion so the DAG run has a visible end state
    # ------------------------------------------------------------------
    all_done = PythonOperator(
        task_id="all_done",
        python_callable=lambda **ctx: log.info(
            "All weather dataset tasks complete for logical_date=%s",
            ctx.get("logical_date"),
        ),
        doc_md="Dummy terminal task — marks the DAG run as complete.",
    )

    for task in terminal_tasks:
        task >> all_done

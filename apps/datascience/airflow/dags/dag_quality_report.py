"""
dag_quality_report.py
=====================
DAG 3: Generate a daily weather quality report comparing minion-generated
        forecasts against historical weather profiles.

Schedule: daily at 06:00 UTC (after the download DAG at 02:00)
Catchup: disabled

What this DAG does
------------------
1. load_profile
   Downloads the weather profile JSON from MinIO
   (weather-analytics/profiles/weather_profiles_v1.json).
   This file is produced by Notebook 04 and contains monthly temperature
   statistics and Summary label probability distributions for each city.

2. load_recent_forecasts
   Downloads the DuckDB file from MinIO and queries the CDC table for
   forecasts loaded in the last 24 hours.

3. generate_quality_report
   Compares each forecast against the historical profile:
   - Temperature z-score: how many standard deviations is the forecast
     temperature from the historical mean for that month?
   - Label consistency: does the Summary label match the temperature?
     (e.g., "Scorching" should only appear above 40°C)
   - Quality score: 0-100, where 100 means all forecasts are realistic.

4. save_report
   Uploads the quality report JSON to MinIO at
   weather-analytics/reports/quality_YYYY-MM-DD.json.

Why this matters
----------------
Before the minion scheduler is updated to use profiles, this DAG
establishes a baseline quality score. After the update, the score
should improve dramatically — giving concrete evidence that the
data science initiative worked.
"""

import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone

from airflow import DAG
from airflow.operators.python import PythonOperator

_DAG_DIR = os.path.dirname(os.path.abspath(__file__))
_SHARED_DIR = os.path.join(_DAG_DIR, "shared")
if _SHARED_DIR not in sys.path:
    sys.path.insert(0, _SHARED_DIR)

from minio_helper import ensure_bucket, get_client, object_exists  # noqa: E402

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ANALYTICS_BUCKET = "weather-analytics"
PROFILE_OBJECT = "profiles/weather_profiles_v1.json"
DUCKDB_OBJECT = "duckdb/weather.duckdb"
DUCKDB_LOCAL = "/tmp/weather_quality.duckdb"

# Temperature-to-label thresholds (must match Notebook 03)
LABEL_RANGES = {
    "Freezing":   (-999, -5),
    "Bracing":    (-5, 0),
    "Chilly":     (0, 5),
    "Cool":       (5, 12),
    "Mild":       (12, 18),
    "Warm":       (18, 24),
    "Balmy":      (24, 30),
    "Hot":        (30, 35),
    "Sweltering": (35, 40),
    "Scorching":  (40, 999),
}

_DEFAULT_ARGS = {
    "owner": "datascience",
    "depends_on_past": False,
    "retries": 1,
    "retry_delay": timedelta(minutes=5),
    "execution_timeout": timedelta(minutes=15),
    "email_on_failure": False,
    "email_on_retry": False,
}


# ---------------------------------------------------------------------------
# Task 1: Load the weather profile
# ---------------------------------------------------------------------------
def _load_profile(**context) -> str:
    """
    Download the weather profile JSON from MinIO and return it via XCom.
    If the profile does not exist, return an empty dict (the DAG will
    still run but quality checks will be limited).
    """
    client = get_client()

    if not object_exists(client, ANALYTICS_BUCKET, PROFILE_OBJECT):
        log.warning(
            "Profile not found at %s/%s — run Notebook 04 first. "
            "Quality report will use default thresholds only.",
            ANALYTICS_BUCKET,
            PROFILE_OBJECT,
        )
        return json.dumps({})

    response = client.get_object(ANALYTICS_BUCKET, PROFILE_OBJECT)
    try:
        profile_json = response.read().decode("utf-8")
    finally:
        response.close()
        response.release_conn()

    profile = json.loads(profile_json)
    log.info("Loaded profile with %d locations", len(profile))
    return profile_json


# ---------------------------------------------------------------------------
# Task 2: Load recent forecasts from DuckDB
# ---------------------------------------------------------------------------
def _load_recent_forecasts(**context) -> str:
    """
    Query the DuckDB CDC table for forecasts loaded in the last 24 hours.
    Returns a JSON list of forecast dicts via XCom.
    """
    try:
        import duckdb
    except ImportError as exc:
        raise ImportError(f"duckdb not installed: {exc}")

    client = get_client()

    if not object_exists(client, ANALYTICS_BUCKET, DUCKDB_OBJECT):
        log.warning("DuckDB file not found — no forecasts to evaluate")
        return json.dumps([])

    client.fget_object(ANALYTICS_BUCKET, DUCKDB_OBJECT, DUCKDB_LOCAL)
    con = duckdb.connect(DUCKDB_LOCAL, read_only=True)

    try:
        # Check if table exists
        tables = [
            row[0]
            for row in con.execute("SHOW TABLES").fetchall()
        ]
        if "weather_forecasts_cdc" not in tables:
            log.warning("weather_forecasts_cdc table not found")
            return json.dumps([])

        cutoff = datetime.now(tz=timezone.utc) - timedelta(hours=24)

        rows = con.execute(
            """
            SELECT id, date, temperature_c, summary, op, event_ts, loaded_at
            FROM weather_forecasts_cdc
            WHERE loaded_at >= ?
              AND op IN ('c', 'u', 'r')
            ORDER BY loaded_at DESC
            """,
            [cutoff],
        ).fetchall()

        columns = ["id", "date", "temperature_c", "summary", "op", "event_ts", "loaded_at"]
        forecasts = []
        for row in rows:
            d = {}
            for i, col in enumerate(columns):
                val = row[i]
                # Convert non-serializable types
                if hasattr(val, "isoformat"):
                    val = val.isoformat()
                d[col] = val
            forecasts.append(d)

        log.info("Found %d recent forecasts (last 24h)", len(forecasts))
        return json.dumps(forecasts)

    finally:
        con.close()
        if os.path.exists(DUCKDB_LOCAL):
            os.remove(DUCKDB_LOCAL)


# ---------------------------------------------------------------------------
# Task 3: Generate the quality report
# ---------------------------------------------------------------------------
def _generate_quality_report(*, ti, **context) -> str:
    """
    Compare forecasts against the profile and produce a quality report.

    Quality checks:
    1. Temperature z-score: |temp - historical_mean| / historical_std
       - z < 2.0 = normal, 2-3 = unusual, >3 = anomalous
    2. Label consistency: does the Summary label match the temperature?
    3. Overall quality score: 100 - penalty points
    """
    profile_json = ti.xcom_pull(task_ids="load_profile")
    forecasts_json = ti.xcom_pull(task_ids="load_recent_forecasts")

    profile = json.loads(profile_json) if profile_json else {}
    forecasts = json.loads(forecasts_json) if forecasts_json else []

    if not forecasts:
        log.info("No forecasts to evaluate")
        report = {
            "date": datetime.now(tz=timezone.utc).strftime("%Y-%m-%d"),
            "forecast_count": 0,
            "quality_score": None,
            "message": "No forecasts found in the last 24 hours",
        }
        return json.dumps(report, indent=2)

    # Evaluate each forecast
    anomalies = []
    label_violations = []
    z_scores = []
    total = len(forecasts)

    for f in forecasts:
        temp_c = f.get("temperature_c")
        summary = f.get("summary")
        date_str = f.get("date")

        if temp_c is None:
            continue

        # Determine month from the forecast date
        month = None
        if date_str:
            try:
                month = datetime.fromisoformat(str(date_str)).month
            except (ValueError, TypeError):
                pass

        # --- Check 1: Temperature z-score ---
        z = None
        if profile and month:
            # Use the first location as a baseline (global average)
            # In a real deployment, forecasts would have a location field
            for loc_key in profile:
                month_data = profile[loc_key].get(str(month), {})
                mean = month_data.get("temp_mean")
                std = month_data.get("temp_std")
                if mean is not None and std is not None and std > 0:
                    z = abs(temp_c - mean) / std
                    break

        if z is not None:
            z_scores.append(z)
            if z > 3.0:
                anomalies.append({
                    "id": f.get("id"),
                    "temperature_c": temp_c,
                    "z_score": round(z, 2),
                    "month": month,
                })

        # --- Check 2: Label consistency ---
        if summary and summary in LABEL_RANGES:
            lo, hi = LABEL_RANGES[summary]
            if temp_c < lo or temp_c >= hi:
                label_violations.append({
                    "id": f.get("id"),
                    "temperature_c": temp_c,
                    "summary": summary,
                    "expected_range": f"{lo} to {hi}",
                })

    # --- Quality score ---
    # Start at 100, deduct points for anomalies and violations
    if total > 0:
        anomaly_rate = len(anomalies) / total
        violation_rate = len(label_violations) / total
        # Deduct up to 50 points for anomalies, up to 50 for violations
        score = max(0, 100 - (anomaly_rate * 50 + violation_rate * 50) * 100)
        score = round(score, 1)
    else:
        score = None

    avg_z = round(sum(z_scores) / len(z_scores), 2) if z_scores else None

    report = {
        "date": datetime.now(tz=timezone.utc).strftime("%Y-%m-%d"),
        "forecast_count": total,
        "quality_score": score,
        "temperature_analysis": {
            "avg_z_score": avg_z,
            "anomaly_count": len(anomalies),
            "anomaly_rate": round(len(anomalies) / total, 4) if total > 0 else 0,
            "top_anomalies": anomalies[:10],
        },
        "label_consistency": {
            "violation_count": len(label_violations),
            "violation_rate": round(len(label_violations) / total, 4) if total > 0 else 0,
            "sample_violations": label_violations[:10],
        },
        "interpretation": {
            "quality_score": (
                "The quality score ranges from 0 (all forecasts are anomalous) "
                "to 100 (all forecasts match historical patterns). "
                "A score below 50 suggests minions are generating unrealistic data."
            ),
            "z_score": (
                "Z-score measures how many standard deviations a forecast is from "
                "the historical mean. Z < 2 is normal, 2-3 is unusual, >3 is anomalous."
            ),
            "label_consistency": (
                "A label violation means the Summary label doesn't match the "
                "temperature (e.g., 'Scorching' at 10°C). Current minions assign "
                "labels randomly, so a high violation rate is expected."
            ),
        },
    }

    log.info(
        "Quality report: score=%.1f, anomalies=%d/%d, violations=%d/%d",
        score if score is not None else -1,
        len(anomalies),
        total,
        len(label_violations),
        total,
    )

    return json.dumps(report, indent=2)


# ---------------------------------------------------------------------------
# Task 4: Save the report to MinIO
# ---------------------------------------------------------------------------
def _save_report(*, ti, **context) -> None:
    """Upload the quality report to MinIO."""
    report_json = ti.xcom_pull(task_ids="generate_quality_report")
    if not report_json:
        log.warning("No report to save")
        return

    client = get_client()
    ensure_bucket(client, ANALYTICS_BUCKET)

    today = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    object_name = f"reports/quality_{today}.json"

    import io

    buf = io.BytesIO(report_json.encode("utf-8"))
    client.put_object(
        ANALYTICS_BUCKET,
        object_name,
        buf,
        length=len(report_json.encode("utf-8")),
        content_type="application/json",
    )

    log.info("Saved quality report to %s/%s", ANALYTICS_BUCKET, object_name)


# ---------------------------------------------------------------------------
# DAG definition
# ---------------------------------------------------------------------------
with DAG(
    dag_id="weather_quality_report",
    description=(
        "Daily quality report comparing minion-generated forecasts against "
        "historical weather profiles. Computes z-scores, checks label "
        "consistency, and produces a quality score (0-100)."
    ),
    default_args=_DEFAULT_ARGS,
    schedule_interval="0 6 * * *",  # 06:00 UTC daily
    start_date=datetime(2024, 1, 1),
    catchup=False,
    tags=["quality", "analytics", "minio"],
    doc_md=__doc__,
    max_active_runs=1,
) as dag:

    load_profile = PythonOperator(
        task_id="load_profile",
        python_callable=_load_profile,
        doc_md="Download weather profile JSON from MinIO.",
    )

    load_forecasts = PythonOperator(
        task_id="load_recent_forecasts",
        python_callable=_load_recent_forecasts,
        doc_md="Query DuckDB for forecasts from the last 24 hours.",
    )

    generate_report = PythonOperator(
        task_id="generate_quality_report",
        python_callable=_generate_quality_report,
        doc_md=(
            "Compare forecasts against historical profiles. "
            "Compute z-scores, check label consistency, produce quality score."
        ),
    )

    save_report = PythonOperator(
        task_id="save_report",
        python_callable=_save_report,
        doc_md="Upload quality report JSON to MinIO.",
    )

    [load_profile, load_forecasts] >> generate_report >> save_report

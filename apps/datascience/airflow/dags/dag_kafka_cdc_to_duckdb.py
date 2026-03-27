"""
dag_kafka_cdc_to_duckdb.py
==========================
DAG 2: Consume Debezium CDC events from Kafka and sync them to a DuckDB
        database file stored in MinIO.

Schedule: every 5 minutes
Catchup: disabled

What this DAG does
------------------
1. consume_cdc_events
   Connects to Kafka (broker: localhost:9092) and reads up to MAX_POLL_RECORDS
   messages from the topic `weather.public.WeatherForecasts`.
   Messages are Avro-encoded with schemas stored in the Schema Registry at
   localhost:8081.
   The task writes a batch JSON file to /tmp/cdc_batch_{run_id}.json and
   pushes the file path via XCom.

2. load_batch_to_duckdb
   Pulls the batch file path from XCom.
   Downloads the DuckDB file from MinIO (or creates it if it does not exist).
   Upserts the CDC events into the `weather_forecasts_cdc` table.
   Uploads the updated DuckDB file back to MinIO.

3. cleanup_temp_files
   Removes the batch JSON and local DuckDB file from /tmp.

Important: SequentialExecutor constraint
-----------------------------------------
Tasks run one at a time. The Kafka consumer uses a short poll window
(POLL_TIMEOUT_SECONDS) and a bounded record count (MAX_POLL_RECORDS) to
keep each task run fast. This is appropriate for a dev environment with
low event volume.

Kafka topic and message format
--------------------------------
Topic: weather.public.WeatherForecasts
Key schema (Avro):
    {"id": int}

Value schema (Avro — Debezium envelope):
    {
      "before": { WeatherForecast fields } | null,
      "after":  { WeatherForecast fields } | null,
      "op":     "c" | "u" | "d" | "r",   # create/update/delete/read(snapshot)
      "ts_ms":  long                       # event timestamp in milliseconds
    }

WeatherForecast fields:
    Id             int
    Date           int   (days since Unix epoch — NOQA: Debezium encodes date as int32)
    TemperatureC   int
    Summary        str | null

DuckDB table: weather_forecasts_cdc
    id             INTEGER PRIMARY KEY
    date           DATE
    temperature_c  INTEGER
    summary        VARCHAR
    op             VARCHAR    -- last CDC operation: c/u/d/r
    event_ts       TIMESTAMP  -- when Debezium captured the change
    loaded_at      TIMESTAMP  -- when this DAG task ran
"""

import json
import logging
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

from airflow import DAG
from airflow.operators.python import PythonOperator

_DAG_DIR = os.path.dirname(os.path.abspath(__file__))
_SHARED_DIR = os.path.join(_DAG_DIR, "..", "shared")
if _SHARED_DIR not in sys.path:
    sys.path.insert(0, _SHARED_DIR)

from minio_helper import ensure_bucket, get_client, object_exists  # noqa: E402

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------
KAFKA_BROKER = os.environ.get("KAFKA_BROKER", "localhost:9092")
SCHEMA_REGISTRY_URL = os.environ.get("SCHEMA_REGISTRY_URL", "http://localhost:8081")
KAFKA_TOPIC = "weather.public.WeatherForecasts"
KAFKA_GROUP_ID = "airflow-cdc-sync"

# How long to wait for messages on each poll call (seconds)
POLL_TIMEOUT_SECONDS = 10

# Maximum records to consume per DAG run to bound task duration
MAX_POLL_RECORDS = 500

# MinIO location for the DuckDB database file
DUCKDB_BUCKET = "weather-analytics"
DUCKDB_OBJECT = "duckdb/weather.duckdb"

# Local temp path for the DuckDB file during the task run
DUCKDB_LOCAL_PATH = "/tmp/weather_airflow.duckdb"

# ---------------------------------------------------------------------------
# Default task arguments
# ---------------------------------------------------------------------------
_DEFAULT_ARGS = {
    "owner": "datascience",
    "depends_on_past": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=2),
    "execution_timeout": timedelta(minutes=10),
    "email_on_failure": False,
    "email_on_retry": False,
}

# ---------------------------------------------------------------------------
# DuckDB schema DDL
# Applied with CREATE TABLE IF NOT EXISTS so it is idempotent.
# ---------------------------------------------------------------------------
_DDL_WEATHER_FORECASTS_CDC = """
CREATE TABLE IF NOT EXISTS weather_forecasts_cdc (
    id             INTEGER PRIMARY KEY,
    date           DATE,
    temperature_c  INTEGER,
    summary        VARCHAR,
    op             VARCHAR,
    event_ts       TIMESTAMP,
    loaded_at      TIMESTAMP
);
"""

_DDL_WEATHER_OBSERVATIONS_RAW = """
-- Raw GHCN-Daily observations loaded from MinIO CSVs.
-- Populated by notebooks or a separate Airflow DAG; defined here so that
-- DuckDB cross-table queries work from the same database file.
CREATE TABLE IF NOT EXISTS weather_observations_raw (
    station_id    VARCHAR,
    date          DATE,
    element       VARCHAR,   -- TMAX, TMIN, PRCP, SNOW, SNWD, etc.
    value         DOUBLE,    -- tenths of degrees C for temperature elements
    m_flag        VARCHAR,   -- measurement flag
    q_flag        VARCHAR,   -- quality flag
    s_flag        VARCHAR,   -- source flag
    obs_time      VARCHAR,   -- time of observation (HHMM string or null)
    loaded_at     TIMESTAMP
);
"""

_DDL_DAILY_SUMMARY = """
-- Pre-aggregated daily summary across all CDC events.
-- Rebuilt as a view so it always reflects the latest data without
-- requiring an explicit refresh step.
CREATE OR REPLACE VIEW daily_summary AS
SELECT
    date,
    COUNT(*)                        AS forecast_count,
    AVG(temperature_c)              AS avg_temp_c,
    MIN(temperature_c)              AS min_temp_c,
    MAX(temperature_c)              AS max_temp_c,
    COUNT(CASE WHEN op = 'd' THEN 1 END) AS delete_count
FROM weather_forecasts_cdc
GROUP BY date
ORDER BY date;
"""


# ---------------------------------------------------------------------------
# Task 1: Consume Kafka CDC events
# ---------------------------------------------------------------------------
def _consume_cdc_events(*, run_id: str, **context) -> str:
    """
    Poll the Kafka topic and write a batch of CDC events to a JSON file.

    Returns the path of the written JSON file (pushed to XCom automatically
    because this function is called by a PythonOperator with
    do_xcom_push=True and we return the value).

    DATA: Assumes messages are Avro-encoded with schemas in the Schema
    Registry. If the topic has no messages within POLL_TIMEOUT_SECONDS the
    function writes an empty batch file and returns early.
    """
    # confluent_kafka and fastavro are listed as required dependencies below.
    # The import is inside the function so that DAG parsing succeeds even if
    # the packages are not yet installed.
    try:
        from confluent_kafka import Consumer, KafkaException
        from confluent_kafka.schema_registry import SchemaRegistryClient
        from confluent_kafka.schema_registry.avro import AvroDeserializer
        from confluent_kafka.serialization import SerializationContext, MessageField
    except ImportError as exc:
        raise ImportError(
            "confluent-kafka is not installed. Add it to the Airflow Containerfile. "
            f"Original error: {exc}"
        )

    # Build Schema Registry client
    sr_client = SchemaRegistryClient({"url": SCHEMA_REGISTRY_URL})
    value_deserializer = AvroDeserializer(sr_client)

    consumer_conf = {
        "bootstrap.servers": KAFKA_BROKER,
        "group.id": KAFKA_GROUP_ID,
        # Start from the earliest unread offset for this group.
        # On first run this means reading from the beginning of the topic.
        "auto.offset.reset": "earliest",
        # We commit offsets manually after writing the batch file so that
        # a crash before the file is written does not lose events.
        "enable.auto.commit": False,
    }

    consumer = Consumer(consumer_conf)
    consumer.subscribe([KAFKA_TOPIC])

    events = []
    try:
        # Poll in a loop until we hit the record limit or time out
        poll_deadline = (
            datetime.now(tz=timezone.utc).timestamp() + POLL_TIMEOUT_SECONDS
        )
        while len(events) < MAX_POLL_RECORDS:
            remaining = poll_deadline - datetime.now(tz=timezone.utc).timestamp()
            if remaining <= 0:
                log.info("Poll timeout reached after %d events", len(events))
                break

            msg = consumer.poll(timeout=min(1.0, remaining))
            if msg is None:
                continue
            if msg.error():
                raise KafkaException(msg.error())

            # Deserialise the Avro value
            ctx = SerializationContext(KAFKA_TOPIC, MessageField.VALUE)
            value = value_deserializer(msg.value(), ctx)

            if value is None:
                log.warning("Received null value for offset %d — skipping", msg.offset())
                continue

            events.append(
                {
                    "offset": msg.offset(),
                    "partition": msg.partition(),
                    "timestamp_ms": msg.timestamp()[1],
                    "value": value,
                }
            )

        if events:
            # Commit only after collecting all events
            consumer.commit(asynchronous=False)
            log.info("Committed offsets after consuming %d events", len(events))

    finally:
        consumer.close()

    # Write the batch to a temp file; path is returned for the next task
    batch_path = f"/tmp/cdc_batch_{run_id}.json"
    with open(batch_path, "w") as fh:
        json.dump(events, fh)

    log.info("Wrote %d CDC events to %s", len(events), batch_path)
    return batch_path  # XCom value


# ---------------------------------------------------------------------------
# Task 2: Load the batch into DuckDB and persist to MinIO
# ---------------------------------------------------------------------------
def _load_batch_to_duckdb(*, ti, **context) -> None:
    """
    Pull the batch file path from XCom, upsert events into DuckDB, and
    upload the updated DuckDB file to MinIO.

    DATA: Debezium encodes DATE columns as an integer representing the number
    of days since 1970-01-01. We convert this back to a Python date using
    datetime.fromtimestamp(days * 86400, tz=timezone.utc).date().
    """
    try:
        import duckdb
    except ImportError as exc:
        raise ImportError(
            f"duckdb is not installed in Airflow. Original error: {exc}"
        )

    batch_path: str = ti.xcom_pull(task_ids="consume_cdc_events")
    if not batch_path or not os.path.exists(batch_path):
        log.info("No batch file found — nothing to load")
        return

    with open(batch_path) as fh:
        events = json.load(fh)

    if not events:
        log.info("Batch file is empty — nothing to load")
        return

    log.info("Loading %d CDC events into DuckDB", len(events))

    # Download existing DuckDB file from MinIO (or start fresh)
    minio_client = get_client()
    ensure_bucket(minio_client, DUCKDB_BUCKET)

    if object_exists(minio_client, DUCKDB_BUCKET, DUCKDB_OBJECT):
        log.info("Downloading existing DuckDB file from MinIO")
        minio_client.fget_object(DUCKDB_BUCKET, DUCKDB_OBJECT, DUCKDB_LOCAL_PATH)
    else:
        log.info("No existing DuckDB file found — will create a new one")

    con = duckdb.connect(DUCKDB_LOCAL_PATH)
    try:
        # Ensure schema exists
        con.execute(_DDL_WEATHER_FORECASTS_CDC)
        con.execute(_DDL_WEATHER_OBSERVATIONS_RAW)
        con.execute(_DDL_DAILY_SUMMARY)

        loaded_at = datetime.now(tz=timezone.utc)
        upserted = 0
        deleted = 0

        for event in events:
            value = event["value"]
            op = value.get("op")  # c=create, u=update, d=delete, r=read/snapshot
            ts_ms = event.get("timestamp_ms", 0)
            event_ts = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)

            if op == "d":
                # Delete operation: remove from the table
                before = value.get("before") or {}
                row_id = before.get("Id")
                if row_id is not None:
                    con.execute(
                        "DELETE FROM weather_forecasts_cdc WHERE id = ?",
                        [row_id],
                    )
                    deleted += 1
            elif op in ("c", "u", "r"):
                # Create, update, or snapshot: upsert using INSERT OR REPLACE
                after = value.get("after") or {}
                row_id = after.get("Id")
                date_int = after.get("Date")  # days since epoch
                temp_c = after.get("TemperatureC")
                summary = after.get("Summary")

                if row_id is None:
                    log.warning("Skipping event with null Id: %s", after)
                    continue

                # Convert Debezium date integer to a date string
                if date_int is not None:
                    date_str = datetime.fromtimestamp(
                        date_int * 86400, tz=timezone.utc
                    ).strftime("%Y-%m-%d")
                else:
                    date_str = None

                con.execute(
                    """
                    INSERT OR REPLACE INTO weather_forecasts_cdc
                        (id, date, temperature_c, summary, op, event_ts, loaded_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    [row_id, date_str, temp_c, summary, op, event_ts, loaded_at],
                )
                upserted += 1
            else:
                log.warning("Unknown CDC op=%r — skipping", op)

        con.close()
        log.info("DuckDB upserted=%d deleted=%d", upserted, deleted)

    except Exception:
        con.close()
        raise

    # Upload the updated DuckDB file back to MinIO
    minio_client.fput_object(
        DUCKDB_BUCKET,
        DUCKDB_OBJECT,
        DUCKDB_LOCAL_PATH,
        content_type="application/octet-stream",
    )
    log.info("Uploaded updated DuckDB to MinIO: %s/%s", DUCKDB_BUCKET, DUCKDB_OBJECT)


# ---------------------------------------------------------------------------
# Task 3: Remove temp files
# ---------------------------------------------------------------------------
def _cleanup_temp_files(*, ti, **context) -> None:
    """Remove local temp files created during this DAG run."""
    batch_path: str = ti.xcom_pull(task_ids="consume_cdc_events")
    for path in [batch_path, DUCKDB_LOCAL_PATH]:
        if path and os.path.exists(path):
            os.remove(path)
            log.info("Removed temp file: %s", path)


# ---------------------------------------------------------------------------
# DAG definition
# ---------------------------------------------------------------------------
with DAG(
    dag_id="kafka_cdc_to_duckdb",
    description=(
        "Consume Debezium CDC events from Kafka topic "
        "weather.public.WeatherForecasts and sync them into a DuckDB "
        "database file stored in MinIO."
    ),
    default_args=_DEFAULT_ARGS,
    schedule_interval="*/5 * * * *",  # every 5 minutes
    start_date=datetime(2024, 1, 1),
    catchup=False,
    tags=["kafka", "cdc", "duckdb", "minio"],
    doc_md=__doc__,
    # Prevent overlapping runs — if the previous run is still loading into
    # DuckDB, do not start a new run
    max_active_runs=1,
) as dag:

    consume = PythonOperator(
        task_id="consume_cdc_events",
        python_callable=_consume_cdc_events,
        doc_md=(
            "Poll Kafka topic for up to MAX_POLL_RECORDS CDC events. "
            "Writes a JSON batch file and returns its path via XCom."
        ),
    )

    load = PythonOperator(
        task_id="load_batch_to_duckdb",
        python_callable=_load_batch_to_duckdb,
        doc_md=(
            "Download DuckDB from MinIO, upsert the CDC batch, "
            "and re-upload the updated DuckDB file."
        ),
    )

    cleanup = PythonOperator(
        task_id="cleanup_temp_files",
        python_callable=_cleanup_temp_files,
        # Run cleanup even if load fails, to avoid /tmp accumulation
        trigger_rule="all_done",
        doc_md="Remove local temp files (batch JSON, DuckDB file).",
    )

    consume >> load >> cleanup

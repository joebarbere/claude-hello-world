# Vulnerability Report: apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py

## MEDIUM: Unvalidated JSON Deserialization of Kafka-Sourced Batch via XCom Path

**CWE:** CWE-502, CWE-610

**Description:**
XCom passes a file path from `consume_cdc_events` to `load_batch_to_duckdb`. The batch file is loaded via `json.load()` without path validation or schema verification. If XCom is tampered (possible by Airflow Admins), arbitrary file reads are possible.

**Impact:** Arbitrary file read within Airflow container. Malicious CDC events can corrupt DuckDB analytics.

**Remediation:** Validate batch_path matches expected pattern. Validate event structure against explicit schema.

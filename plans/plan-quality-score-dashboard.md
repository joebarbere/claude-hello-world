# Plan: Quality Score Trend Dashboard in Grafana

## Goal

Create a provisioned Grafana dashboard that plots the daily quality score (0-100) from `dag_quality_report.py` over time, making the impact of data science improvements immediately visible without manual MinIO inspection.

## Current State

- `apps/datascience/airflow/dags/dag_quality_report.py` produces a daily JSON report with a `quality_score` (0-100), `anomaly_rate`, `violation_rate`, and `avg_z_score`. Reports are saved to MinIO at `weather-analytics/reports/quality_YYYY-MM-DD.json`.
- The score is only accessible by manually downloading the JSON from MinIO. No time-series storage or visualization exists.
- Grafana is provisioned via `apps/observability/grafana/provisioning/dashboards/dashboards.yml`, which auto-loads all JSON files from `/etc/grafana/provisioning/dashboards`. Three dashboards already exist: `weather-api.json`, `kafka-cdc.json`, `system-health.json`.
- Prometheus is the default Grafana datasource (uid: `prometheus`), configured in `apps/observability/grafana/provisioning/datasources/prometheus.yml`. No Pushgateway is currently deployed.
- The Prometheus scrape config in `apps/observability/prometheus/prometheus.yml` already scrapes multiple targets including the weather API, Kafka, MinIO, and others.
- Airflow runs in the `datascience` pod (`k8s/datascience-pod.yaml`) with `MINIO_ENDPOINT=localhost:9000` and can reach the host network via `host.containers.internal`.

## Implementation Steps

### Option Analysis

Three paths exist for getting the quality score into Grafana. **Option A (Prometheus Pushgateway)** is recommended for its simplicity and alignment with the existing Prometheus-centric observability stack.

| Option | Pros | Cons |
|--------|------|------|
| A. Pushgateway | No new datasource; native PromQL; 1 new container | Score only retained while Pushgateway is up |
| B. Postgres table | Durable history; SQL queries in Grafana | Requires Postgres datasource in Grafana; DAG needs psycopg2 |
| C. JSON API sidecar | Reads directly from MinIO | New service to maintain; needs Infinity plugin |

### Step 1: Deploy Prometheus Pushgateway

1. Add a `pushgateway` container to `k8s/observability-pod.yaml`:
   ```yaml
   - name: pushgateway
     image: docker.io/prom/pushgateway:v1.9.0
     ports:
       - containerPort: 9091
         hostPort: 9091
   ```
2. Add a scrape target in `apps/observability/prometheus/prometheus.yml`:
   ```yaml
   - job_name: 'pushgateway'
     honor_labels: true
     static_configs:
       - targets: ['localhost:9091']
   ```

### Step 2: Add a Push-Metrics Task to the Quality Report DAG

Add a new task `push_metrics` after `save_report` in `apps/datascience/airflow/dags/dag_quality_report.py`:

```python
def _push_metrics(*, ti, **context) -> None:
    """Push quality score and sub-metrics to Prometheus Pushgateway."""
    import urllib.request
    import urllib.parse

    report_json = ti.xcom_pull(task_ids="generate_quality_report")
    if not report_json:
        log.warning("No report to push metrics for")
        return

    report = json.loads(report_json)
    score = report.get("quality_score")
    if score is None:
        return

    anomaly_rate = report.get("temperature_analysis", {}).get("anomaly_rate", 0)
    violation_rate = report.get("label_consistency", {}).get("violation_rate", 0)
    avg_z = report.get("temperature_analysis", {}).get("avg_z_score", 0) or 0
    forecast_count = report.get("forecast_count", 0)

    # Prometheus exposition format
    metrics = (
        "# HELP weather_quality_score Daily quality score 0-100\n"
        "# TYPE weather_quality_score gauge\n"
        f"weather_quality_score {score}\n"
        "# HELP weather_quality_anomaly_rate Fraction of forecasts with z>3\n"
        "# TYPE weather_quality_anomaly_rate gauge\n"
        f"weather_quality_anomaly_rate {anomaly_rate}\n"
        "# HELP weather_quality_violation_rate Fraction of label violations\n"
        "# TYPE weather_quality_violation_rate gauge\n"
        f"weather_quality_violation_rate {violation_rate}\n"
        "# HELP weather_quality_avg_z_score Average temperature z-score\n"
        "# TYPE weather_quality_avg_z_score gauge\n"
        f"weather_quality_avg_z_score {avg_z}\n"
        "# HELP weather_quality_forecast_count Forecasts evaluated\n"
        "# TYPE weather_quality_forecast_count gauge\n"
        f"weather_quality_forecast_count {forecast_count}\n"
    )

    pushgw_url = os.environ.get(
        "PUSHGATEWAY_URL", "http://host.containers.internal:9091"
    )
    url = f"{pushgw_url}/metrics/job/weather_quality_report"
    req = urllib.request.Request(url, data=metrics.encode("utf-8"), method="POST")
    req.add_header("Content-Type", "text/plain")
    urllib.request.urlopen(req, timeout=10)
    log.info("Pushed quality metrics to Pushgateway at %s", pushgw_url)
```

Update the task graph:
```python
[load_profile, load_forecasts] >> generate_report >> save_report >> push_metrics
```

Add `PUSHGATEWAY_URL` env var to the Airflow container in `k8s/datascience-pod.yaml`:
```yaml
- name: PUSHGATEWAY_URL
  value: "http://host.containers.internal:9091"
```

### Step 3: Create the Grafana Dashboard JSON

Create `apps/observability/grafana/provisioning/dashboards/quality-score.json` with these panels:

1. **Quality Score (stat panel, large)** -- `weather_quality_score` gauge, thresholds: green >80, amber 50-80, red <50.
2. **Quality Score Trend (timeseries)** -- `weather_quality_score` over the last 30 days.
3. **Anomaly Rate (timeseries)** -- `weather_quality_anomaly_rate` with a threshold line at 0.10.
4. **Label Violation Rate (timeseries)** -- `weather_quality_violation_rate` with a threshold line at 0.50.
5. **Average Z-Score (timeseries)** -- `weather_quality_avg_z_score` with horizontal lines at z=2 and z=3.
6. **Forecasts Evaluated (stat panel)** -- `weather_quality_forecast_count`.

Layout: row 1 = stat panels (score + forecast count), row 2 = score trend, row 3 = anomaly rate + violation rate side by side, row 4 = z-score trend.

The dashboard JSON should follow the same schema version (38) and datasource reference pattern (`{"type": "prometheus", "uid": "prometheus"}`) used by the existing `weather-api.json`.

### Step 4: Set Retention on Pushgateway Metrics

The Pushgateway retains metrics until they are explicitly deleted or the container restarts. Since the DAG runs daily, stale metrics are not a concern as long as the score is always overwritten. The `job` label `weather_quality_report` groups all metrics under one push, so each DAG run replaces the previous values.

For long-term history, Prometheus retention (default 15 days) defines how far back the trend panel can look. Increase `--storage.tsdb.retention.time=90d` in the Prometheus container args if a longer window is desired.

## Files to Create/Modify

- **Create** `apps/observability/grafana/provisioning/dashboards/quality-score.json` -- dashboard definition
- **Modify** `apps/datascience/airflow/dags/dag_quality_report.py` -- add `push_metrics` task
- **Modify** `apps/observability/prometheus/prometheus.yml` -- add pushgateway scrape target
- **Modify** `k8s/observability-pod.yaml` -- add pushgateway container
- **Modify** `k8s/datascience-pod.yaml` -- add `PUSHGATEWAY_URL` env var

## Testing

1. **Unit test the push function**: Mock `urllib.request.urlopen` and verify the exposition format string contains all five metrics with correct names and numeric values.
2. **Integration test**: After deploying, trigger the `weather_quality_report` DAG manually in Airflow. Then:
   - Verify metrics appear at `http://localhost:9091/metrics` (Pushgateway web UI).
   - Verify Prometheus can query `weather_quality_score` at `http://localhost:9090/graph`.
   - Open the Grafana dashboard at `https://localhost:8443/grafana` and confirm all six panels render.
3. **Edge case**: Run the DAG when no forecasts exist (empty DuckDB). The push task should log a warning and skip without error. The stat panel should show "N/A" or "No data".

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Pushgateway container crashes and loses metrics | Prometheus has already scraped and stored the values. Only the "current" stat panel would be blank until the next DAG run. |
| DAG fails before the push task runs | `save_report` already saves to MinIO, so no data is lost. The push task is additive. |
| Pushgateway port 9091 conflicts with another service | Check existing port allocations in all pod YAMLs before deploying. |
| `urllib.request` blocked by network policy | The datascience pod already reaches `host.containers.internal` for Kafka and MinIO; the same path works for the pushgateway. |

## Dependencies

- None strictly required. The quality report DAG already works independently.
- **Benefits from**: "Airflow health metrics in Prometheus" (IDEAS.md) -- if implemented, Airflow DAG success/failure could be correlated on the same dashboard.
- **Enables**: "Admin-app: quality score panel" (IDEAS.md) -- the admin app could read from Prometheus instead of MinIO.

## Estimated Complexity

**Medium** -- The DAG change is small (one new task with no new pip dependencies), but the Grafana JSON requires careful panel layout and the Pushgateway adds a new container to the observability pod.

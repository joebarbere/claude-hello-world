# Plan: Expose Airflow Health Metrics in Prometheus

## Goal

Replace the current blackbox HTTP probe for Airflow with native Airflow StatsD metrics exported to Prometheus, enabling detailed DAG run, scheduler, and task-level monitoring with Grafana dashboards and alerting rules.

## Current State

- **Airflow container** runs in the `datascience` pod (`k8s/datascience-pod.yaml`, lines 9-48) using `apache/airflow:slim-2.10.4-python3.11` with SequentialExecutor and SQLite.
- **Prometheus** already scrapes Airflow indirectly via a blackbox exporter HTTP probe (`apps/observability/prometheus/prometheus.yml`, lines 57-70, job `blackbox-airflow`) that hits `http://host.containers.internal:8280/airflow/health`. This only yields `probe_success{job="blackbox-airflow"}` (up/down) -- no DAG, task, or scheduler metrics.
- **Grafana system-health dashboard** (`apps/observability/grafana/provisioning/dashboards/system-health.json`, panels 14-15) shows Airflow and Jupyter as simple UP/DOWN stat panels based on blackbox probes.
- **Airflow entrypoint** (`apps/datascience/airflow/entrypoint.sh`) runs `airflow db migrate`, creates a user, then starts scheduler (background) and webserver (foreground). No StatsD or metrics exporter is configured.
- **No Airflow pip packages** for `statsd` or `prometheus` exporter exist in the Containerfile (`apps/datascience/airflow/Containerfile`).

## Implementation Steps

### 1. Install statsd-exporter sidecar or use Airflow's built-in Prometheus metrics

**Option A (Recommended): StatsD Exporter sidecar**

Airflow natively emits StatsD metrics. Add a `statsd-exporter` container to the `datascience` pod that receives StatsD UDP from Airflow and exposes a `/metrics` HTTP endpoint for Prometheus.

**Option B: airflow-exporter Python package**

Less mature; Option A is the standard approach.

### 2. Configure Airflow to emit StatsD metrics

Add the following environment variables to the `airflow` container in `k8s/datascience-pod.yaml`:

```yaml
- name: AIRFLOW__METRICS__STATSD_ON
  value: "true"
- name: AIRFLOW__METRICS__STATSD_HOST
  value: "localhost"
- name: AIRFLOW__METRICS__STATSD_PORT
  value: "9125"
- name: AIRFLOW__METRICS__STATSD_PREFIX
  value: "airflow"
```

### 3. Add statsd-exporter container to datascience pod

Add a new container to `k8s/datascience-pod.yaml`:

```yaml
- name: statsd-exporter
  image: docker.io/prom/statsd-exporter:latest
  args:
    - "--statsd.listen-udp=:9125"
    - "--web.listen-address=:9102"
  ports:
    - containerPort: 9125
      protocol: UDP
    - containerPort: 9102
      hostPort: 9102
```

### 4. Create a StatsD mapping file (optional but recommended)

Create `apps/datascience/statsd-exporter/statsd-mapping.yml` to map Airflow's StatsD metric names to cleaner Prometheus metric names:

```yaml
mappings:
  - match: "airflow.dagrun.duration.*.*"
    name: "airflow_dagrun_duration"
    labels:
      dag_id: "$1"
      status: "$2"
  - match: "airflow.dag_processing.total_parse_time"
    name: "airflow_dag_processing_total_parse_time"
  - match: "airflow.scheduler.tasks.running"
    name: "airflow_scheduler_tasks_running"
  - match: "airflow.scheduler.tasks.starving"
    name: "airflow_scheduler_tasks_starving"
  - match: "airflow.ti.start.*.*"
    name: "airflow_ti_start"
    labels:
      dag_id: "$1"
      task_id: "$2"
  - match: "airflow.ti.finish.*.*.*"
    name: "airflow_ti_finish"
    labels:
      dag_id: "$1"
      task_id: "$2"
      state: "$3"
  - match: "airflow.pool.open_slots.*"
    name: "airflow_pool_open_slots"
    labels:
      pool: "$1"
  - match: "airflow.pool.used_slots.*"
    name: "airflow_pool_used_slots"
    labels:
      pool: "$1"
  - match: "."
    match_type: "regex"
    action: "drop"
    name: "dropped"
```

If using the mapping file, build a custom statsd-exporter image or mount it as a volume. The simpler approach for dev: mount from host.

### 5. Add Prometheus scrape target

Add to `apps/observability/prometheus/prometheus.yml`:

```yaml
- job_name: 'airflow'
  static_configs:
    - targets: ['host.containers.internal:9102']
  metrics_path: /metrics
```

Keep the existing `blackbox-airflow` job as a supplementary HTTP health check.

### 6. Rebuild the Prometheus image

The Prometheus Containerfile (`apps/observability/prometheus/Containerfile`) copies `prometheus.yml` at build time, so the image must be rebuilt after modifying the scrape config.

### 7. Create Grafana dashboard

Create `apps/observability/grafana/provisioning/dashboards/airflow.json` with panels:

| Panel | PromQL | Type |
|-------|--------|------|
| DAG Run Success Rate | `sum(rate(airflow_ti_finish{state="success"}[5m])) / sum(rate(airflow_ti_finish[5m])) * 100` | Stat (percent) |
| DAG Run Duration | `airflow_dagrun_duration` | Time series |
| Scheduler Tasks Running | `airflow_scheduler_tasks_running` | Gauge |
| Scheduler Tasks Starving | `airflow_scheduler_tasks_starving` | Gauge |
| Task Instances by State | `sum by (state) (airflow_ti_finish)` | Bar gauge |
| Pool Utilization | `airflow_pool_used_slots / (airflow_pool_used_slots + airflow_pool_open_slots) * 100` | Gauge |
| DAG Parse Time | `airflow_dag_processing_total_parse_time` | Time series |

### 8. Add alerting rules (optional, for future Alertmanager integration)

Create `apps/observability/prometheus/alert-rules.yml`:

```yaml
groups:
  - name: airflow
    rules:
      - alert: AirflowSchedulerDown
        expr: up{job="airflow"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Airflow StatsD exporter is down"
      - alert: AirflowDAGFailureRate
        expr: sum(rate(airflow_ti_finish{state="failed"}[15m])) > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Airflow tasks are failing"
```

Update `prometheus.yml` to reference the rules file:

```yaml
rule_files:
  - /etc/prometheus/alert-rules.yml
```

Update the Prometheus Containerfile to copy the rules file.

## Files to Create/Modify

- **Modify**: `k8s/datascience-pod.yaml` -- add StatsD env vars to airflow container, add statsd-exporter container
- **Modify**: `apps/observability/prometheus/prometheus.yml` -- add `airflow` scrape job, add `rule_files` section
- **Modify**: `apps/observability/prometheus/Containerfile` -- copy alert rules file
- **Create**: `apps/datascience/statsd-exporter/statsd-mapping.yml` -- metric name mappings
- **Create**: `apps/observability/grafana/provisioning/dashboards/airflow.json` -- Grafana dashboard
- **Create**: `apps/observability/prometheus/alert-rules.yml` -- alerting rules

## Testing

1. Rebuild images: `podman build -t localhost/prometheus:latest apps/observability/prometheus/` and rebuild datascience pod
2. Restart datascience and observability pods
3. Verify statsd-exporter is receiving metrics: `curl http://localhost:9102/metrics | grep airflow`
4. Verify Prometheus is scraping: open Prometheus UI at `http://localhost:9090/targets` and confirm `airflow` job is UP
5. Trigger a DAG run manually in Airflow UI and verify `airflow_ti_finish` metrics appear
6. Open Grafana and verify the Airflow dashboard panels populate with data

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| StatsD UDP packet loss in busy workloads | Acceptable for dev; StatsD exporter buffers incoming metrics |
| statsd-exporter adds memory overhead to datascience pod | The exporter is lightweight (~20MB RSS); monitor via podman-exporter |
| Metric cardinality explosion if many DAGs are added | Use the mapping file to drop unmapped metrics (the catch-all `drop` rule) |
| Port 9102 conflict | Verify no other container uses this hostPort |

## Dependencies

- None strictly required. The existing blackbox probe continues to work independently.
- **Benefits from**: `plan-liveness-readiness-probes.md` (if statsd-exporter has a readiness probe, Prometheus won't scrape a not-yet-ready target)

## Estimated Complexity

**Medium** -- requires a new sidecar container, Airflow config changes, Prometheus config update, and a new Grafana dashboard. No code changes, purely configuration.

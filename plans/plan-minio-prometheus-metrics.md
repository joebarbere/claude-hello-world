# Plan: Expose MinIO Metrics in Prometheus

## Goal

Ensure the existing MinIO Prometheus scrape target is working correctly and expand it with a dedicated Grafana dashboard for storage monitoring (bucket sizes, request rates, disk usage, API latencies).

## Current State

- **MinIO container** runs in the `datascience` pod (`k8s/datascience-pod.yaml`, lines 73-91) with `MINIO_PROMETHEUS_AUTH_TYPE=public`, which means the metrics endpoint at `/minio/v2/metrics/cluster` does not require a bearer token.
- **Prometheus already has a MinIO scrape job** (`apps/observability/prometheus/prometheus.yml`, lines 48-51):
  ```yaml
  - job_name: 'minio'
    static_configs:
      - targets: ['host.containers.internal:9000']
    metrics_path: /minio/v2/metrics/cluster
  ```
- **No dedicated MinIO Grafana dashboard** exists. The only MinIO visibility is the generic `up{job="minio"}` metric shown in the system-health dashboard target table (`apps/observability/grafana/provisioning/dashboards/system-health.json`).
- **MinIO credentials**: `minioadmin`/`minioadmin` (set in `k8s/datascience-pod.yaml`, lines 83-85).
- **No bearer token is needed** because `MINIO_PROMETHEUS_AUTH_TYPE` is set to `public`. If this were changed to `jwt` in the future, a token would need to be generated with `mc admin prometheus generate`.

## Implementation Steps

### 1. Verify the existing scrape is working

Before making changes, confirm the current setup works:
```bash
curl http://localhost:9000/minio/v2/metrics/cluster
```

If this returns metrics, the scrape config is already functional. If MinIO is not yet running or returns 403, ensure `MINIO_PROMETHEUS_AUTH_TYPE=public` is set.

### 2. Add the node-level metrics endpoint (optional but recommended)

MinIO exposes two metrics endpoints:
- `/minio/v2/metrics/cluster` -- cluster-wide metrics (already configured)
- `/minio/v2/metrics/node` -- per-node metrics (disk I/O, memory, CPU)

Add a second scrape job to `apps/observability/prometheus/prometheus.yml`:

```yaml
- job_name: 'minio-node'
  static_configs:
    - targets: ['host.containers.internal:9000']
  metrics_path: /minio/v2/metrics/node
```

### 3. Create a Grafana dashboard for MinIO

Create `apps/observability/grafana/provisioning/dashboards/minio.json` with these panels:

| Panel | PromQL | Type |
|-------|--------|------|
| MinIO Status | `up{job="minio"}` | Stat (UP/DOWN) |
| Total Storage Used | `minio_bucket_usage_total_bytes` | Stat (bytes) |
| Storage per Bucket | `minio_bucket_usage_total_bytes` by bucket | Bar gauge |
| Objects per Bucket | `minio_bucket_usage_object_total` by bucket | Bar gauge |
| S3 Request Rate | `rate(minio_s3_requests_total[5m])` | Time series |
| S3 Errors | `rate(minio_s3_requests_errors_total[5m])` | Time series |
| S3 Request Latency (p99) | `histogram_quantile(0.99, rate(minio_s3_requests_waiting_total[5m]))` | Time series |
| Network TX/RX | `rate(minio_s3_traffic_sent_bytes[5m])`, `rate(minio_s3_traffic_received_bytes[5m])` | Time series |
| Disk Used vs Free | `minio_node_disk_used_bytes`, `minio_node_disk_free_bytes` (requires node metrics) | Gauge |

### 4. Add a MinIO stat panel to the system-health dashboard

Add a MinIO probe panel in `apps/observability/grafana/provisioning/dashboards/system-health.json` in the "Service Probes" row, similar to the existing Airflow/Jupyter panels:

```json
{
  "id": 19,
  "type": "stat",
  "title": "MinIO",
  "description": "MinIO object storage health",
  "gridPos": { "x": 0, "y": 28, "w": 8, "h": 4 },
  "datasource": { "type": "prometheus", "uid": "prometheus" },
  "targets": [
    {
      "expr": "up{job=\"minio\"}",
      "legendFormat": "MinIO"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "mappings": [
        { "type": "value", "options": { "1": { "text": "UP", "color": "green" }, "0": { "text": "DOWN", "color": "red" } } }
      ],
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "red", "value": null },
          { "color": "green", "value": 1 }
        ]
      }
    }
  },
  "options": {
    "colorMode": "background",
    "reduceOptions": { "calcs": ["lastNotNull"] }
  }
}
```

### 5. (Future) Bearer token configuration

If `MINIO_PROMETHEUS_AUTH_TYPE` is changed from `public` to `jwt`, generate a token:

```bash
mc alias set local http://localhost:9000 minioadmin minioadmin
mc admin prometheus generate local
```

Then add `bearer_token` to the Prometheus scrape config:

```yaml
- job_name: 'minio'
  bearer_token: '<generated-token>'
  static_configs:
    - targets: ['host.containers.internal:9000']
  metrics_path: /minio/v2/metrics/cluster
```

This is not needed now since auth type is `public`, but document it for production hardening.

## Files to Create/Modify

- **Modify**: `apps/observability/prometheus/prometheus.yml` -- add `minio-node` scrape job
- **Modify**: `apps/observability/grafana/provisioning/dashboards/system-health.json` -- add MinIO stat panel to Service Probes row
- **Create**: `apps/observability/grafana/provisioning/dashboards/minio.json` -- dedicated MinIO dashboard
- **Modify** (rebuild): `apps/observability/prometheus/Containerfile` -- no code change, just rebuild after prometheus.yml change

## Testing

1. Verify cluster metrics endpoint: `curl -s http://localhost:9000/minio/v2/metrics/cluster | head -20`
2. Verify node metrics endpoint: `curl -s http://localhost:9000/minio/v2/metrics/node | head -20`
3. Rebuild and restart the observability pod
4. Check Prometheus targets page (`http://localhost:9090/targets`) -- both `minio` and `minio-node` jobs should be UP
5. Upload a file to MinIO via the console or `mc` CLI, then verify `minio_bucket_usage_total_bytes` increases in Prometheus
6. Open the Grafana MinIO dashboard and confirm all panels render data

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| MinIO metrics endpoint returns 403 | Confirm `MINIO_PROMETHEUS_AUTH_TYPE=public` is set in pod YAML; this is already the case |
| Metric names change across MinIO versions | Pin the MinIO image version instead of using `latest`; update dashboard queries if metrics change |
| Low cardinality if only one bucket exists | Expected for dev -- panels will populate as buckets are created |

## Dependencies

- None. The MinIO scrape job already exists in Prometheus; this plan primarily adds a dashboard and the node metrics endpoint.
- **Benefits from**: `plan-liveness-readiness-probes.md` (adding a readiness probe to MinIO ensures Prometheus only scrapes when MinIO is ready)

## Estimated Complexity

**Small** -- The scrape config already exists. Main work is creating the Grafana dashboard JSON and optionally adding the node metrics endpoint. No container image changes needed (except Prometheus rebuild for the node scrape job).

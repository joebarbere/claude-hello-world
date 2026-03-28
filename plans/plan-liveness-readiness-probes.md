# Plan: Add Liveness/Readiness Probes to All Containers

## Goal

Add Kubernetes-style liveness and readiness probes to every container across all six pods, enabling Podman to automatically detect and restart unhealthy containers and providing accurate health status for monitoring.

## Current State

- **No probes are defined** on any container in any pod manifest. All six pod YAMLs lack `livenessProbe`, `readinessProbe`, and `startupProbe` fields entirely:
  - `k8s/postgres-pod.yaml` -- 1 container (postgres)
  - `k8s/apps-pod.yaml` -- 5 containers (weather-api, traefik, nginx, nginx-exporter, + separate pod: claude-hello-world)
  - `k8s/kafka-pod.yaml` -- 6 containers (kafka, schema-registry, debezium-connect, debezium-init, kafka-ui, slot-guard)
  - `k8s/datascience-pod.yaml` -- 3 containers (airflow, jupyter, minio)
  - `k8s/observability-pod.yaml` -- 8 containers (prometheus, loki, grafana, blackbox-exporter, podman-exporter, auth-proxy, postgres-exporter, promtail)
  - `k8s/ory-kratos-pod.yaml` -- 2 containers + 1 initContainer (ory-kratos, ory-kratos-init, kratos-migrate)
- **Podman kube play** supports the same probe syntax as Kubernetes (httpGet, tcpSocket, exec).
- **Health endpoints known to exist**:
  - Airflow: `http://localhost:8080/airflow/health` (used by blackbox exporter)
  - Jupyter: `http://localhost:8888/jupyter/api/status` (used by blackbox exporter)
  - Weather API: `http://localhost:8080/metrics` (Prometheus endpoint implies HTTP is working)
  - Traefik: `http://localhost:8081/metrics`
  - MinIO: `http://localhost:9000/minio/health/live` and `/minio/health/ready`
  - Kratos: `http://localhost:4434/admin/health/alive` and `/admin/health/ready`
  - Grafana: `http://localhost:3000/grafana/api/health`
  - Prometheus: `http://localhost:9090/-/healthy`
  - Loki: `http://localhost:3100/ready`
  - Kafka: TCP on port 9092

## Implementation Steps

### 1. PostgreSQL pod (`k8s/postgres-pod.yaml`)

```yaml
- name: postgres
  image: localhost/postgres:latest
  # ... existing config ...
  livenessProbe:
    exec:
      command: ["pg_isready", "-U", "appuser", "-d", "appdb"]
    initialDelaySeconds: 30
    periodSeconds: 10
    failureThreshold: 3
  readinessProbe:
    exec:
      command: ["pg_isready", "-U", "appuser", "-d", "appdb"]
    initialDelaySeconds: 5
    periodSeconds: 5
    failureThreshold: 3
```

### 2. Apps pod (`k8s/apps-pod.yaml`)

**weather-api:**
```yaml
livenessProbe:
  httpGet:
    path: /metrics
    port: 8080
  initialDelaySeconds: 15
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /metrics
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
```

**traefik:**
```yaml
livenessProbe:
  httpGet:
    path: /metrics
    port: 8081
  initialDelaySeconds: 10
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /metrics
    port: 8081
  initialDelaySeconds: 5
  periodSeconds: 5
```

**nginx:**
```yaml
livenessProbe:
  httpGet:
    path: /nginx_status
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /nginx_status
    port: 8080
  initialDelaySeconds: 3
  periodSeconds: 5
```

**nginx-exporter:**
```yaml
livenessProbe:
  httpGet:
    path: /metrics
    port: 9113
  initialDelaySeconds: 5
  periodSeconds: 10
```

### 3. Kafka pod (`k8s/kafka-pod.yaml`)

**kafka:**
```yaml
livenessProbe:
  tcpSocket:
    port: 9092
  initialDelaySeconds: 60
  periodSeconds: 15
  failureThreshold: 5
readinessProbe:
  tcpSocket:
    port: 9092
  initialDelaySeconds: 30
  periodSeconds: 10
```

**schema-registry:**
```yaml
livenessProbe:
  httpGet:
    path: /
    port: 8081
  initialDelaySeconds: 30
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /
    port: 8081
  initialDelaySeconds: 15
  periodSeconds: 5
```

**debezium-connect:**
```yaml
livenessProbe:
  httpGet:
    path: /
    port: 8083
  initialDelaySeconds: 60
  periodSeconds: 15
  failureThreshold: 5
readinessProbe:
  httpGet:
    path: /connectors
    port: 8083
  initialDelaySeconds: 30
  periodSeconds: 10
```

**kafka-ui:**
```yaml
livenessProbe:
  httpGet:
    path: /kafka-ui/api/clusters
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 15
readinessProbe:
  httpGet:
    path: /kafka-ui/api/clusters
    port: 8080
  initialDelaySeconds: 15
  periodSeconds: 10
```

**slot-guard** and **debezium-init**: These are utility/init-style containers. Skip probes -- they are expected to run periodically or exit after initialization.

### 4. Datascience pod (`k8s/datascience-pod.yaml`)

**airflow:**
```yaml
livenessProbe:
  httpGet:
    path: /airflow/health
    port: 8080
  initialDelaySeconds: 60
  periodSeconds: 15
  failureThreshold: 5
readinessProbe:
  httpGet:
    path: /airflow/health
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10
```

**jupyter:**
```yaml
livenessProbe:
  httpGet:
    path: /jupyter/api/status
    port: 8888
  initialDelaySeconds: 15
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /jupyter/api/status
    port: 8888
  initialDelaySeconds: 10
  periodSeconds: 5
```

**minio:**
```yaml
livenessProbe:
  httpGet:
    path: /minio/health/live
    port: 9000
  initialDelaySeconds: 10
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /minio/health/ready
    port: 9000
  initialDelaySeconds: 10
  periodSeconds: 5
```

### 5. Observability pod (`k8s/observability-pod.yaml`)

**prometheus:**
```yaml
livenessProbe:
  httpGet:
    path: /-/healthy
    port: 9090
  initialDelaySeconds: 10
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /-/ready
    port: 9090
  initialDelaySeconds: 5
  periodSeconds: 5
```

**loki:**
```yaml
livenessProbe:
  httpGet:
    path: /ready
    port: 3100
  initialDelaySeconds: 15
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /ready
    port: 3100
  initialDelaySeconds: 10
  periodSeconds: 5
```

**grafana:**
```yaml
livenessProbe:
  httpGet:
    path: /grafana/api/health
    port: 3000
  initialDelaySeconds: 15
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /grafana/api/health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 5
```

**blackbox-exporter:**
```yaml
livenessProbe:
  httpGet:
    path: /
    port: 9115
  initialDelaySeconds: 5
  periodSeconds: 10
```

**postgres-exporter:**
```yaml
livenessProbe:
  httpGet:
    path: /metrics
    port: 9187
  initialDelaySeconds: 10
  periodSeconds: 15
```

**podman-exporter, auth-proxy, promtail**: Use tcpSocket probes on their respective ports (9882, 4180, and a suitable port for promtail) since they may not expose HTTP health endpoints.

### 6. Ory Kratos pod (`k8s/ory-kratos-pod.yaml`)

**ory-kratos:**
```yaml
livenessProbe:
  httpGet:
    path: /admin/health/alive
    port: 4434
  initialDelaySeconds: 15
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /admin/health/ready
    port: 4434
  initialDelaySeconds: 10
  periodSeconds: 5
```

**ory-kratos-init**: Skip -- this is an init-style container that exits after completing its task.

### 7. Consider startup ordering implications

Within a Podman pod, all containers start simultaneously (no dependency ordering like Docker Compose `depends_on`). The `initialDelaySeconds` values are critical:

- **PostgreSQL** (30s liveness) should be generous since it's a dependency for Kratos and Weather API
- **Kafka** (60s liveness) needs the longest delay because it takes time to elect a controller and start listeners
- **Debezium** (60s liveness) depends on Kafka being ready (but runs in the same pod, so `localhost:9092` is available quickly)
- **Airflow** (60s liveness) needs time for `airflow db migrate` in the entrypoint

For cross-pod dependencies (e.g., Weather API depends on Postgres), the readiness probe will fail until the dependency is available, but the container will keep running. The `failureThreshold` prevents premature restarts.

## Files to Create/Modify

- **Modify**: `k8s/postgres-pod.yaml` -- add probes to postgres container
- **Modify**: `k8s/apps-pod.yaml` -- add probes to weather-api, traefik, nginx, nginx-exporter
- **Modify**: `k8s/kafka-pod.yaml` -- add probes to kafka, schema-registry, debezium-connect, kafka-ui
- **Modify**: `k8s/datascience-pod.yaml` -- add probes to airflow, jupyter, minio
- **Modify**: `k8s/observability-pod.yaml` -- add probes to prometheus, loki, grafana, blackbox-exporter, postgres-exporter
- **Modify**: `k8s/ory-kratos-pod.yaml` -- add probes to ory-kratos

## Testing

1. Apply each modified pod YAML one at a time with `podman kube play --replace`
2. Run `podman pod ps` and `podman ps --pod` to verify all containers reach "Running" state
3. Verify probes are registered: `podman inspect <container-name> | jq '.[0].Config.Healthcheck'` (note: Podman maps K8s probes to healthchecks)
4. Run `podman healthcheck run <container-name>` to manually trigger a health check
5. Simulate failure: `podman exec <container> kill -STOP 1` (pause the main process) and confirm the liveness probe eventually restarts the container
6. Check the Grafana system-health dashboard -- all targets should remain UP after pod restarts

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Probes restart containers during slow startup (especially Kafka, Airflow) | Use generous `initialDelaySeconds` (30-60s) and `failureThreshold` (3-5) to allow ample startup time |
| Podman kube play may not support all probe fields | Test with Podman 4.x+; `httpGet`, `tcpSocket`, and `exec` probes are supported since Podman 4.0 |
| Restart loops if a dependency is permanently down | `failureThreshold` with `periodSeconds` provides a multi-minute window; cross-pod dependencies should be addressed at the orchestration level |
| `debezium-init` and `slot-guard` may be long-running utilities, not init containers | Verify their lifecycle; if they exit normally, probes would incorrectly mark them as failed. Skip probes for these. |

## Dependencies

- None required first. Probes are additive and non-breaking.
- **Complements**: `plan-self-healing-script.md` -- probes provide container-level auto-restart, while the self-healing script provides pod-level restart for more severe failures.

## Estimated Complexity

**Medium** -- Touches all six pod manifests. Each probe is straightforward configuration, but testing across all containers requires careful validation. The main risk is getting `initialDelaySeconds` tuned correctly to avoid false-positive restarts.

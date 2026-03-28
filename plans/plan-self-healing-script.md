# Plan: Automated Pod Restart / Self-Healing Script

## Goal

Create a script that periodically checks the health of all pods and their containers, automatically restarts failed pods, and logs all actions -- providing pod-level self-healing beyond what container-level liveness probes offer.

## Current State

- **No self-healing or health-check scripts exist** in the repository. The `scripts/` directory contains only `take-screenshots.mjs` and `sync-datascience.sh`.
- **Six pods** are managed via `podman kube play`:
  - `postgres` (1 container)
  - `weather-api` + `claude-hello-world` (2 pods defined in `k8s/apps-pod.yaml`, separated by `---`)
  - `kafka` (6 containers)
  - `datascience` (3 containers)
  - `observability` (8 containers)
  - `ory-kratos` (2 containers + 1 init)
- **Podman is the runtime**, not Kubernetes -- there is no kubelet to handle pod-level restarts. `podman kube play` launches pods but does not monitor them afterward.
- **Prometheus + blackbox exporter** monitor Airflow and Jupyter HTTP endpoints, and `podman-exporter` exposes container state metrics, but neither triggers restarts.
- **Container health endpoints** are documented in the liveness/readiness probes plan. Key ones:
  - Postgres: `pg_isready`
  - Weather API: `http://localhost:5221/metrics`
  - Traefik: `http://localhost:8081/metrics`
  - Kafka: TCP port 9092
  - Airflow: `http://localhost:8280/airflow/health`
  - MinIO: `http://localhost:9000/minio/health/live`
  - Prometheus: `http://localhost:9090/-/healthy`
  - Grafana: `http://localhost:3000/grafana/api/health`
  - Loki: `http://localhost:3100/ready`
  - Kratos: `http://localhost:4434/admin/health/alive`
  - Jupyter: `http://localhost:8888/jupyter/api/status`

## Implementation Steps

### 1. Create the health check script

Create `scripts/pod-health-check.sh`:

```bash
#!/usr/bin/env bash
# pod-health-check.sh -- Check pod health and restart failed pods
# Usage: ./scripts/pod-health-check.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${LOG_FILE:-/var/log/pod-health-check.log}"
DRY_RUN="${1:-}"
RESTART_COOLDOWN=300  # seconds between restarts of the same pod

log() {
  local ts
  ts=$(date -Iseconds)
  echo "[$ts] $*" | tee -a "$LOG_FILE"
}

# Track last restart times to prevent restart loops
declare -A LAST_RESTART
RESTART_STATE_FILE="/tmp/pod-health-check-state"
if [[ -f "$RESTART_STATE_FILE" ]]; then
  source "$RESTART_STATE_FILE"
fi

can_restart() {
  local pod="$1"
  local now
  now=$(date +%s)
  local last="${LAST_RESTART[$pod]:-0}"
  (( now - last >= RESTART_COOLDOWN ))
}

record_restart() {
  local pod="$1"
  LAST_RESTART[$pod]=$(date +%s)
  declare -p LAST_RESTART > "$RESTART_STATE_FILE" 2>/dev/null || true
}

restart_pod() {
  local pod="$1"
  local yaml="$2"
  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    log "DRY-RUN: Would restart pod '$pod' using $yaml"
    return
  fi
  if ! can_restart "$pod"; then
    log "SKIP: Pod '$pod' was restarted recently (cooldown ${RESTART_COOLDOWN}s)"
    return
  fi
  log "RESTART: Restarting pod '$pod' via podman kube play --replace $yaml"
  podman kube play --replace "$yaml" 2>&1 | tee -a "$LOG_FILE"
  record_restart "$pod"
}

check_http() {
  local url="$1"
  local timeout="${2:-5}"
  curl -sf --max-time "$timeout" "$url" > /dev/null 2>&1
}

check_tcp() {
  local host="$1"
  local port="$2"
  local timeout="${3:-5}"
  timeout "$timeout" bash -c "echo > /dev/tcp/$host/$port" 2>/dev/null
}

check_pg() {
  pg_isready -h localhost -p 5432 -U appuser -d appdb -t 5 > /dev/null 2>&1
}

# --- Health checks per pod ---

FAILURES=0

# PostgreSQL
log "CHECK: postgres"
if ! check_pg; then
  log "FAIL: postgres is not ready"
  restart_pod "postgres" "$SCRIPT_DIR/k8s/postgres-pod.yaml"
  ((FAILURES++))
else
  log "OK: postgres"
fi

# Apps (weather-api + claude-hello-world)
log "CHECK: weather-api"
if ! check_http "http://localhost:5221/metrics"; then
  log "FAIL: weather-api /metrics is unreachable"
  restart_pod "weather-api" "$SCRIPT_DIR/k8s/apps-pod.yaml"
  ((FAILURES++))
else
  log "OK: weather-api"
fi

log "CHECK: traefik"
if ! check_http "http://localhost:8081/metrics"; then
  log "FAIL: traefik metrics endpoint unreachable"
  # Traefik is in claude-hello-world pod (same YAML as weather-api but separate pod)
  restart_pod "claude-hello-world" "$SCRIPT_DIR/k8s/apps-pod.yaml"
  ((FAILURES++))
else
  log "OK: traefik"
fi

# Kafka
log "CHECK: kafka"
if ! check_tcp localhost 9092; then
  log "FAIL: kafka TCP 9092 unreachable"
  restart_pod "kafka" "$SCRIPT_DIR/k8s/kafka-pod.yaml"
  ((FAILURES++))
else
  log "OK: kafka"
fi

# Datascience
log "CHECK: airflow"
if ! check_http "http://localhost:8280/airflow/health"; then
  log "FAIL: airflow health endpoint unreachable"
  restart_pod "datascience" "$SCRIPT_DIR/k8s/datascience-pod.yaml"
  ((FAILURES++))
else
  log "OK: airflow"
fi

log "CHECK: minio"
if ! check_http "http://localhost:9000/minio/health/live"; then
  log "FAIL: minio health endpoint unreachable"
  # Only restart datascience pod if not already restarted above
  restart_pod "datascience" "$SCRIPT_DIR/k8s/datascience-pod.yaml"
  ((FAILURES++))
else
  log "OK: minio"
fi

log "CHECK: jupyter"
if ! check_http "http://localhost:8888/jupyter/api/status"; then
  log "FAIL: jupyter status endpoint unreachable"
  restart_pod "datascience" "$SCRIPT_DIR/k8s/datascience-pod.yaml"
  ((FAILURES++))
else
  log "OK: jupyter"
fi

# Observability
log "CHECK: prometheus"
if ! check_http "http://localhost:9090/-/healthy"; then
  log "FAIL: prometheus health endpoint unreachable"
  restart_pod "observability" "$SCRIPT_DIR/k8s/observability-pod.yaml"
  ((FAILURES++))
else
  log "OK: prometheus"
fi

log "CHECK: grafana"
if ! check_http "http://localhost:3000/grafana/api/health"; then
  log "FAIL: grafana health endpoint unreachable"
  restart_pod "observability" "$SCRIPT_DIR/k8s/observability-pod.yaml"
  ((FAILURES++))
else
  log "OK: grafana"
fi

log "CHECK: loki"
if ! check_http "http://localhost:3100/ready"; then
  log "FAIL: loki ready endpoint unreachable"
  restart_pod "observability" "$SCRIPT_DIR/k8s/observability-pod.yaml"
  ((FAILURES++))
else
  log "OK: loki"
fi

# Ory Kratos
log "CHECK: kratos"
if ! check_http "http://localhost:4434/admin/health/alive"; then
  log "FAIL: kratos health endpoint unreachable"
  restart_pod "ory-kratos" "$SCRIPT_DIR/k8s/ory-kratos-pod.yaml"
  ((FAILURES++))
else
  log "OK: kratos"
fi

# --- Summary ---
if [[ $FAILURES -gt 0 ]]; then
  log "SUMMARY: $FAILURES health check(s) failed"
  exit 1
else
  log "SUMMARY: All health checks passed"
  exit 0
fi
```

### 2. Make the script executable

```bash
chmod +x scripts/pod-health-check.sh
```

### 3. Create a systemd user timer (recommended over cron)

Create `scripts/systemd/pod-health-check.service`:

```ini
[Unit]
Description=Pod health check and self-healing
After=network.target

[Service]
Type=oneshot
ExecStart=/home/joe/dev/github/joebarbere/claude-hello-world/scripts/pod-health-check.sh
Environment=LOG_FILE=/var/log/pod-health-check.log
StandardOutput=journal
StandardError=journal
```

Create `scripts/systemd/pod-health-check.timer`:

```ini
[Unit]
Description=Run pod health check every 2 minutes

[Timer]
OnBootSec=120
OnUnitActiveSec=120
AccuracySec=15s

[Install]
WantedBy=timers.target
```

Install with:
```bash
mkdir -p ~/.config/systemd/user/
cp scripts/systemd/pod-health-check.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pod-health-check.timer
```

### 4. Alternative: cron scheduling

For simplicity, add a crontab entry instead of systemd:

```bash
# Run health check every 2 minutes
*/2 * * * * /home/joe/dev/github/joebarbere/claude-hello-world/scripts/pod-health-check.sh >> /var/log/pod-health-check.log 2>&1
```

### 5. Add log rotation

Create `scripts/systemd/pod-health-check-logrotate` (or add to existing logrotate config):

```
/var/log/pod-health-check.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
```

### 6. Optional: Expose health-check results as a Prometheus metric

Create a simple textfile collector output that the `node_exporter` or a custom script can expose:

```bash
# At the end of pod-health-check.sh, write a metrics file:
METRICS_FILE="/tmp/pod-health-check-metrics.prom"
cat > "$METRICS_FILE" <<EOF
# HELP pod_health_check_failures Number of failed health checks
# TYPE pod_health_check_failures gauge
pod_health_check_failures $FAILURES
# HELP pod_health_check_last_run_timestamp Last health check run timestamp
# TYPE pod_health_check_last_run_timestamp gauge
pod_health_check_last_run_timestamp $(date +%s)
EOF
```

## Files to Create/Modify

- **Create**: `scripts/pod-health-check.sh` -- main health check and restart script
- **Create**: `scripts/systemd/pod-health-check.service` -- systemd service unit
- **Create**: `scripts/systemd/pod-health-check.timer` -- systemd timer unit (2-minute interval)
- **Create**: `scripts/systemd/pod-health-check-logrotate` -- log rotation config

## Testing

1. **Dry run**: `./scripts/pod-health-check.sh --dry-run` -- verify all checks pass without restarting anything
2. **Simulate failure**: Stop a pod (`podman pod stop datascience`), run the script, verify it detects the failure and restarts the pod
3. **Cooldown test**: Stop a pod, run the script twice within 5 minutes, verify the second run skips the restart due to cooldown
4. **Log verification**: Check `/var/log/pod-health-check.log` for timestamped entries
5. **Timer test**: If using systemd, run `systemctl --user status pod-health-check.timer` to confirm the timer is active and `journalctl --user -u pod-health-check.service` for execution logs
6. **Full cycle**: Let the timer run for 10 minutes while all pods are healthy, then stop one pod and verify it gets restarted within the next cycle

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Restart loop: pod fails immediately after restart, script restarts it again every 2 min | The `RESTART_COOLDOWN` (300s) prevents restarting the same pod more than once per 5 minutes |
| Cascading restarts: one pod failure causes another (e.g., restarting postgres breaks weather-api) | Check pods in dependency order (postgres first, then consumers); the cooldown also helps |
| `podman kube play --replace` causes brief downtime | Expected -- Podman doesn't support rolling restarts for pods. Downtime is typically < 30 seconds |
| Script runs while pods are intentionally stopped (development) | Use `--dry-run` flag, or disable the timer with `systemctl --user stop pod-health-check.timer` |
| Health check false positives during startup | Services may not respond immediately; the script should allow a grace period after system boot (the systemd `OnBootSec=120` handles this) |
| `apps-pod.yaml` contains two pod definitions separated by `---` | The `podman kube play --replace` command replays the entire YAML, so both pods in the file get restarted. This is acceptable but worth noting. |

## Dependencies

- **Benefits from**: `plan-liveness-readiness-probes.md` -- container-level probes handle individual container failures within a pod; this script handles pod-level failures (all containers in a pod down, or the pod itself not running)
- **Independent of**: Prometheus/Grafana plans. The script works standalone with just `curl`, `pg_isready`, and `podman`.

## Estimated Complexity

**Medium** -- The script logic is straightforward (HTTP/TCP checks + `podman kube play --replace`), but thorough testing across all pod failure scenarios and tuning the cooldown/ordering takes effort. Systemd timer setup is a one-time operation.

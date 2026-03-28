# Plan: Create kube-up.sh / kube-down.sh Lifecycle Scripts

## Goal

Create a pair of shell scripts (`scripts/kube-up.sh` and `scripts/kube-down.sh`) that encode the correct pod startup and teardown order with health check waits, support selective stack targeting, and integrate with the existing `sync-datascience.sh` script.

## Current State

- **Pod manifests**: Six pod YAML files in `k8s/`:
  - `postgres-pod.yaml` -- Postgres 17 (no dependencies)
  - `ory-kratos-pod.yaml` -- Ory Kratos identity (depends on Postgres)
  - `apps-pod.yaml` -- weather-api + Traefik + nginx (depends on Postgres, Kratos)
  - `kafka-pod.yaml` -- Kafka + Debezium + Schema Registry + Kafka UI + slot-guard (depends on Postgres for CDC)
  - `datascience-pod.yaml` -- Airflow + Jupyter + MinIO (depends on Postgres if Airflow uses Postgres metadata)
  - `observability-pod.yaml` -- Prometheus + Grafana + exporters + auth-proxy (depends on Kratos for auth-proxy)
- **Existing scripts**: `scripts/sync-datascience.sh` syncs DAGs, notebooks, and shared helpers to `/tmp/datascience/`. It must run before the datascience pod starts.
- **No startup automation**: Developers manually run `podman kube play` for each pod in the right order. The correct order is not documented anywhere except implicitly in `IDEAS.md`.
- **RUN.md**: Documents `nx serve` and `nx build` but not pod lifecycle.
- **CI workflows**: `.github/workflows/ci.yml` does not start pods. The e2e workflows in `eks-e2e.yml` / `eks-e2e-full.yml` would benefit from using these scripts.

## Implementation Steps

### 1. Create scripts/kube-up.sh

```bash
#!/usr/bin/env bash
# kube-up.sh — Start all pods in dependency order with health check waits.
#
# Usage:
#   bash scripts/kube-up.sh              # start all pods
#   bash scripts/kube-up.sh --stack=postgres   # start only postgres
#   bash scripts/kube-up.sh --stack=apps       # start postgres + kratos + apps
#   bash scripts/kube-up.sh --no-observability # start everything except observability

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
K8S_DIR="${REPO_ROOT}/k8s"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# Dependency order: each stack and what it needs to be healthy before starting.
# Format: stack_name:yaml_file:health_check_function
STACKS=(
  postgres
  ory-kratos
  apps
  kafka
  datascience
  observability
)

# Parse arguments
SELECTED_STACK=""
SKIP_STACKS=()
for arg in "$@"; do
  case "$arg" in
    --stack=*) SELECTED_STACK="${arg#--stack=}" ;;
    --no-*) SKIP_STACKS+=("${arg#--no-}") ;;
    --help|-h)
      echo "Usage: kube-up.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --stack=NAME        Start only the named stack and its dependencies"
      echo "  --no-NAME           Skip the named stack (e.g., --no-observability)"
      echo "  -h, --help          Show this help"
      echo ""
      echo "Stacks (in dependency order):"
      echo "  postgres, ory-kratos, apps, kafka, datascience, observability"
      exit 0
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Health check functions
# ---------------------------------------------------------------------------
wait_for_postgres() {
  echo "  Waiting for Postgres on port 5432..."
  for i in $(seq 1 30); do
    if pg_isready -h localhost -p 5432 -U appuser -q 2>/dev/null; then
      echo "  Postgres is ready."
      return 0
    fi
    sleep 2
  done
  echo "  WARNING: Postgres did not become ready within 60 seconds."
  return 1
}

wait_for_kratos() {
  echo "  Waiting for Kratos on port 4433..."
  for i in $(seq 1 30); do
    if curl -sf http://localhost:4433/health/ready >/dev/null 2>&1; then
      echo "  Kratos is ready."
      return 0
    fi
    sleep 2
  done
  echo "  WARNING: Kratos did not become ready within 60 seconds."
  return 1
}

wait_for_traefik() {
  echo "  Waiting for Traefik on port 8443..."
  for i in $(seq 1 15); do
    if curl -sfk https://localhost:8443/ >/dev/null 2>&1; then
      echo "  Traefik is ready."
      return 0
    fi
    sleep 2
  done
  echo "  WARNING: Traefik did not become ready within 30 seconds."
  return 1
}

wait_for_kafka() {
  echo "  Waiting for Kafka on port 9092..."
  for i in $(seq 1 30); do
    if (echo > /dev/tcp/localhost/9092) 2>/dev/null; then
      echo "  Kafka is ready."
      return 0
    fi
    sleep 2
  done
  echo "  WARNING: Kafka did not become ready within 60 seconds."
  return 1
}

# ---------------------------------------------------------------------------
# Stack dependency resolution
# ---------------------------------------------------------------------------
# Given a target stack, return it and all its dependencies in order.
resolve_deps() {
  local target="$1"
  case "$target" in
    postgres)       echo "postgres" ;;
    ory-kratos)     echo "postgres ory-kratos" ;;
    apps)           echo "postgres ory-kratos apps" ;;
    kafka)          echo "postgres kafka" ;;
    datascience)    echo "postgres datascience" ;;
    observability)  echo "postgres ory-kratos apps kafka datascience observability" ;;
    *)              echo "ERROR: Unknown stack: $target" >&2; exit 1 ;;
  esac
}

# Determine which stacks to start
if [[ -n "$SELECTED_STACK" ]]; then
  STACKS_TO_START=($(resolve_deps "$SELECTED_STACK"))
else
  STACKS_TO_START=("${STACKS[@]}")
fi

# Remove skipped stacks
FILTERED_STACKS=()
for stack in "${STACKS_TO_START[@]}"; do
  skip=false
  for s in "${SKIP_STACKS[@]+"${SKIP_STACKS[@]}"}"; do
    if [[ "$stack" == "$s" ]]; then
      skip=true
      break
    fi
  done
  if ! $skip; then
    FILTERED_STACKS+=("$stack")
  fi
done

# ---------------------------------------------------------------------------
# Start stacks
# ---------------------------------------------------------------------------
start_stack() {
  local stack="$1"
  local yaml="${K8S_DIR}/${stack}-pod.yaml"

  if [[ ! -f "$yaml" ]]; then
    echo "ERROR: Pod manifest not found: $yaml"
    return 1
  fi

  echo ""
  echo "=== Starting ${stack} ==="
  podman kube play "$yaml"

  # Post-start health checks and hooks
  case "$stack" in
    postgres)
      wait_for_postgres
      ;;
    ory-kratos)
      wait_for_kratos
      ;;
    apps)
      wait_for_traefik
      ;;
    kafka)
      wait_for_kafka
      ;;
    datascience)
      # Run sync script to populate DAG/notebook volumes before pod starts
      # (volumes are mounted from host, so syncing after play is fine too)
      echo "  Running sync-datascience.sh..."
      bash "${REPO_ROOT}/scripts/sync-datascience.sh"
      ;;
    observability)
      echo "  Observability stack started (no health gate)."
      ;;
  esac
}

echo "Starting stacks: ${FILTERED_STACKS[*]}"

for stack in "${FILTERED_STACKS[@]}"; do
  start_stack "$stack"
done

echo ""
echo "=== All requested stacks started ==="
echo ""
echo "Services:"
echo "  App:          https://localhost:8443/"
echo "  Weather API:  https://localhost:8443/weather"
echo "  Grafana:      https://localhost:8443/grafana/"
echo "  Airflow:      https://localhost:8443/airflow/"
echo "  Jupyter:      https://localhost:8443/jupyter/"
echo "  Kafka UI:     https://localhost:8443/kafka-ui/"
echo "  MinIO:        https://localhost:8443/minio-login"
echo "  Traefik:      http://localhost:8081/"
```

### 2. Create scripts/kube-down.sh

```bash
#!/usr/bin/env bash
# kube-down.sh — Stop all pods in reverse dependency order.
#
# Usage:
#   bash scripts/kube-down.sh              # stop all pods
#   bash scripts/kube-down.sh --stack=kafka # stop only kafka

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
K8S_DIR="${REPO_ROOT}/k8s"

# Reverse dependency order for teardown
STACKS=(
  observability
  datascience
  kafka
  apps
  ory-kratos
  postgres
)

# Parse arguments
SELECTED_STACK=""
for arg in "$@"; do
  case "$arg" in
    --stack=*) SELECTED_STACK="${arg#--stack=}" ;;
    --help|-h)
      echo "Usage: kube-down.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --stack=NAME  Stop only the named stack"
      echo "  -h, --help    Show this help"
      exit 0
      ;;
  esac
done

stop_stack() {
  local stack="$1"
  local yaml="${K8S_DIR}/${stack}-pod.yaml"

  if [[ ! -f "$yaml" ]]; then
    echo "WARNING: Pod manifest not found: $yaml (skipping)"
    return 0
  fi

  echo "Stopping ${stack}..."
  podman kube down "$yaml" 2>/dev/null || true
}

if [[ -n "$SELECTED_STACK" ]]; then
  stop_stack "$SELECTED_STACK"
else
  for stack in "${STACKS[@]}"; do
    stop_stack "$stack"
  done
fi

echo ""
echo "=== Teardown complete ==="
```

### 3. Make scripts executable

```bash
chmod +x scripts/kube-up.sh scripts/kube-down.sh
```

### 4. Integrate with sync-datascience.sh

The `kube-up.sh` script calls `sync-datascience.sh` automatically when starting the datascience stack. The sync script is idempotent, so running it multiple times is safe.

If pgAdmin is also implemented (per `plan-pgadmin-container.md`), add the pgAdmin sync step to `kube-up.sh` before starting the postgres stack.

### 5. Update RUN.md

Add a section to `RUN.md`:

```markdown
## Pod Lifecycle (Podman)

### Start all pods

```bash
bash scripts/kube-up.sh
```

### Start a single stack (with dependencies)

```bash
bash scripts/kube-up.sh --stack=apps       # starts postgres + kratos + apps
bash scripts/kube-up.sh --stack=kafka       # starts postgres + kafka
```

### Stop all pods

```bash
bash scripts/kube-down.sh
```

### Stop a single stack

```bash
bash scripts/kube-down.sh --stack=kafka
```

### Skip a stack

```bash
bash scripts/kube-up.sh --no-observability  # start everything except observability
```
```

### 6. Add Nx targets (optional)

Add run-commands targets to the root `project.json` or a new `k8s/project.json`:

```json
{
  "targets": {
    "kube-up": {
      "executor": "nx:run-commands",
      "options": {
        "command": "bash scripts/kube-up.sh"
      }
    },
    "kube-down": {
      "executor": "nx:run-commands",
      "options": {
        "command": "bash scripts/kube-down.sh"
      }
    }
  }
}
```

This allows `npx nx run project:kube-up` as an alternative invocation.

### 7. Update CI workflows

The e2e workflows can replace their manual pod startup commands with:

```yaml
- name: Start infrastructure
  run: bash scripts/kube-up.sh
```

This ensures CI uses the same startup sequence as developers.

## Files to Create/Modify

- **Create**: `scripts/kube-up.sh` -- orchestrated pod startup with health checks
- **Create**: `scripts/kube-down.sh` -- reverse-order pod teardown
- **Modify**: `RUN.md` -- add pod lifecycle documentation
- **Modify** (optional): root `project.json` or `k8s/project.json` -- add Nx targets
- **Modify** (optional): `.github/workflows/eks-e2e.yml` and `eks-e2e-full.yml` -- use kube-up.sh

## Testing

1. **Full startup**: Run `bash scripts/kube-up.sh` from a clean state (no pods running). All six pods should start in order with health check confirmations printed between stages.

2. **Full teardown**: Run `bash scripts/kube-down.sh`. All pods should stop. Verify with `podman pod ps` showing no running pods.

3. **Selective startup**: Run `bash scripts/kube-up.sh --stack=apps`. Only postgres, ory-kratos, and apps should start. Verify kafka, datascience, and observability are not running.

4. **Selective teardown**: With all pods running, run `bash scripts/kube-down.sh --stack=kafka`. Only the kafka pod should stop. Verify all other pods are still running.

5. **Skip flag**: Run `bash scripts/kube-up.sh --no-observability --no-datascience`. Verify those two pods are not started.

6. **Idempotency**: Run `bash scripts/kube-up.sh` twice. The second run should either succeed (podman kube play is idempotent) or gracefully report that pods are already running.

7. **Health check failure**: Stop Postgres manually, then try `bash scripts/kube-up.sh --stack=ory-kratos`. The script should wait for Postgres (which is not running) and eventually print a warning.

8. **sync-datascience runs**: After `kube-up.sh` starts the datascience stack, verify DAG files exist in `/tmp/datascience/airflow/dags/`.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `pg_isready` not available on the host | The script uses `pg_isready` which requires `postgresql-client` to be installed. Add a fallback using a TCP check (`/dev/tcp/localhost/5432` in bash) or `curl`. Document the dependency. |
| `curl` not available on minimal CI images | `curl` is standard on Ubuntu runners. For minimal images, install it or use `wget`. |
| `podman kube play` fails if pod already exists | `podman kube play` returns an error if the pod is already running. Add `podman kube down "$yaml" 2>/dev/null || true` before `podman kube play` if idempotent restarts are desired, or check pod status first. |
| Health check timeouts are too short/long | The 60-second timeout (30 iterations x 2 seconds) is generous for local dev. CI may need longer timeouts. Make timeouts configurable via environment variables. |
| Script assumes bash | The shebang uses `/usr/bin/env bash`. Users with fish shell (as in this environment) need to invoke it explicitly as `bash scripts/kube-up.sh`. |
| Dependency resolution is hardcoded | For six pods, a simple case statement is maintainable. If the number of pods grows significantly, consider a topological sort, but that is overengineering for now. |

## Dependencies

- **Separate Postgres stack** (`plan-separate-postgres-stack.md`): The scripts encode a startup order that assumes Postgres is independent. This is already the case today (separate pod YAML), but the health probes from that plan make the wait steps more reliable.
- **Separate Kratos stack** (`plan-separate-kratos-stack.md`): Same rationale -- Kratos health probes make the `wait_for_kratos` check work correctly.
- **No blockers**: The scripts work with the current pod manifests as-is. Health check waits degrade gracefully (print a warning) if probes are not yet added.

## Estimated Complexity

**Small** -- Two shell scripts (~100 lines each), a RUN.md update, and optional Nx target wiring. No container or application changes needed.

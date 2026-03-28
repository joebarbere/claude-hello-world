# Plan: Separate Postgres into an Independent Stack

## Goal

Make the Postgres pod a fully independent infrastructure component with explicit startup ordering, health checks, and documented lifecycle management so it can be started, stopped, upgraded, and backed up independently of all other pods.

## Current State

- **Postgres pod**: `k8s/postgres-pod.yaml` is already a standalone pod manifest with a single container (`postgres:17-alpine` via `localhost/postgres:latest`). It exposes port 5432 on the host.
- **Dependents**: Multiple pods connect to Postgres via `host.containers.internal:5432`:
  - `k8s/ory-kratos-pod.yaml` -- `kratos-migrate` initContainer and `ory-kratos` container both use DSN `postgres://appuser:apppassword@host.containers.internal:5432/appdb?sslmode=disable`
  - `k8s/apps-pod.yaml` -- weather-api container uses `Host=host.containers.internal;Port=5432;Database=appdb`
  - `k8s/kafka-pod.yaml` -- slot-guard container uses `PGHOST=host.containers.internal`
  - `k8s/observability-pod.yaml` -- postgres-exporter uses `postgresql://appuser:apppassword@host.containers.internal:5432/appdb?sslmode=disable`
  - `k8s/datascience-pod.yaml` -- currently uses SQLite, but after the Airflow Postgres migration would also depend on Postgres
- **No startup ordering**: There is no mechanism enforcing that Postgres starts before its dependents. Developers must remember to start `postgres-pod.yaml` first.
- **No health checks**: No liveness or readiness probes exist in any pod manifest.
- **CI workflow**: `.github/workflows/ci.yml` only builds and tests Angular/dotnet code -- it does not start pods. `.github/workflows/eks-e2e.yml` and `eks-e2e-full.yml` handle e2e but would need to be checked for pod startup order.
- **RUN.md**: `RUN.md` documents `nx serve` and `nx build` commands but does not document pod startup.

## Implementation Steps

### 1. Add a liveness probe to the Postgres pod

Edit `k8s/postgres-pod.yaml`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres
  labels:
    app: postgres
spec:
  containers:
    - name: postgres
      image: localhost/postgres:latest
      ports:
        - containerPort: 5432
          hostPort: 5432
      env:
        - name: POSTGRES_DB
          value: appdb
        - name: POSTGRES_USER
          value: appuser
        - name: POSTGRES_PASSWORD
          value: apppassword
      livenessProbe:
        exec:
          command:
            - pg_isready
            - -U
            - appuser
            - -d
            - appdb
        initialDelaySeconds: 5
        periodSeconds: 10
      readinessProbe:
        exec:
          command:
            - pg_isready
            - -U
            - appuser
            - -d
            - appdb
        initialDelaySeconds: 3
        periodSeconds: 5
```

### 2. Add Postgres readiness waits to dependent pod entrypoints

Since Podman kube play does not support inter-pod dependencies, each dependent must wait for Postgres internally.

**Ory Kratos**: The `kratos-migrate` initContainer already fails and retries if Postgres is not ready (Kratos migration exits non-zero on connection failure). However, the pod will enter CrashLoopBackOff rather than gracefully waiting. Options:

- Add a lightweight init container before `kratos-migrate` that polls `pg_isready`:

```yaml
initContainers:
  - name: wait-for-postgres
    image: docker.io/library/postgres:17-alpine
    command:
      - sh
      - -c
      - |
        until pg_isready -h host.containers.internal -p 5432 -U appuser; do
          echo "Waiting for Postgres..."
          sleep 2
        done
  - name: kratos-migrate
    image: localhost/ory-kratos:latest
    args: ["migrate", "sql", "--yes", "-e", "-c", "/etc/config/kratos/kratos.yml"]
    env:
      - name: DSN
        value: postgres://appuser:apppassword@host.containers.internal:5432/appdb?sslmode=disable
```

**Weather API**: The .NET `Npgsql` connection pool retries by default, but the EF Core migration (if run on startup) will fail. If the weather-api does not run migrations on startup (it appears Kratos does the schema migration), then the built-in connection retry is likely sufficient. Monitor and add a wait if needed.

**Slot-guard**: Already runs in a loop checking replication slots. Tolerates Postgres downtime naturally.

**Postgres-exporter**: Retries on its own. No change needed.

### 3. Document startup order in RUN.md

Add a "Pod Startup" section to `RUN.md`:

```markdown
## Pod Startup (Podman)

Pods must be started in dependency order. Postgres is the foundation layer.

### Startup order

1. **postgres** -- database (no dependencies)
2. **ory-kratos** -- identity provider (depends on postgres)
3. **apps** -- weather-api + traefik + nginx (depends on postgres, ory-kratos)
4. **kafka** -- Kafka + Debezium + Schema Registry (depends on postgres for CDC)
5. **datascience** -- Airflow + Jupyter + MinIO (depends on postgres if using Postgres metadata)
6. **observability** -- Prometheus + Grafana + exporters (depends on all others for scraping)

### Manual startup

```bash
podman kube play k8s/postgres-pod.yaml
# Wait for Postgres to accept connections:
until pg_isready -h localhost -p 5432 -U appuser; do sleep 2; done

podman kube play k8s/ory-kratos-pod.yaml
podman kube play k8s/apps-pod.yaml
podman kube play k8s/kafka-pod.yaml
podman kube play k8s/datascience-pod.yaml
podman kube play k8s/observability-pod.yaml
```
```

### 4. Update CI workflows if applicable

Review `.github/workflows/eks-e2e.yml` and `eks-e2e-full.yml` to ensure they start `postgres-pod.yaml` first and wait for readiness before starting dependent pods. The main `ci.yml` workflow does not start pods (it only builds and runs unit tests), so no changes are needed there.

### 5. Add a Postgres data persistence note

Currently `k8s/postgres-pod.yaml` has no volume mount -- data lives in the container's ephemeral storage and is lost on pod restart. Add an optional hostPath volume:

```yaml
      volumeMounts:
        - name: pgdata
          mountPath: /var/lib/postgresql/data
  volumes:
    - name: pgdata
      hostPath:
        path: /tmp/postgres/data
```

Document in `RUN.md` that developers who want persistent data should use a non-`/tmp` path (e.g., `~/postgres-data`).

## Files to Create/Modify

- **Modify**: `k8s/postgres-pod.yaml` -- add liveness/readiness probes, optional data volume
- **Modify**: `k8s/ory-kratos-pod.yaml` -- add `wait-for-postgres` initContainer
- **Modify**: `RUN.md` -- add pod startup order documentation
- **Modify**: `.github/workflows/eks-e2e.yml` and `eks-e2e-full.yml` -- verify/fix pod startup order (if they start pods)

## Testing

1. **Probes work**: Start the postgres pod and verify readiness:
   ```bash
   podman kube play k8s/postgres-pod.yaml
   podman healthcheck run postgres-postgres  # or check pod status
   ```

2. **Dependent pods tolerate late Postgres start**: Start ory-kratos-pod before postgres-pod. The `wait-for-postgres` initContainer should block until Postgres is available, then `kratos-migrate` should succeed.

3. **Postgres survives independent restart**: With all pods running:
   ```bash
   podman kube down k8s/postgres-pod.yaml
   podman kube play k8s/postgres-pod.yaml
   ```
   Dependent services should reconnect automatically (verify weather-api responds to `GET /weather`, Grafana postgres-exporter resumes scraping).

4. **Data persistence**: If the pgdata volume is configured, insert a row via the API, restart the postgres pod, and verify the row survives.

5. **CI passes**: Run the e2e workflow and confirm pods start in the correct order without timeout failures.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `wait-for-postgres` initContainer adds startup time | The `pg_isready` loop is lightweight (2-second intervals). In practice, Postgres starts in 2-3 seconds, so the wait adds <5 seconds. |
| Cross-pod networking via `host.containers.internal` may not work in all CI environments | Test explicitly in GitHub Actions runners. Podman rootless on Ubuntu supports this. If not, use `--network=host` or a shared Podman network. |
| Persistent volume on `/tmp` is cleared on reboot | Document that `/tmp` is for ephemeral dev use. For persistence, use a home-directory path. |
| Adding the `postgres:17-alpine` image as an initContainer image increases pull time for ory-kratos | The image is small (~80 MB) and likely already cached if the postgres pod was started first. Alternatively, use a `busybox` image with a TCP check instead of `pg_isready`. |

## Dependencies

- **Lifecycle scripts** (`plan-lifecycle-scripts.md`): Implementing `kube-up.sh` would automate the startup order documented here. These two plans are complementary and ideally implemented together.
- **Airflow Postgres metadata** (`plan-airflow-postgres-metadata.md`): Makes datascience pod a Postgres dependent, reinforcing the need for explicit ordering.
- **No blockers**: This change can be implemented independently.

## Estimated Complexity

**Medium** -- The Postgres pod is already separate. The work is in adding probes, initContainer waits, documentation, and CI verification. No application code changes are needed.

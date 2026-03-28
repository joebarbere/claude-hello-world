# Plan: Switch Airflow from SQLite/SequentialExecutor to Postgres/LocalExecutor

## Goal

Replace Airflow's default SQLite metadata database and SequentialExecutor with a dedicated Postgres database and LocalExecutor, enabling parallel DAG task execution and production-grade metadata durability.

## Current State

- **Executor**: `SequentialExecutor` configured via `AIRFLOW__CORE__EXECUTOR` in `k8s/datascience-pod.yaml` (line 16).
- **Database**: SQLite at `sqlite:////opt/airflow/airflow.db` configured via `AIRFLOW__DATABASE__SQL_ALCHEMY_CONN` in `k8s/datascience-pod.yaml` (line 18). The SQLite file lives inside the container and is lost on every pod restart.
- **Entrypoint**: `apps/datascience/airflow/entrypoint.sh` already runs `airflow db migrate` on startup, so switching the DSN is sufficient for schema initialization.
- **Postgres pod**: `k8s/postgres-pod.yaml` runs `postgres:17-alpine` with a single database `appdb` (user `appuser`, password `apppassword`). The Containerfile at `apps/postgres/Containerfile` enables logical replication for Debezium but has no init scripts directory.
- **Cross-pod networking**: Other pods (ory-kratos, kafka/slot-guard, observability/postgres-exporter) already reach Postgres via `host.containers.internal:5432`.
- **Airflow image**: `apps/datascience/airflow/Containerfile` installs `apache-airflow-providers-common-sql` but does **not** install `psycopg2` or `psycopg2-binary`, which Airflow needs for a Postgres backend.

## Implementation Steps

### 1. Add psycopg2-binary to the Airflow container image

Edit `apps/datascience/airflow/Containerfile` to add `psycopg2-binary` to the pip install list:

```dockerfile
RUN pip install --no-cache-dir \
        apache-airflow-providers-common-sql \
        duckdb \
        duckdb-engine \
        minio \
        pandas \
        psycopg2-binary \
        pyarrow \
        requests \
        "confluent-kafka[schema-registry]" \
        fastavro
```

### 2. Provision a dedicated `airflow` database in Postgres

Create an init SQL script that Postgres will execute on first start. Postgres 17 Alpine supports `/docker-entrypoint-initdb.d/` scripts.

Create `apps/postgres/init/01-create-airflow-db.sql`:

```sql
-- Create a dedicated database and user for Airflow metadata.
-- Separate from appdb to avoid schema conflicts with EF Core migrations.
CREATE USER airflow WITH PASSWORD 'airflow';
CREATE DATABASE airflow OWNER airflow;
```

Update `apps/postgres/Containerfile` to copy the init script:

```dockerfile
FROM docker.io/library/postgres:17-alpine

ENV POSTGRES_DB=appdb
ENV POSTGRES_USER=appuser
ENV POSTGRES_PASSWORD=apppassword

COPY init/ /docker-entrypoint-initdb.d/

EXPOSE 5432

CMD ["postgres", "-c", "wal_level=logical", "-c", "max_replication_slots=4", "-c", "max_wal_senders=4"]
```

**Important**: The init scripts only run when the Postgres data directory is empty (first start). For existing deployments, run the SQL manually via `psql` or rebuild the Postgres volume.

### 3. Update datascience-pod.yaml environment variables

In `k8s/datascience-pod.yaml`, change the Airflow container's env vars:

```yaml
env:
  - name: AIRFLOW__CORE__EXECUTOR
    value: LocalExecutor
  - name: AIRFLOW__DATABASE__SQL_ALCHEMY_CONN
    value: "postgresql+psycopg2://airflow:airflow@host.containers.internal:5432/airflow"
```

All other env vars remain unchanged.

### 4. Add a startup wait for Postgres in the entrypoint

Edit `apps/datascience/airflow/entrypoint.sh` to wait for Postgres before running `airflow db migrate`:

```bash
#!/bin/bash
set -e

# Wait for Postgres to be ready (required since Airflow metadata is now in Postgres)
echo "Waiting for Postgres at host.containers.internal:5432..."
for i in $(seq 1 30); do
  if pg_isready -h host.containers.internal -p 5432 -U airflow -d airflow 2>/dev/null; then
    echo "Postgres is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Postgres not ready after 30 attempts. Exiting."
    exit 1
  fi
  sleep 2
done

airflow db migrate
airflow users create \
  --username "${_AIRFLOW_WWW_USER_USERNAME:-admin}" \
  --password "${_AIRFLOW_WWW_USER_PASSWORD:-admin}" \
  --firstname Admin \
  --lastname User \
  --role Admin \
  --email admin@example.com || true
# Start scheduler in background, webserver in foreground
airflow scheduler &
exec airflow webserver
```

**Note**: `pg_isready` is available in the Airflow image since `psycopg2-binary` does not bundle it. Install `postgresql-client` in the Containerfile if `pg_isready` is not present, or use a Python-based TCP check instead:

```bash
python3 -c "
import socket, time, sys
for i in range(30):
    try:
        s = socket.create_connection(('host.containers.internal', 5432), timeout=2)
        s.close()
        sys.exit(0)
    except:
        time.sleep(2)
sys.exit(1)
"
```

### 5. Rebuild container images

```bash
podman build -t localhost/postgres:latest -f apps/postgres/Containerfile apps/postgres/
podman build -t localhost/airflow:latest -f apps/datascience/airflow/Containerfile apps/datascience/airflow/
```

### 6. Restart pods in order

```bash
podman kube down k8s/datascience-pod.yaml
podman kube down k8s/postgres-pod.yaml
# If init scripts need to run, remove old Postgres data volume
podman kube play k8s/postgres-pod.yaml
# Wait for Postgres to accept connections
podman kube play k8s/datascience-pod.yaml
```

## Files to Create/Modify

- **Create**: `apps/postgres/init/01-create-airflow-db.sql` -- init script for airflow database
- **Modify**: `apps/postgres/Containerfile` -- add COPY for init scripts
- **Modify**: `apps/datascience/airflow/Containerfile` -- add `psycopg2-binary` dependency
- **Modify**: `apps/datascience/airflow/entrypoint.sh` -- add Postgres readiness wait
- **Modify**: `k8s/datascience-pod.yaml` -- change executor and DSN env vars

## Testing

1. **Postgres database exists**: After starting the postgres pod, verify the airflow database was created:
   ```bash
   podman exec postgres-postgres psql -U appuser -c "\l" | grep airflow
   ```

2. **Airflow starts successfully**: Check logs for successful migration:
   ```bash
   podman logs datascience-airflow 2>&1 | grep "Running upgrade"
   ```

3. **LocalExecutor is active**: Visit the Airflow UI at `https://localhost:8443/airflow/` and confirm the executor shows `LocalExecutor` on the health page.

4. **Parallel task execution**: Trigger a DAG with multiple independent tasks and verify they run concurrently (not serially). Check task start/end times in the Airflow UI Gantt chart.

5. **Metadata persistence**: Trigger a DAG run, restart the datascience pod, verify the DAG run history is still visible in the Airflow UI.

6. **Existing DAGs still work**: Trigger `dag_download_weather` and `dag_quality_report` manually and verify they complete successfully.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Postgres not ready when Airflow starts | The entrypoint wait loop (step 4) retries for 60 seconds before failing. |
| Init script doesn't run on existing Postgres volume | Document that the Postgres data volume must be recreated, or provide manual SQL. |
| `psycopg2-binary` incompatibility with Alpine-based Airflow image | The `slim-` Airflow image is Debian-based, so precompiled `psycopg2-binary` works. If issues arise, switch to `psycopg2` with `libpq-dev` build deps. |
| LocalExecutor uses more memory than SequentialExecutor | LocalExecutor spawns processes per task. For the current DAG count (2-3 DAGs, 5-10 tasks each), this is negligible. Monitor with `podman stats`. |
| Shared Postgres becomes a single point of failure for both the app and Airflow | Using a separate `airflow` database with a separate `airflow` user isolates failure. If Postgres is down, both app and Airflow are affected regardless. |

## Dependencies

- **Separate Postgres stack** (`plan-separate-postgres-stack.md`): Not strictly required, but the startup ordering concern (Postgres must be up before datascience) becomes a hard requirement with this change. The lifecycle scripts (`plan-lifecycle-scripts.md`) would encode this order.
- **No blockers**: This change can be implemented independently.

## Estimated Complexity

**Medium** -- Requires changes to 5 files across 2 container images, a new init script, and careful startup ordering. The core change (env var swap) is small, but the supporting changes (psycopg2, init script, readiness wait) add up.

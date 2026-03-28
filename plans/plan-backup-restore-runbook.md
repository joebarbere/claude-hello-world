# Plan: Postgres and MinIO Backup and Restore

## Goal

Establish automated daily backups for Postgres and MinIO — the two stateful services in the platform — with a documented restore procedure and CI-based monthly restore testing to validate backup integrity.

## Current State

- **Postgres** (`k8s/postgres-pod.yaml`, `apps/postgres/Containerfile`): PostgreSQL 17 Alpine with database `appdb`, user `appuser`, password `apppassword`. Logical replication is enabled (`wal_level=logical`) for Debezium CDC. No volumes are defined in the pod YAML — data lives inside the container and is lost on pod restart. There is no backup script or scheduled dump.
- **MinIO** (`k8s/datascience-pod.yaml`, lines 73-91): MinIO server in the datascience pod. Data is stored at `/data` mounted from `hostPath: /tmp/datascience/minio/data`. The YAML comments note this can be changed to a persistent directory like `~/datascience/minio/data`. Credentials: `minioadmin`/`minioadmin`. No backup or mirror script exists.
- **Debezium** (`apps/kafka/debezium-init/register-connector.sh`): Registers the `weather-api-connector` with slot `debezium_weather` and publication `dbz_publication`. After a Postgres restore, the replication slot and publication must be re-created, and the Debezium connector re-registered.
- **Airflow metadata**: Currently SQLite inside the Airflow container (`sqlite:////opt/airflow/airflow.db`) — ephemeral and not backed up. If the "Use Postgres for Airflow metadata" plan is implemented, Airflow metadata would also need to be included in the Postgres backup.
- **Ory Kratos**: Uses its own schema in the same `appdb` Postgres database (based on `k8s/ory-kratos-pod.yaml` pointing at the same connection string). A `pg_dump` of the full database captures Kratos identity data as well.
- **Scripts directory**: `scripts/` contains `sync-datascience.sh` and `take-screenshots.mjs`. No backup scripts exist.
- **Observability**: Prometheus and Grafana in `apps/observability/` store metrics data in ephemeral container volumes. These are not covered in this plan (metrics are considered reproducible).

## Implementation Steps

### 1. Create the Postgres backup script

Create `scripts/backup-postgres.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Configuration (overridable via environment)
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-appuser}"
PGDATABASE="${PGDATABASE:-appdb}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

export PGPASSWORD="${PGPASSWORD:-apppassword}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/appdb-${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[$(date -Iseconds)] Starting pg_dump of ${PGDATABASE}..."
pg_dump \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --format=custom \
  --compress=6 \
  --file="${BACKUP_FILE}" \
  "$PGDATABASE"

echo "[$(date -Iseconds)] Backup saved to ${BACKUP_FILE} ($(du -h "$BACKUP_FILE" | cut -f1))"

# Prune old backups
find "$BACKUP_DIR" -name "appdb-*.sql.gz" -mtime +${RETENTION_DAYS} -delete
echo "[$(date -Iseconds)] Pruned backups older than ${RETENTION_DAYS} days."
```

Notes:
- Uses `pg_dump --format=custom` for the most flexible restore options (supports parallel restore, selective table restore, and built-in compression).
- The `--compress=6` flag uses zlib compression (default level).
- Prunes backups older than 30 days by default.

### 2. Create the MinIO backup script

Create `scripts/backup-minio.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

MINIO_ALIAS="${MINIO_ALIAS:-local}"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/minio}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# Configure mc alias (idempotent)
mc alias set "$MINIO_ALIAS" "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" --quiet

echo "[$(date -Iseconds)] Starting MinIO mirror..."

# Mirror all buckets to local backup directory
mc mirror --overwrite "${MINIO_ALIAS}/" "${BACKUP_DIR}/${TIMESTAMP}/"

echo "[$(date -Iseconds)] MinIO backup saved to ${BACKUP_DIR}/${TIMESTAMP}/"

# Prune old backups (keep last 7 snapshots)
ls -dt "${BACKUP_DIR}"/20* 2>/dev/null | tail -n +8 | xargs rm -rf --
echo "[$(date -Iseconds)] Pruned MinIO snapshots (kept latest 7)."
```

Notes:
- Uses `mc mirror` which copies only changed objects (incremental).
- Requires `mc` (MinIO Client) to be installed on the host. It is a single static binary.
- Keeps the last 7 daily snapshots (~1 week).

### 3. Create a combined backup wrapper

Create `scripts/backup-all.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Postgres Backup ==="
"$SCRIPT_DIR/backup-postgres.sh"

echo ""
echo "=== MinIO Backup ==="
"$SCRIPT_DIR/backup-minio.sh"

echo ""
echo "=== All backups complete ==="
```

### 4. Create the Postgres restore script

Create `scripts/restore-postgres.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-appuser}"
PGDATABASE="${PGDATABASE:-appdb}"
export PGPASSWORD="${PGPASSWORD:-apppassword}"

BACKUP_FILE="${1:?Usage: restore-postgres.sh <backup-file.sql.gz>}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "[$(date -Iseconds)] WARNING: This will drop and recreate the '${PGDATABASE}' database."
echo "Press Ctrl+C within 5 seconds to abort..."
sleep 5

echo "[$(date -Iseconds)] Terminating active connections..."
psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${PGDATABASE}' AND pid <> pg_backend_pid();" || true

echo "[$(date -Iseconds)] Dropping and recreating database..."
psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" -d postgres -c \
  "DROP DATABASE IF EXISTS ${PGDATABASE};"
psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" -d postgres -c \
  "CREATE DATABASE ${PGDATABASE} OWNER ${PGUSER};"

echo "[$(date -Iseconds)] Restoring from ${BACKUP_FILE}..."
pg_restore \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --dbname="$PGDATABASE" \
  --no-owner \
  --no-privileges \
  --verbose \
  "$BACKUP_FILE"

echo "[$(date -Iseconds)] Restore complete."
echo ""
echo "=== Post-restore steps ==="
echo "1. Restart the weather-api pod (EF Core will validate the schema):"
echo "   podman pod restart weather-api"
echo ""
echo "2. Restart the ory-kratos pod (Kratos migration will reconcile):"
echo "   podman pod restart ory-kratos"
echo ""
echo "3. Re-register the Debezium CDC connector:"
echo "   podman exec kafka debezium-init /register-connector.sh"
echo "   (The replication slot and publication will be recreated by Debezium.)"
echo ""
echo "4. Verify data:"
echo "   curl -k https://localhost:8443/weather | jq length"
echo "   curl -k https://localhost:8443/minions | jq length"
```

### 5. Create the MinIO restore script

Create `scripts/restore-minio.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

MINIO_ALIAS="${MINIO_ALIAS:-local}"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}"

BACKUP_DIR="${1:?Usage: restore-minio.sh <backup-snapshot-dir>}"

if [ ! -d "$BACKUP_DIR" ]; then
  echo "ERROR: Backup directory not found: $BACKUP_DIR"
  exit 1
fi

mc alias set "$MINIO_ALIAS" "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" --quiet

echo "[$(date -Iseconds)] Restoring MinIO from ${BACKUP_DIR}..."

# Mirror backup back to MinIO (overwrite existing objects)
mc mirror --overwrite "$BACKUP_DIR/" "${MINIO_ALIAS}/"

echo "[$(date -Iseconds)] MinIO restore complete."
echo ""
echo "Verify buckets:"
echo "  mc ls ${MINIO_ALIAS}/"
```

### 6. Schedule daily backups via cron

Add to the host's crontab (or document in `RUN.md` for manual setup):

```cron
# Daily Postgres + MinIO backup at 03:00 local time
0 3 * * * /path/to/repo/scripts/backup-all.sh >> /var/log/weather-backup.log 2>&1
```

Alternatively, if the "Use Postgres for Airflow metadata" plan is implemented, create an Airflow DAG (`apps/datascience/airflow/dags/dag_backup.py`) that runs `backup-postgres.sh` via `BashOperator` and uploads the dump file to a dedicated MinIO bucket `backups/postgres/`. This keeps the backup schedule visible in the Airflow UI.

### 7. Add Postgres volume persistence to the pod YAML

Edit `k8s/postgres-pod.yaml` to add a persistent hostPath volume (currently data is ephemeral):

```yaml
spec:
  containers:
    - name: postgres
      # ... existing config ...
      volumeMounts:
        - name: pgdata
          mountPath: /var/lib/postgresql/data
  volumes:
    - name: pgdata
      hostPath:
        path: /home/joe/datascience/postgres/data
```

This ensures Postgres data survives pod restarts even without a backup/restore cycle.

### 8. Create a CI restore test workflow

Create `.github/workflows/backup-restore-test.yml`:

```yaml
name: Backup/Restore Integrity Test
on:
  schedule:
    - cron: '0 6 1 * *'  # First day of each month at 06:00 UTC
  workflow_dispatch: {}

jobs:
  test-restore:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_DB: appdb
          POSTGRES_USER: appuser
          POSTGRES_PASSWORD: apppassword
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Install MinIO Client
        run: |
          curl -sSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc
          chmod +x /usr/local/bin/mc

      - name: Seed test data
        run: |
          psql postgresql://appuser:apppassword@localhost:5432/appdb -c "
            CREATE TABLE IF NOT EXISTS \"WeatherForecasts\" (
              \"Id\" SERIAL PRIMARY KEY,
              \"Date\" DATE NOT NULL,
              \"TemperatureC\" INT NOT NULL,
              \"Summary\" VARCHAR(200)
            );
            INSERT INTO \"WeatherForecasts\" (\"Date\", \"TemperatureC\", \"Summary\")
            VALUES ('2026-01-01', 5, 'Cold'), ('2026-07-01', 30, 'Hot');
          "

      - name: Run backup
        env:
          PGHOST: localhost
          PGPASSWORD: apppassword
          BACKUP_DIR: /tmp/backup-test/postgres
        run: bash scripts/backup-postgres.sh

      - name: Verify backup file exists
        run: ls -la /tmp/backup-test/postgres/appdb-*.sql.gz

      - name: Drop database (simulate disaster)
        run: |
          psql postgresql://appuser:apppassword@localhost:5432/postgres -c "DROP DATABASE appdb;"
          psql postgresql://appuser:apppassword@localhost:5432/postgres -c "CREATE DATABASE appdb OWNER appuser;"

      - name: Run restore
        env:
          PGHOST: localhost
          PGPASSWORD: apppassword
        run: |
          BACKUP_FILE=$(ls -t /tmp/backup-test/postgres/appdb-*.sql.gz | head -1)
          # Skip the 5-second confirmation delay in CI
          yes | timeout 10 bash scripts/restore-postgres.sh "$BACKUP_FILE" || true

      - name: Verify restored data
        run: |
          COUNT=$(psql -t postgresql://appuser:apppassword@localhost:5432/appdb -c "SELECT COUNT(*) FROM \"WeatherForecasts\";")
          echo "Row count: $COUNT"
          if [ "$(echo $COUNT | tr -d ' ')" -ne 2 ]; then
            echo "FAIL: Expected 2 rows, got $COUNT"
            exit 1
          fi
          echo "PASS: Restore verified successfully."
```

### 9. Document the backup/restore procedure in RUN.md

Add a "Backup & Restore" section to `RUN.md` with:
- Prerequisites (`pg_dump`, `pg_restore`, `mc` must be on the host PATH)
- How to run a manual backup
- How to schedule automated backups
- Step-by-step restore procedure (including Debezium re-registration)
- How to run the CI restore test locally

## Files to Create/Modify

- **Create** `scripts/backup-postgres.sh`
- **Create** `scripts/backup-minio.sh`
- **Create** `scripts/backup-all.sh`
- **Create** `scripts/restore-postgres.sh`
- **Create** `scripts/restore-minio.sh`
- **Create** `.github/workflows/backup-restore-test.yml`
- **Modify** `k8s/postgres-pod.yaml` — add persistent volume mount for pgdata
- **Modify** `RUN.md` — add Backup & Restore section

## Testing

1. **Manual backup round-trip**:
   - Seed some forecasts and minions via the API.
   - Run `scripts/backup-postgres.sh` and `scripts/backup-minio.sh`.
   - Verify backup files exist and are non-empty.
   - Tear down and recreate the Postgres pod (losing all data).
   - Run `scripts/restore-postgres.sh` with the backup file.
   - Verify forecasts and minions are present via `curl -k https://localhost:8443/weather`.
   - Verify Kratos identities survived by logging in.
2. **MinIO round-trip**:
   - Verify MinIO buckets contain objects (`mc ls local/`).
   - Run `scripts/backup-minio.sh`.
   - Delete a bucket (`mc rb --force local/weather-raw`).
   - Run `scripts/restore-minio.sh` with the backup snapshot directory.
   - Verify the bucket and objects are restored.
3. **Debezium recovery**:
   - After a Postgres restore, restart the kafka pod.
   - Verify the Debezium connector re-registers and the replication slot is recreated.
   - Create a new forecast and confirm it appears in the `weather.public.WeatherForecasts` Kafka topic via kafka-ui.
4. **CI restore test**: Trigger `.github/workflows/backup-restore-test.yml` manually via `workflow_dispatch` and verify the job passes.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **Backup taken during active writes** — `pg_dump` is consistent (uses MVCC snapshot) so this is safe for Postgres. MinIO `mc mirror` may miss objects being written mid-copy. | For MinIO, run `mc mirror` twice with a short delay, or accept that in-flight objects may be in the next backup. For critical consistency, pause write workloads first. |
| **Replication slot not recreated after restore** — Debezium expects a specific slot name (`debezium_weather`). After a full restore the slot may not exist or may have stale LSN offsets. | The Debezium init script (`register-connector.sh`) re-registers the connector, which recreates the slot. Restart the kafka pod after a Postgres restore. Debezium will re-snapshot the database if the slot is new. |
| **Backup files consume disk space** — daily Postgres dumps + MinIO snapshots can grow quickly. | Retention policy: 30 days for Postgres dumps, 7 snapshots for MinIO. Monitor backup directory size. For a small dev database, this is unlikely to be an issue. |
| **Restore script drops the database** — accidental execution could destroy production data. | The script includes a 5-second delay with a warning. For additional safety, add a `--confirm` flag requirement. The CI test uses a throwaway database. |
| **Credentials in backup scripts** — `PGPASSWORD` and MinIO keys are passed via environment variables. | Consistent with the project's current approach (hardcoded passwords in pod YAMLs). Longer-term, use Podman secrets or a `.env` file (see "Rotate hardcoded credentials" in IDEAS.md). |

## Dependencies

- **No hard dependencies** on other IDEAS.md items. All required infrastructure (Postgres, MinIO) already exists.
- **Beneficial**: "Separate out the Postgres container into a new stack" — if Postgres has a persistent volume, backups protect against corruption rather than just pod restarts. Step 7 above adds the volume.
- **Beneficial**: "Use Postgres for Airflow metadata" — if implemented, the single `pg_dump` of `appdb` would NOT capture Airflow data (which would be in a separate `airflow` database). The backup script should be extended to dump both databases, or use `pg_dumpall`.

## Estimated Complexity

**Small** — The scripts are straightforward shell wrapping around `pg_dump`/`pg_restore` and `mc mirror`. The CI workflow is a standard GitHub Actions job. The main effort is in testing the restore procedure thoroughly and documenting the post-restore Debezium recovery steps.

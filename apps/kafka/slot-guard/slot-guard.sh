#!/bin/sh
set -e

PGHOST="${PGHOST:-host.containers.internal}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-appuser}"
PGDATABASE="${PGDATABASE:-appdb}"
export PGPASSWORD="${PGPASSWORD:-apppassword}"

# 5 GB default threshold
LAG_THRESHOLD_BYTES="${LAG_THRESHOLD_BYTES:-5368709120}"
# 15 minutes default check interval
CHECK_INTERVAL="${CHECK_INTERVAL:-900}"

echo "Slot guard started. Checking every ${CHECK_INTERVAL}s for slots with lag > ${LAG_THRESHOLD_BYTES} bytes."

# Wait for Postgres to be reachable before entering main loop
i=0
until pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "ERROR: Postgres not reachable after 5 minutes"
    exit 1
  fi
  echo "Waiting for Postgres..."
  sleep 5
done

while true; do
  echo "$(date -Iseconds) Checking replication slots..."

  # Log current slot status
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c \
    "SELECT slot_name, active,
            pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag
     FROM pg_replication_slots;" 2>/dev/null || {
    echo "$(date -Iseconds) WARNING: Could not query replication slots"
    sleep "$CHECK_INTERVAL"
    continue
  }

  # Drop stale slots exceeding threshold (safety net)
  DROPPED=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -t -A -c \
    "SELECT pg_drop_replication_slot(slot_name)
     FROM pg_replication_slots
     WHERE active = false
       AND pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) > ${LAG_THRESHOLD_BYTES}
       AND slot_name LIKE 'debezium_%';" 2>/dev/null) || true

  if [ -n "$DROPPED" ]; then
    echo "$(date -Iseconds) WARNING: Dropped stale replication slots: $DROPPED"
  fi

  sleep "$CHECK_INTERVAL"
done

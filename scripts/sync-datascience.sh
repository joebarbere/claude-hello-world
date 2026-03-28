#!/usr/bin/env bash
# sync-datascience.sh
# ===================
# Copy source-controlled data science files into the host paths that
# the datascience Podman pod mounts via hostPath volumes.
#
# Run this script once after cloning the repo, and again after any
# changes to DAGs, notebooks, or shared helpers.
#
# Usage
# -----
#   bash scripts/sync-datascience.sh
#   # or from the repo root with npm:
#   npm exec nx run datascience:sync-files
#
# What gets copied
# ----------------
#   apps/datascience/airflow/dags/  → /tmp/datascience/airflow/dags/
#   apps/datascience/shared/        → /tmp/datascience/shared/
#   apps/datascience/jupyter/notebooks/ → /tmp/datascience/jupyter/notebooks/

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "Repo root: ${REPO_ROOT}"

# ---------------------------------------------------------------------------
# Create host directories
# ---------------------------------------------------------------------------
mkdir -p /tmp/datascience/airflow/dags
mkdir -p /tmp/datascience/shared
mkdir -p /tmp/datascience/jupyter/work
mkdir -p /tmp/datascience/jupyter/notebooks
mkdir -p /tmp/datascience/minio/data
# All host-mounted volumes need the container_file_t SELinux label so that
# containers can access them (Fedora/RHEL enforce this by default).
if command -v chcon &>/dev/null; then
  chcon -R -t container_file_t -l s0 /tmp/datascience
fi

# ---------------------------------------------------------------------------
# Sync DAGs
# ---------------------------------------------------------------------------
echo "Syncing DAGs..."
cp -r "${REPO_ROOT}/apps/datascience/airflow/dags/." /tmp/datascience/airflow/dags/
echo "  DAGs → /tmp/datascience/airflow/dags/"

# ---------------------------------------------------------------------------
# Sync shared Python helpers
# ---------------------------------------------------------------------------
echo "Syncing shared helpers..."
cp -r "${REPO_ROOT}/apps/datascience/shared/." /tmp/datascience/shared/
echo "  Shared → /tmp/datascience/shared/"

# ---------------------------------------------------------------------------
# Sync notebooks
# ---------------------------------------------------------------------------
echo "Syncing notebooks..."
cp -r "${REPO_ROOT}/apps/datascience/jupyter/notebooks/." /tmp/datascience/jupyter/notebooks/
echo "  Notebooks → /tmp/datascience/jupyter/notebooks/"

# ---------------------------------------------------------------------------
# Fix permissions for rootless Podman UID namespace remapping.
# Host UID 1000 maps to UID 0 (root) inside the container, but Airflow
# runs as UID 50000 and Jupyter as UID 1000 (jovyan).  Making files
# world-readable lets any container UID read them.
# ---------------------------------------------------------------------------
echo "Fixing permissions for rootless Podman..."
chmod -R a+rX /tmp/datascience/airflow/dags
chmod -R a+rX /tmp/datascience/shared
chmod -R a+rX /tmp/datascience/jupyter/work
chmod -R a+rX /tmp/datascience/jupyter/notebooks

echo ""
echo "Sync complete. Contents:"
echo ""
echo "  DAGs:"
ls /tmp/datascience/airflow/dags/ | sed 's/^/    /'
echo ""
echo "  Shared:"
ls /tmp/datascience/shared/ | sed 's/^/    /'
echo ""
echo "  Notebooks:"
ls /tmp/datascience/jupyter/notebooks/ | sed 's/^/    /'

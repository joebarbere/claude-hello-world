# Vulnerability Report: k8s/datascience-pod.yaml

## CRITICAL: Jupyter Notebook Running with No Authentication — Unauthenticated RCE

**CWE:** CWE-306 — Missing Authentication for Critical Function

**Description:**
Jupyter is launched with `--ServerApp.token=''` and `--ServerApp.password=''` with `allow_remote_access=true`. Port 8888 is exposed as `hostPort: 8888`, bypassing Traefik's `kratos-auth` middleware.

**Exploitation Steps:**
1. Access `http://<target>:8888/jupyter/lab` — no token prompt.
2. Execute arbitrary Python/shell commands as `jovyan` user.
3. Access mounted host volumes at `/tmp/datascience/`.
4. Pivot to internal services (Kratos admin API, PostgreSQL, Kafka, MinIO).

**Impact:** Unauthenticated remote code execution. Full access to mounted host directories. Network pivot to all internal services.

---

## CRITICAL: Hardcoded Airflow Admin Credentials (admin/admin) + Forgeable Session Key

**CWE:** CWE-798 — Use of Hard-coded Credentials

**Description:**
Airflow is seeded with `admin/admin` credentials. `AIRFLOW__WEBSERVER__SECRET_KEY` is hardcoded as `datascience-dev-key`, enabling Flask session cookie forgery. Airflow is on `hostPort: 8280`, bypassing Traefik.

**Exploitation Steps:**
1. Access `http://<target>:8280/airflow/login`, log in with `admin/admin`.
2. Create a DAG with `BashOperator` for arbitrary code execution.
3. Alternatively, forge session cookies using the known secret key.

**Impact:** Full Airflow admin access, arbitrary code execution via DAGs, credential harvesting from Airflow Connections.

---

## CRITICAL: DAG Directory on World-Writable /tmp hostPath — DAG Injection

**CWE:** CWE-732, CWE-829

**Description:**
Airflow DAGs are mounted from `/tmp/datascience/airflow/dags` — a world-writable path. Jupyter shares the same volume. No DAG signing or integrity verification exists.

**Exploitation Steps:**
1. Write a malicious `.py` file to `/tmp/datascience/airflow/dags/` (via Jupyter, host access, or any container with the mount).
2. Airflow scheduler auto-imports and executes it.

**Impact:** RCE in the Airflow container. Access to MinIO, Kafka, PostgreSQL credentials via environment variables.

---

## CRITICAL: Hardcoded MinIO Root Credentials (minioadmin/minioadmin)

**CWE:** CWE-798, CWE-319

**Description:**
MinIO uses default `minioadmin/minioadmin` credentials. Console on `hostPort: 9001` and S3 API on `hostPort: 9000` bypass Traefik. `MINIO_PROMETHEUS_AUTH_TYPE: public` disables metric auth.

**Exploitation Steps:**
1. Access MinIO Console at `http://<target>:9001`, login with `minioadmin/minioadmin`.
2. Browse/download all weather data buckets.
3. Upload malicious DAGs or notebooks via shared buckets.

**Impact:** Full object storage access. Data exfiltration, corruption, and lateral movement.

---

## MEDIUM: No Pod-Level Security Context

**CWE:** CWE-250

**Description:**
No `securityContext` defined. Containers run as root with full capabilities, writable root filesystem, and `allowPrivilegeEscalation` not disabled.

**Remediation:** Add `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities: drop: ["ALL"]`.

# Vulnerability Report: apps/datascience/airflow/entrypoint.sh

## HIGH: Hardcoded Default Airflow Admin Password

**CWE:** CWE-259

**Description:**
Default password is `admin`: `--password "${_AIRFLOW_WWW_USER_PASSWORD:-admin}"`. If the env var is not set, a superuser account is created with `admin/admin`.

**Exploitation Steps:**
1. Navigate to `http://localhost:8280/airflow/login`.
2. Login with `admin/admin`.
3. Execute arbitrary code via DAGs, access Connections credentials.

**Remediation:** Fail fast if password env var is unset: `${_AIRFLOW_WWW_USER_PASSWORD:?must be set}`

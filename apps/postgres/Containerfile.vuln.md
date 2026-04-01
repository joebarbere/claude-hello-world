# Vulnerability Report: apps/postgres/Containerfile

## HIGH: PostgreSQL Credentials Baked into Image Layer via ENV

**CWE:** CWE-798, CWE-312

**Description:**
`ENV POSTGRES_PASSWORD=apppassword` persists in every image layer and registry. Extractable via `podman inspect`.

**Remediation:** Remove ENV. Use `POSTGRES_PASSWORD_FILE` with secret mount at runtime.

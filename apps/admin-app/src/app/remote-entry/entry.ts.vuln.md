# Vulnerability Report: apps/admin-app/src/app/remote-entry/entry.ts

## HIGH: Credentials Field Wired into DOM Rendering

**CWE:** CWE-312 — Cleartext Storage of Sensitive Information

**Description:**
`AdminLink` interface defines a `credentials` field rendered as plaintext HTML. While no credentials are currently populated, the pipeline is fully wired. Any developer who adds credentials to `ADMIN_LINKS` exposes them in the JS bundle and HTML source.

**Impact:** Credential exposure for internal services (Airflow, MinIO, Jupyter) readable in static JS assets without authentication.

---

## MEDIUM: Internal Service URLs Leaked in JavaScript Bundle

**CWE:** CWE-200

**Description:**
`ADMIN_LINKS` hardcodes `http://localhost:5221` (Weather API) and `http://localhost:8081` (Traefik dashboard). These are compiled into the MFE JS bundle, revealing internal service topology to any user who fetches the chunk.

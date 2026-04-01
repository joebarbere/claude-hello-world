# Vulnerability Report: traefik/traefik.yml

## HIGH: Traefik Dashboard Exposed in Insecure Mode

**CWE:** CWE-306 — Missing Authentication for Critical Function

**Description:**
```yaml
api:
  dashboard: true
  insecure: true
```
Dashboard on port 8081 exposes all routing rules, middleware chains, TLS certificate paths, backend service URLs, and Prometheus metrics without authentication.

**Exploitation Steps:**
1. `http://<target>:8081/dashboard/` — full infrastructure map.
2. `/api/http/routers` — enumerate all routes and find unprotected ones.
3. `/metrics` — request counts, error rates, latency by route.

**Impact:** Complete infrastructure topology disclosure.

**Remediation:** Remove `insecure: true`. Add basicAuth middleware. Bind to `127.0.0.1:8081`.

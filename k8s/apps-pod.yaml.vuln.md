# Vulnerability Report: k8s/apps-pod.yaml

## HIGH: Traefik Dashboard Exposed Without Authentication on hostPort 8081

**CWE:** CWE-306 — Missing Authentication for Critical Function

**Description:**
Traefik API dashboard enabled with `insecure: true` on port 8081 (published as hostPort). Exposes all routers, services, middleware definitions, TLS certificate paths, backend URLs, and Prometheus metrics.

**Exploitation Steps:**
1. Access `http://<target>:8081/dashboard/` — no credentials required.
2. Read all router definitions to find unprotected routes.
3. Discover internal service hostnames and ports.
4. Access `/metrics` for detailed performance data.

**Impact:** Complete infrastructure map disclosure. Middleware configuration reveals auth bypass vectors.

**Remediation:** Remove `insecure: true`. Add HTTP Basic Auth. Bind to `127.0.0.1:8081` only.

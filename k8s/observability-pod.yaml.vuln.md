# Vulnerability Report: k8s/observability-pod.yaml

## HIGH: Grafana Auth-Proxy Auto-Provisions All Users as Admin

**CWE:** CWE-269 — Improper Privilege Management

**Description:**
`GF_AUTH_PROXY_AUTO_SIGN_UP_ORG_ROLE: "Admin"` — every Kratos-authenticated user becomes Grafana Admin with full dashboard, datasource, and alerting control.

**Impact:** All Kratos users get Grafana Admin. Full access to all observability data. Can silence security alerts.

---

## HIGH: Podman Socket Exposed Over Unauthenticated TCP — Container Escape

**CWE:** CWE-306

**Description:**
`CONTAINER_HOST: tcp://host.containers.internal:9999` — Podman API over TCP with no authentication. Any container reaching this endpoint has full container lifecycle management and can escape to host root.

---

## MEDIUM: Prometheus, Loki, Blackbox Exporter Exposed Without Auth

**CWE:** CWE-306

**Description:** Prometheus (`hostPort: 9090`), Loki (`hostPort: 3100`, `auth_enabled: false`), Blackbox Exporter (`hostPort: 9115`) — all unauthenticated. Loki accepts log injection. Blackbox provides SSRF.

---

## MEDIUM: Promtail Mounts /var/log and /var/lib/containers from Host

**CWE:** CWE-732

**Description:** Broad host directory mounts ship system auth logs and all container logs to Loki — readable by all users (everyone is Grafana Admin).

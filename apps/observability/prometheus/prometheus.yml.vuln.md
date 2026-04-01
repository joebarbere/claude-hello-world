# VULN-014: Prometheus, Loki, and Blackbox Exporter Exposed Without Authentication — Log Injection and SSRF

**Severity:** MEDIUM
**CWE:** CWE-306 — Missing Authentication for Critical Function / CWE-918 — Server-Side Request Forgery

## Description

Multiple observability components are published on direct host ports with no authentication and
no Traefik protection:

| Component | hostPort | Unauthenticated Capability |
|-----------|----------|---------------------------|
| Prometheus | 9090 | Full query API, target list, config dump |
| Loki | 3100 | Log push and query API |
| Blackbox Exporter | 9115 | HTTP/TCP probe of arbitrary targets |
| Nginx Exporter | 9113 | nginx metrics |
| Podman Exporter | 9882 | All container metrics |
| Postgres Exporter | 9187 | PostgreSQL metrics |
| Debezium | 9404 | Kafka Connect metrics |

Loki is configured with `auth_enabled: false` in `apps/observability/loki/loki.yml`, meaning its
push API (`POST /loki/api/v1/push`) accepts log streams from any source without credentials.

The Blackbox Exporter accepts a `target` query parameter that instructs it to probe an arbitrary
URL, creating a classic SSRF vector.

The `prometheus.yml` scrape job for `kratos` scrapes the Kratos admin metrics endpoint:

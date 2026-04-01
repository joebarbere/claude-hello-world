# Vulnerability Index

Security audit of the claude-hello-world project. **63 vulnerabilities** identified across 45 files. **14 exploit PoCs** confirmed and documented in [`exploits/`](exploits/).

## Verification Summary

Each reported vulnerability was verified against the actual source code. Results:

| Status | Count | Description |
|--------|-------|-------------|
| **Confirmed Exploitable** | 42 | Vulnerability verified in source; exploit scenario validated |
| **Partially Exploitable** | 9 | Requires specific conditions (e.g., env var control, network position) |
| **Not Exploitable** | 7 | Mitigated by runtime, misidentified, or dead code path |
| **Informational** | 5 | Real pattern but no direct exploit path |

## Attack Chain Summary (CTF Quick Start)

The highest-impact attack chain:
1. Read `apps/ory/init-users.sh` for credentials → login as `admin@example.com` / `Admin1234!`
2. OR: Forge a session cookie using the known Kratos secret `CHANGE-ME-COOKIE-SECRET-32-CHARS!!` from `apps/ory/kratos.yml`
3. OR: Hit the unauthenticated Kratos Admin API on port 4434 to create your own admin identity
4. OR: Access Jupyter (port 8888, no auth) for RCE → write malicious DAG to `/tmp/datascience/airflow/dags/` → Airflow executes it
5. Pivot to Podman TCP socket (`host.containers.internal:9999`) for container escape to host root

---

## CRITICAL (9 findings)

| File | Report | Description | Verified | Exploit |
|------|--------|-------------|----------|---------|
| `apps/ory/kratos.yml` | [Report](apps/ory/kratos.yml.vuln.md) | Hardcoded cookie/cipher secrets — session forgery possible | YES | [01-kratos-session-forgery.py](exploits/01-kratos-session-forgery.py) |
| `k8s/ory-kratos-pod.yaml` | [Report](k8s/ory-kratos-pod.yaml.vuln.md) | Kratos Admin API exposed without auth on hostPort 4434 | YES | [02-kratos-admin-api-takeover.sh](exploits/02-kratos-admin-api-takeover.sh) |
| `k8s/postgres-pod.yaml` | [Report](k8s/postgres-pod.yaml.vuln.md) | Hardcoded DB credentials across all pod manifests | YES | [09-credential-harvest.sh](exploits/09-credential-harvest.sh) |
| `k8s/datascience-pod.yaml` | [Report](k8s/datascience-pod.yaml.vuln.md) | Jupyter no-auth RCE, Airflow admin/admin, DAG injection via /tmp, MinIO minioadmin/minioadmin | YES | [03-jupyter-rce.sh](exploits/03-jupyter-rce.sh), [07-dag-injection.py](exploits/07-dag-injection.py) |
| `apps/datascience/airflow/webserver_config.py` | [Report](apps/datascience/airflow/webserver_config.py.vuln.md) | All Kratos users auto-promoted to Airflow Admin (logic error) | YES | [04-airflow-header-spoofing.sh](exploits/04-airflow-header-spoofing.sh) |
| `apps/datascience/airflow/plugins/proxy_auth.py` | [Report](apps/datascience/airflow/plugins/proxy_auth.py.vuln.md) | X-Webauth-User header spoofing → Airflow Admin takeover | YES | [04-airflow-header-spoofing.sh](exploits/04-airflow-header-spoofing.sh) |
| `apps/datascience/shared/minio_helper.py` | [Report](apps/datascience/shared/minio_helper.py.vuln.md) | Hardcoded MinIO root credentials + plaintext HTTP | YES | [09-credential-harvest.sh](exploits/09-credential-harvest.sh) |

## HIGH (24 findings)

| File | Report | Description | Verified | Exploit |
|------|--------|-------------|----------|---------|
| `apps/weather-api/Middleware/KratosAuthMiddleware.cs` | [Report](apps/weather-api/Middleware/KratosAuthMiddleware.cs.vuln.md) | Unauthenticated read access to all endpoints; cookie header injection (CRLF) | PARTIAL — CRLF mitigated by .NET 6+ Kestrel | — |
| `apps/weather-api/Program.cs` | [Report](apps/weather-api/Program.cs.vuln.md) | SSRF via /signup, account enumeration oracle, Kratos error disclosure, mass assignment | NO (not SSRF) — real issue is unauthenticated identity creation | — |
| `apps/weather-api/appsettings.json` | [Report](apps/weather-api/appsettings.json.vuln.md) | Hardcoded database credentials in committed config | YES | [09-credential-harvest.sh](exploits/09-credential-harvest.sh) |
| `apps/ory/init-users.sh` | [Report](apps/ory/init-users.sh.vuln.md) | Hardcoded demo admin credentials; unauthenticated Kratos Admin API | YES | [09-credential-harvest.sh](exploits/09-credential-harvest.sh) |
| `apps/kafka/debezium-init/register-connector.sh` | [Report](apps/kafka/debezium-init/register-connector.sh.vuln.md) | Hardcoded DB credentials in connector JSON | YES | [06-kafka-data-exfil.sh](exploits/06-kafka-data-exfil.sh) |
| `apps/kafka/slot-guard/slot-guard.sh` | [Report](apps/kafka/slot-guard/slot-guard.sh.vuln.md) | Hardcoded DB password; SQL injection via LAG_THRESHOLD_BYTES | YES (password); PARTIAL (SQLi requires env var control) | [08-slot-guard-sqli.sh](exploits/08-slot-guard-sqli.sh) |
| `apps/datascience/airflow/entrypoint.sh` | [Report](apps/datascience/airflow/entrypoint.sh.vuln.md) | Default Airflow admin password `admin` | YES | [09-credential-harvest.sh](exploits/09-credential-harvest.sh) |
| `k8s/kafka-pod.yaml` | [Report](k8s/kafka-pod.yaml.vuln.md) | Entire Kafka stack unauthenticated/plaintext; DB creds in env; JMX wildcard export | YES | [06-kafka-data-exfil.sh](exploits/06-kafka-data-exfil.sh), [13-jmx-secret-leak.sh](exploits/13-jmx-secret-leak.sh) |
| `k8s/observability-pod.yaml` | [Report](k8s/observability-pod.yaml.vuln.md) | Grafana all-users-Admin; Podman socket unauthenticated TCP (container escape) | YES (Grafana); PARTIAL (Podman — depends on host config) | [11-grafana-privilege-escalation.sh](exploits/11-grafana-privilege-escalation.sh), [10-podman-socket-escape.sh](exploits/10-podman-socket-escape.sh) |
| `k8s/apps-pod.yaml` | [Report](k8s/apps-pod.yaml.vuln.md) | Traefik dashboard exposed insecure on hostPort 8081 | YES | [12-traefik-infra-recon.sh](exploits/12-traefik-infra-recon.sh) |
| `traefik/traefik.yml` | [Report](traefik/traefik.yml.vuln.md) | Traefik dashboard insecure mode — full infra map disclosure | YES | [12-traefik-infra-recon.sh](exploits/12-traefik-infra-recon.sh) |
| `traefik/traefik-dynamic.yml` | [Report](traefik/traefik-dynamic.yml.vuln.md) | Kafka UI exposed without auth; Kratos admin route missing auth | YES | [06-kafka-data-exfil.sh](exploits/06-kafka-data-exfil.sh), [02-kratos-admin-api-takeover.sh](exploits/02-kratos-admin-api-takeover.sh) |
| `traefik/Containerfile` | [Report](traefik/Containerfile.vuln.md) | TLS private key baked into container image layer | YES | [09-credential-harvest.sh](exploits/09-credential-harvest.sh) |
| `ssl/localhost.key` | [Report](ssl/localhost.key.vuln.md) | TLS private key committed to version control | YES | [09-credential-harvest.sh](exploits/09-credential-harvest.sh) |
| `apps/observability/auth-proxy/auth-proxy.py` | [Report](apps/observability/auth-proxy/auth-proxy.py.vuln.md) | Open redirect; unauthenticated MinIO session minting; MinIO root creds shared with all users | YES (MinIO session minting) | [05-minio-session-minting.sh](exploits/05-minio-session-minting.sh) |
| `apps/postgres/Containerfile` | [Report](apps/postgres/Containerfile.vuln.md) | PostgreSQL credentials baked into image layer via ENV | YES | [09-credential-harvest.sh](exploits/09-credential-harvest.sh) |
| `apps/kafka/debezium/jmx-exporter-config.yml` | [Report](apps/kafka/debezium/jmx-exporter-config.yml.vuln.md) | Wildcard JMX export leaks connector secrets | YES | [13-jmx-secret-leak.sh](exploits/13-jmx-secret-leak.sh) |
| `apps/admin-app/src/app/remote-entry/entry.ts` | [Report](apps/admin-app/src/app/remote-entry/entry.ts.vuln.md) | Credentials field wired into DOM rendering pipeline | PARTIAL — pattern present but no data currently populates it | — |
| `apps/admin-app/src/app/kratos-admin/kratos-admin.service.ts` | [Report](apps/admin-app/src/app/kratos-admin/kratos-admin.service.ts.vuln.md) | Kratos Admin API callable from browser — full account takeover via recovery link | YES | [02-kratos-admin-api-takeover.sh](exploits/02-kratos-admin-api-takeover.sh) |
| `apps/shell/src/app/auth/auth.service.ts` | [Report](apps/shell/src/app/auth/auth.service.ts.vuln.md) | Open redirect via unvalidated return_to parameter | PARTIAL — Kratos allowlist mitigates; logout_url trusts API response | — |
| `apps/shell/src/app/auth/auth.guard.ts` | [Report](apps/shell/src/app/auth/auth.guard.ts.vuln.md) | Auth guards client-side only; multiple routes unguarded | YES — but backend auth covers write ops | — |

## MEDIUM (23 findings)

| File | Report | Description | Verified | Exploit |
|------|--------|-------------|----------|---------|
| `apps/weather-api/Containerfile` | [Report](apps/weather-api/Containerfile.vuln.md) | Container runs as root; no read-only filesystem | YES | — |
| `apps/weather-api/Middleware/KratosAuthMiddleware.cs` | [Report](apps/weather-api/Middleware/KratosAuthMiddleware.cs.vuln.md) | HttpClient per request (socket exhaustion DoS); /signup bypass too broad | YES | — |
| `apps/weather-api/Program.cs` | [Report](apps/weather-api/Program.cs.vuln.md) | No CORS policy; mass assignment | YES (no CORS); PARTIAL (mass assignment depends on EF Core config) | — |
| `apps/ory/kratos.yml` | [Report](apps/ory/kratos.yml.vuln.md) | SMTP skip_ssl_verify; CORS allows HTTP; weak bcrypt cost | YES | — |
| `apps/ory/init-users.sh` | [Report](apps/ory/init-users.sh.vuln.md) | Shell/JSON injection pattern | NO — all values are hardcoded literals, no external input | — |
| `apps/kafka/debezium-init/register-connector.sh` | [Report](apps/kafka/debezium-init/register-connector.sh.vuln.md) | Unauthenticated Kafka Connect REST API | YES | [06-kafka-data-exfil.sh](exploits/06-kafka-data-exfil.sh) |
| `apps/kafka/slot-guard/slot-guard.sh` | [Report](apps/kafka/slot-guard/slot-guard.sh.vuln.md) | SQL injection via LAG_THRESHOLD_BYTES | PARTIAL — requires env var control | [08-slot-guard-sqli.sh](exploits/08-slot-guard-sqli.sh) |
| `apps/observability/auth-proxy/auth-proxy.py` | [Report](apps/observability/auth-proxy/auth-proxy.py.vuln.md) | SSL verification disabled globally | YES — but dead code path (all internal calls use HTTP) | — |
| `k8s/observability-pod.yaml` | [Report](k8s/observability-pod.yaml.vuln.md) | Prometheus/Loki/Blackbox unauthenticated; Promtail mounts /var/log | YES | — |
| `k8s/datascience-pod.yaml` | [Report](k8s/datascience-pod.yaml.vuln.md) | No pod security context; MinIO public metrics | YES | — |
| `.github/workflows/dependency-check.yml` | [Report](.github/workflows/dependency-check.yml.vuln.md) | Third-party action pinned to @main — supply chain risk | YES | [14-supply-chain-action.md](exploits/14-supply-chain-action.md) |
| `.github/workflows/claude.yml` | [Report](.github/workflows/claude.yml.vuln.md) | Claude Code triggerable by any GitHub user | YES | [14-supply-chain-action.md](exploits/14-supply-chain-action.md) |
| `apps/shell/src/app/auth/auth.service.ts` | [Report](apps/shell/src/app/auth/auth.service.ts.vuln.md) | Open redirect via unvalidated logout_url | PARTIAL — trusts Kratos API response | — |
| `apps/shell/src/app/auth/login/login.component.ts` | [Report](apps/shell/src/app/auth/login/login.component.ts.vuln.md) | Form action from server response without origin validation | NO — standard Kratos browser flow with CSRF token | — |
| `apps/shell/src/app/app.config.ts` | [Report](apps/shell/src/app/app.config.ts.vuln.md) | No CSRF interceptor on HttpClient | PARTIAL — SameSite cookies + CORS partially mitigate | — |
| `apps/weatherstream-app/src/app/services/kafka-stream.service.ts` | [Report](apps/weatherstream-app/src/app/services/kafka-stream.service.ts.vuln.md) | window.electronKafka API exposed to any script | NO — TypeScript type declaration only, no runtime object created | — |
| `apps/admin-app/src/app/minions/minions.component.ts` | [Report](apps/admin-app/src/app/minions/minions.component.ts.vuln.md) | No cron expression validation | YES — client-side gap, depends on backend validation | — |
| `apps/admin-app/src/app/remote-entry/entry.ts` | [Report](apps/admin-app/src/app/remote-entry/entry.ts.vuln.md) | Internal service URLs leaked in JS bundle | YES — localhost URLs in bundle | — |
| `apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py` | [Report](apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py.vuln.md) | Unvalidated JSON deserialization via XCom path | NO — Python json.load is safe; path traversal requires prior Airflow compromise | — |
| `apps/datascience/shared/weather_sources.py` | [Report](apps/datascience/shared/weather_sources.py.vuln.md) | External downloads without integrity verification | YES | — |
| `apps/kafka/debezium/Containerfile` | [Report](apps/kafka/debezium/Containerfile.vuln.md) | JMX exporter JAR fetched without checksum | YES | — |
| `apps/datascience/jupyter/Containerfile` | [Report](apps/datascience/jupyter/Containerfile.vuln.md) | pip as root; floating :latest base image | PARTIAL — :latest confirmed; pip-as-root is standard Jupyter pattern | — |

## LOW (7 findings)

| File | Report | Description | Verified | Exploit |
|------|--------|-------------|----------|---------|
| `nginx/nginx.conf` | [Report](nginx/nginx.conf.vuln.md) | stub_status publicly accessible | YES — no allow/deny directive | — |
| `apps/admin-app/src/app/kratos-admin/kratos-admin.component.ts` | [Report](apps/admin-app/src/app/kratos-admin/kratos-admin.component.ts.vuln.md) | Error messages leak internals; magic link in plaintext input | NO — Angular HttpErrorResponse is generic, no internal details leaked | — |
| `apps/weather-api/Program.cs` | [Report](apps/weather-api/Program.cs.vuln.md) | No rate limit on minion schedules (DB flood) | YES | — |
| `apps/weather-api/Containerfile` | [Report](apps/weather-api/Containerfile.vuln.md) | No read-only filesystem or capability drops | YES | — |
| `ssl/generate-cert-*.sh` | — | Weak cert params: RSA-2048, 10-year validity | PARTIAL — RSA-2048 acceptable through 2030; 10-year validity excessive | — |
| `apps/observability/grafana/Containerfile` | [Report](apps/observability/grafana/Containerfile.vuln.md) | Floating :latest tags across multiple images | YES | — |
| `.github/workflows/eks-e2e.yml` | [Report](.github/workflows/eks-e2e.yml.vuln.md) | Confirms unauthenticated API surface in CI | YES — documents the issue, doesn't introduce it | — |

---

## Not Exploitable (False Positives / Mitigated)

The following reported vulnerabilities were found to be **not exploitable** after source code verification:

| File | Reported Issue | Reason Not Exploitable |
|------|----------------|----------------------|
| `apps/weather-api/Program.cs` | SSRF via /signup | Not SSRF — URL is from config, not user input. Real issue is unauthenticated identity creation. |
| `apps/weather-api/Middleware/KratosAuthMiddleware.cs` | CRLF injection | Mitigated by .NET 6+ Kestrel HTTP parser + HttpClient header validation |
| `apps/ory/init-users.sh` | Shell/JSON injection | All function arguments are hardcoded string literals — no external input path |
| `apps/weatherstream-app/src/app/services/kafka-stream.service.ts` | window.electronKafka exposed | TypeScript type declaration only — no runtime object created without Electron preload |
| `apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py` | Unsafe JSON deserialization | Python `json.load` is safe — no pickle/yaml.load/jsonpickle. Path traversal requires prior Airflow compromise. |
| `apps/shell/src/app/auth/login/login.component.ts` | Form action without origin validation | Standard Ory Kratos browser flow with embedded CSRF token |
| `apps/admin-app/src/app/kratos-admin/kratos-admin.component.ts` | Error message information leak | Angular HttpErrorResponse surfaces generic browser-level errors, not internal details |

---

## CWE Coverage

| CWE | Count | Description |
|-----|-------|-------------|
| CWE-798/259/321/312 | 15 | Hardcoded credentials / cleartext storage |
| CWE-306 | 10 | Missing authentication for critical function |
| CWE-269/272 | 4 | Improper privilege management |
| CWE-601 | 3 | Open redirect |
| CWE-200/209 | 4 | Information disclosure |
| CWE-862/602 | 3 | Missing/client-side-only authorization |
| CWE-494 | 3 | Download without integrity check |
| CWE-295 | 3 | Improper certificate validation |
| CWE-250 | 3 | Execution with unnecessary privileges |
| CWE-113/78/89 | 3 | Injection (CRLF, shell, SQL) |
| CWE-918 | 1 | SSRF |
| CWE-352 | 1 | CSRF |
| CWE-942 | 2 | Permissive CORS |
| CWE-Other | 8 | Various (CWE-400, 706, 749, 829, etc.) |

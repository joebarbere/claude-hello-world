# claude-hello-world

[![CI](https://github.com/joebarbere/claude-hello-world/actions/workflows/ci.yml/badge.svg)](https://github.com/joebarbere/claude-hello-world/actions/workflows/ci.yml)
[![EKS E2E Tests](https://github.com/joebarbere/claude-hello-world/actions/workflows/eks-e2e.yml/badge.svg)](https://github.com/joebarbere/claude-hello-world/actions/workflows/eks-e2e.yml)
[![OWASP Dependency-Check](https://github.com/joebarbere/claude-hello-world/actions/workflows/dependency-check.yml/badge.svg)](https://github.com/joebarbere/claude-hello-world/actions/workflows/dependency-check.yml)
[![CodeQL](https://github.com/joebarbere/claude-hello-world/actions/workflows/codeql.yml/badge.svg)](https://github.com/joebarbere/claude-hello-world/actions/workflows/codeql.yml)
[![Dependabot enabled](https://img.shields.io/badge/dependabot-enabled-blue?logo=dependabot)](https://github.com/joebarbere/claude-hello-world/blob/main/.github/dependabot.yml)

> **This project is for learning [Claude Code](https://claude.ai/code) only. It is not intended for production use.**

---

## Security Disclaimer

**DO NOT deploy this project to any internet-facing or shared environment.** It contains numerous intentional shortcuts that are insecure by design. The following issues exist in the codebase as shipped:

### Hardcoded secrets in source control

- **Kratos cookie and cipher secrets** (`apps/ory/kratos.yml`) are placeholder strings committed to the repository:
  ```yaml
  secrets:
    cookie:
      - CHANGE-ME-COOKIE-SECRET-32-CHARS!!
    cipher:
      - CHANGE-ME-CIPHER-SECRET-32-CHARS
  ```
  Anyone with read access to this repo can forge or decrypt Kratos session cookies.

- **PostgreSQL credentials** are hardcoded in `k8s/postgres-pod.yaml` and `k8s/ory-kratos-pod.yaml` (`appuser` / `apppassword`) and exposed as plaintext environment variables in the pod spec. They are also hardcoded in the `ConnectionStrings__DefaultConnection` passed to the weather-api container.

- **Default application user passwords** are hardcoded in `apps/ory/init-users.sh` and seeded on every fresh deployment:
  | Email | Password |
  |-------|----------|
  | `admin@example.com` | `Admin1234!` |
  | `weatheradmin@example.com` | `WeatherAdmin1234!` |

### TLS private key committed to the repository

- `ssl/localhost.key` — a private RSA key — is checked into source control. Any party with access to this repository can perform TLS interception or impersonation against any deployment using this certificate.

### Unauthenticated admin API exposed

- The **Ory Kratos admin API** (port `4434`) is bound to the host with no authentication, no network policy, and no firewall rule (`hostPort: 4434` in `k8s/ory-kratos-pod.yaml`). Anyone who can reach this port can create, modify, or delete identities without credentials.

### No Kubernetes Secrets — credentials in pod spec env vars

- All secrets (DB password, connection strings) are passed as plaintext `env` values directly in the pod spec files (`k8s/postgres-pod.yaml`, `k8s/ory-kratos-pod.yaml`, `k8s/apps-pod.yaml`) rather than Kubernetes `Secret` objects. They appear in `kubectl describe pod` output and are visible to any user with read access to the cluster or the repo.

### Self-signed TLS certificate

- The self-signed certificate in `ssl/localhost.crt` is not issued by any trusted CA. Browsers will reject it unless users manually install and trust it. No certificate rotation or expiry monitoring is in place.

### Plaintext credentials in Kratos DSN

- Kratos is configured with a PostgreSQL DSN that contains the database username and password in plaintext (`apps/ory/kratos.yml`). The connection string is committed to source control and visible to anyone with repo access.

### No rate limiting or brute-force protection on the login endpoint

- Traefik does not apply any rate limiting to `/.ory/kratos/public/`. The Kratos login flow has no lockout policy configured, making credential stuffing and brute-force attacks trivial.

### Kratos CORS allows all configured origins unconditionally

- The CORS `allowed_origins` list in `kratos.yml` includes development origins (`http://localhost:4200`) alongside production-style origins. Cross-origin requests from those origins are accepted for all methods including `POST`, `PUT`, `DELETE`, and `PATCH`.

### Client-side-only route guard for the Angular auth flow

- The Angular `weatherEditAuthGuard` is a client-side control. It can be bypassed by any user who modifies local state or disables JavaScript. The weather-api does enforce server-side session validation for write operations, but the Angular frontend itself is not a security boundary.

### No container image scanning

- Container images are built from base images (`node:20-alpine`, `nginx:alpine`, `traefik:v3.3-alpine`, `dotnet/sdk:9.0-alpine`, `postgres:17-alpine`, `oryd/kratos:v1.3.0-distroless`) with no CVE scanning, no image signing, and no dependency pinning beyond the tag.

---

An Nx monorepo demonstrating Angular Module Federation micro-frontends with a .NET 9 Weather API backend and PostgreSQL, all containerized with Podman and orchestrated via `podman play kube`. Traefik handles SSL termination and reverse proxying, while nginx serves the Angular static files. Authentication is handled by [Ory Kratos](https://www.ory.sh/kratos/).

## Architecture

```
Browser
  └── Shell (Angular MFE host, :4200 / :8443 HTTPS / :8080 HTTP→redirect)
        ├── weather-app (remote, :4201) — weather forecast table (public)
        ├── weatheredit-app (remote, :4202) — weather forecast CRUD (admin/weather_admin only)
        └── admin-app (remote, :4203) — admin UI (admin only)

Traefik (reverse proxy, :8080 → redirects to HTTPS, :8443 SSL termination)
  ├── /                        → nginx (static files) → shell app
  ├── /weather-app/            → nginx (static files) → weather-app remote
  ├── /weatheredit-app/        → nginx (static files) → weatheredit-app remote
  ├── /admin-app/              → nginx (static files) → admin-app remote
  ├── /weather                 → weather-api
  ├── /.ory/kratos/public/     → Ory Kratos public API (:4433)
  └── /.ory/kratos/admin/      → Ory Kratos admin API (:4434)

nginx (container, :8080 internal — static file server only)
  ├── /                        → shell app
  ├── /weather-app/            → weather-app remote
  ├── /weatheredit-app/        → weatheredit-app remote
  └── /admin-app/              → admin-app remote

weather-api (.NET 9, :5220 dev / :5221 container)
  ├── GET endpoints — public
  └── POST/PUT/DELETE endpoints — restricted to admin and weather_admin roles

Ory Kratos (identity, :4433 public / :4434 admin)
  └── PostgreSQL-backed user store with role-based access (seeded on start by ory-kratos-init)

PostgreSQL 17 (:5432)
Observability (separate pod, not started by kube-up shell)
  ├── Prometheus (:9090) — metrics scraping and storage
  ├── Loki (:3100) — log aggregation (tsdb/filesystem backend)
  ├── Promtail — log collection from pod/container logs, traefik & nginx access logs
  ├── Grafana (:3000 / https://localhost:8443/grafana/) — dashboards, SSO via Kratos
  └── auth-proxy (:4180) — Kratos session validation for Grafana forwardAuth
```

## Observability

The observability stack runs as a **separate pod** and is never started by `kube-up shell` or during e2e tests. It provides metrics, log aggregation, and dashboards for local development.

### Components

| Component | Port | Purpose |
|-----------|------|---------|
| Prometheus | 9090 | Scrapes metrics from weather-api, nginx-exporter, traefik, and itself |
| Loki | 3100 | Log storage (single-instance, filesystem backend) |
| Promtail | — | Collects CRI pod logs, Podman container logs, and Traefik/nginx access logs; ships to Loki |
| Grafana | 3000 | Dashboards and log exploration; served at `https://localhost:8443/grafana/` via Traefik |
| auth-proxy | 4180 | Validates Kratos sessions for Grafana SSO (Traefik forwardAuth middleware) |

### Metrics scraped by Prometheus

- `weather-api` — ASP.NET Core HTTP metrics via `prometheus-net` at `host.containers.internal:5221/metrics`
- `nginx` — connection stats via the `nginx-prometheus-exporter` sidecar at `host.containers.internal:9113`
- `traefik` — request counts, error rates, latency histograms at `host.containers.internal:8081/metrics`
- `prometheus` — self-scrape at `localhost:9090`

### Logs collected by Promtail

- `/var/log/pods/*/*/*.log` — CRI-format pod logs
- `/var/lib/containers/storage/overlay-containers/*/userdata/ctr.log` — raw Podman container logs
- `/var/log/traefik/access.log` — Traefik JSON access logs (client IP, User-Agent, status, route, service)
- `/var/log/nginx/access.log` — nginx JSON access logs (remote_addr, request, status, request_time)

### Grafana dashboards

Two pre-provisioned dashboards are available:

- **Weather API** — HTTP request rate, p99 latency, in-flight requests, process memory, nginx active connections
- **System Health** — system health %, running pods, container health table, HTTP request/error rates by service, top IP + User-Agent, recent error logs (status >= 400)

### Grafana SSO via Ory Kratos

Grafana is accessible at `https://localhost:8443/grafana/` with automatic SSO through Ory Kratos:

1. Traefik routes `/grafana` through a `forwardAuth` middleware to the auth-proxy
2. The auth-proxy reads the Kratos session cookie and calls `/sessions/whoami`
3. If valid, it returns `200` with `X-Webauth-User: <email>`; Traefik copies this header to the proxied request
4. If invalid, it redirects to the Kratos login page with `return_to` pointing back to Grafana
5. Grafana's `auth.proxy` trusts the `X-Webauth-User` header and auto-signs-up/logs in the user

> **macOS note:** Podman containers run inside a Linux VM. The `hostPath` volume mounts (`/var/log`, `/var/lib/containers`) refer to paths inside that VM, not the macOS host filesystem. Log collection works automatically when `kube-up shell` and `kube-up observability` are both running inside the same Podman Machine.

## Authentication

Access to the **weatheredit-app** and all **write operations** on the weather-api is restricted to users with `admin` or `weather_admin` roles, enforced by [Ory Kratos](https://www.ory.sh/kratos/).

### Default users

| User | Email | Password | Role |
|------|-------|----------|------|
| Admin | `admin@example.com` | `Admin1234!` | `admin` |
| Weather Admin | `weatheradmin@example.com` | `WeatherAdmin1234!` | `weather_admin` |

> **Note:** Change these credentials before deploying to any non-local environment.

### Auth flow

1. Navigate to `/weatheredit-app` — the Angular auth guard checks your Kratos session.
2. If unauthenticated, you are redirected to `/auth/login` which initiates a Kratos browser login flow.
3. After successful login, your session is set via a cookie and you are redirected back.
4. The weather-api independently validates the session cookie on every write request.

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 20+ |
| .NET SDK | 9.0 |
| Podman | any recent |
| OpenSSL | any recent (for cert regeneration only) |

```sh
npm install
```

## SSL / HTTPS

Traefik serves as the SSL termination reverse proxy using a self-signed certificate for `localhost`.
HTTP on port 8080 automatically redirects to HTTPS on port 8443. nginx serves only static Angular files behind Traefik.

The certificate and private key are pre-generated and stored in `ssl/`:

| File | Description |
|------|-------------|
| `ssl/localhost.crt` | Self-signed X.509 certificate (CN=localhost, valid 10 years) |
| `ssl/localhost.key` | RSA 2048 private key |
| `ssl/generate-cert-linux.sh` | Regenerate the cert on Linux |
| `ssl/generate-cert-macos.sh` | Regenerate the cert on macOS |
| `ssl/generate-cert-windows.ps1` | Regenerate the cert on Windows |
| `ssl/install-cert-linux.sh` | Trust the cert on Linux |
| `ssl/install-cert-macos.sh` | Trust the cert on macOS |
| `ssl/install-cert-windows.ps1` | Trust the cert on Windows |
| `ssl/uninstall-cert-linux.sh` | Remove the trusted cert on Linux |
| `ssl/uninstall-cert-macos.sh` | Remove the trusted cert on macOS |
| `ssl/uninstall-cert-windows.ps1` | Remove the trusted cert on Windows |

### Trust the certificate locally

Run the appropriate script for your OS to add the certificate to your system's trusted CA store. Browsers and other tools will then accept `https://localhost:8443` without warnings.

**Linux (Debian/Ubuntu or RHEL/Fedora):**
```sh
sudo ./ssl/install-cert-linux.sh
```

**macOS:**
```sh
./ssl/install-cert-macos.sh
```

**Windows (PowerShell as Administrator):**
```powershell
.\ssl\install-cert-windows.ps1
```

### Remove the trusted certificate

**Linux:**
```sh
sudo ./ssl/uninstall-cert-linux.sh
```

**macOS:**
```sh
./ssl/uninstall-cert-macos.sh
```

**Windows (PowerShell as Administrator):**
```powershell
.\ssl\uninstall-cert-windows.ps1
```

### Regenerate the certificate

Use the script for your OS — each generates `ssl/localhost.crt` and `ssl/localhost.key` in-place.

**Linux:**
```sh
./ssl/generate-cert-linux.sh
```
Requires `openssl` (`sudo apt install openssl` / `sudo dnf install openssl`).

**macOS:**
```sh
./ssl/generate-cert-macos.sh
```
Uses the `openssl` that ships with macOS; Homebrew `openssl` also works.

**Windows (PowerShell):**
```powershell
.\ssl\generate-cert-windows.ps1
```
Requires OpenSSL for Windows (`winget install ShiningLight.OpenSSL`, `choco install openssl`, or Git for Windows which bundles `openssl.exe`).

After regenerating, rebuild the Traefik container image and re-trust the new cert on each machine:
```sh
npx nx podman-build traefik
# then run the appropriate install-cert script for your OS
```

## Development

```sh
# Start all apps with hot reload (Angular on :4200, remotes on :4201/:4202)
npx nx serve shell --devRemotes=weather-app,weatheredit-app

# Start weather API (required for weather data in dev)
NX_DAEMON=false npx nx serve weather-api
```

## Build

```sh
# Build all Angular apps (production)
npx nx build-all shell

# Build weather API
NX_DAEMON=false npx nx build weather-api

# Build container images
npx nx podman-build shell          # nginx image (Angular MFE static files)
npx nx podman-build traefik        # Traefik reverse proxy + SSL termination
npx nx podman-build weather-api    # .NET API image
npx nx podman-build postgres       # PostgreSQL image
npx nx podman-build ory            # Ory Kratos image + init image
```

## Run (containers)

### All services via Kubernetes (recommended)

```sh
# Build images first, then start all pods
npx nx podman-build shell
npx nx podman-build traefik
npx nx podman-build weather-api
npx nx podman-build ory
npx nx kube-up shell

# Stop all pods
npx nx kube-down shell
```

| URL | Service |
|-----|---------|
| https://localhost:8443 | Shell (HTTPS) |
| https://localhost:8443/weather-app/ | Weather table (public, HTTPS) |
| https://localhost:8443/weatheredit-app/ | Weather CRUD (login required, HTTPS) |
| https://localhost:8443/admin-app/ | Kratos identity admin (admin only, HTTPS) |
| http://localhost:8080 | Redirects to HTTPS |
| http://localhost:5221/weatherforecast | Weather API (GET public, writes require auth) |
| localhost:4433 | Ory Kratos public API |
| localhost:4434 | Ory Kratos admin API |
| localhost:5432 | PostgreSQL |
| https://localhost:8443/grafana/ | Grafana (SSO via Kratos, requires observability pod) |
| http://localhost:9090 | Prometheus (requires observability pod) |
| http://localhost:3100 | Loki (requires observability pod) |

### Individual containers

```sh
npx nx podman-up shell        # Angular MFE on :8080
npx nx podman-up weather-api  # Weather API on :5221

npx nx podman-down shell
npx nx podman-down weather-api
```

## Test & Lint

```sh
npx nx run-many --target=test --all
npx nx run-many --target=lint --all
```

## Weather API repository mode

Change `"Repository"` in `apps/weather-api/appsettings.json`:

| Value | Behavior |
|-------|----------|
| `"Random"` (default) | Read-only, no DB needed |
| `"InMemory"` | Full CRUD, in-process |
| `"EfCore"` | Full CRUD, PostgreSQL |

## E2E Tests (Playwright)

Three Playwright suites test the apps running inside the EKS pods (Traefik on `:8080`/`:8443`). Each suite targets its app via `BASE_URL`:

| Suite | Default `BASE_URL` | Tests |
|-------|--------------------|-------|
| `shell-e2e` | `https://localhost:8443` | Home page, MFE navigation, `/weather` proxy |
| `weather-app-e2e` | `https://localhost:8443/weather-app/` | Forecast table headers, data rows, temperatures |
| `weatheredit-app-e2e` | `https://localhost:8443/weatheredit-app/` | Full CRUD — create, edit, delete, confirm/cancel |

### Run against local EKS pods

```sh
# 1. Start the pods
npx nx podman-build shell
npx nx podman-build weather-api
npx nx kube-up shell

# 2. Run each suite (BASE_URL defaults to the pod URLs above)
npx nx run shell-e2e:e2e
npx nx run weather-app-e2e:e2e
npx nx run weatheredit-app-e2e:e2e

# 3. Tear down
npx nx kube-down shell
```

### Run against a remote EKS cluster

```sh
BASE_URL=https://<eks-node>:8443                    npx nx run shell-e2e:e2e
BASE_URL=https://<eks-node>:8443/weather-app/       npx nx run weather-app-e2e:e2e
BASE_URL=https://<eks-node>:8443/weatheredit-app/   npx nx run weatheredit-app-e2e:e2e
```

## CI

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| **CI** (`.github/workflows/ci.yml`) | push / PR | Lint + production build for all Angular apps |
| **EKS E2E Tests (Smoke)** (`.github/workflows/eks-e2e.yml`) | push to `main` | Builds all container images, starts EKS pods, runs `shell-e2e` only (verifies shell host, MFE navigation, and `/weather` API proxy), posts a result comment on the merged PR |
| **EKS E2E Tests (Full)** (`.github/workflows/eks-e2e-full.yml`) | manual (`workflow_dispatch`) | Same pod setup, but runs all three Playwright suites including full CRUD coverage for `weather-app-e2e` and `weatheredit-app-e2e` |

In CI, each Playwright config emits:
- **GitHub annotations** — inline pass/fail markers on the diff
- **HTML report** — uploaded as a 30-day artifact
- **JUnit XML** — consumed by `dorny/test-reporter` to create a Check Run visible in the PR Checks tab

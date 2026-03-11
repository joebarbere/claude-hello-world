# claude-hello-world

[![EKS E2E Tests](https://github.com/joebarbere/claude-hello-world/actions/workflows/eks-e2e.yml/badge.svg)](https://github.com/joebarbere/claude-hello-world/actions/workflows/eks-e2e.yml)

An Nx monorepo demonstrating Angular Module Federation micro-frontends with a .NET 9 Weather API backend and PostgreSQL, all containerized with Podman and orchestrated via `podman play kube`. Authentication is handled by [Ory Kratos](https://www.ory.sh/kratos/).

## Architecture

```
Browser
  └── Shell (Angular MFE host, :4200 / :8443 HTTPS / :8080 HTTP→redirect)
        ├── weather-app (remote, :4201) — weather forecast table (public)
        └── weatheredit-app (remote, :4202) — weather forecast CRUD (admin/weather_admin only)

nginx (container, :8080 → redirects to HTTPS, :8443 SSL termination)
  ├── /                        → shell app
  ├── /weather-app/            → weather-app remote
  ├── /weatheredit-app/        → weatheredit-app remote
  ├── /weather                 → proxy → weather-api
  └── /.ory/kratos/public/     → proxy → Ory Kratos public API (:4433)

weather-api (.NET 9, :5220 dev / :5221 container)
  ├── GET endpoints — public
  └── POST/PUT/DELETE endpoints — restricted to admin and weather_admin roles

Ory Kratos (identity, :4433 public / :4434 admin)
  └── SQLite-backed user store with role-based access

PostgreSQL 17 (:5432)
```

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

nginx serves all traffic over HTTPS using a self-signed certificate for `localhost`.
HTTP on port 8080 automatically redirects to HTTPS on port 8443.

The certificate and private key are pre-generated and stored in `ssl/`:

| File | Description |
|------|-------------|
| `ssl/localhost.crt` | Self-signed X.509 certificate (CN=localhost, valid 10 years) |
| `ssl/localhost.key` | RSA 2048 private key |

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

```sh
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout ssl/localhost.key -out ssl/localhost.crt \
  -subj "/CN=localhost/O=claude-hello-world/C=US" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

After regenerating, rebuild the container image (`npx nx podman-build shell`) and re-run the install script on each machine that needs to trust the new certificate.

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
npx nx podman-build shell          # nginx image (Angular MFE)
npx nx podman-build weather-api    # .NET API image
npx nx podman-build postgres       # PostgreSQL image
npx nx podman-build ory            # Ory Kratos image + init image
```

## Run (containers)

### All services via Kubernetes (recommended)

```sh
# Build images first, then start all pods
npx nx podman-build shell
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
| http://localhost:8080 | Redirects to HTTPS |
| http://localhost:5221/weatherforecast | Weather API (GET public, writes require auth) |
| localhost:4433 | Ory Kratos public API |
| localhost:4434 | Ory Kratos admin API |
| localhost:5432 | PostgreSQL |

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

Three Playwright suites test the apps running inside the EKS pods (nginx on `:8080`). Each suite targets its app via `BASE_URL`:

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

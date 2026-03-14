# Running the Project

All commands are run from the workspace root (`claude-hello-world/`).

---

## Development

### Serve all apps locally (hot reload)

```bash
npx nx serve shell --devRemotes=weather-app,weatheredit-app
```

Starts the Module Federation dev server for the shell on port 4200. `--devRemotes` tells Nx to also start live webpack dev servers for weather-app (port 4201) and weatheredit-app (port 4202) rather than serving their static builds. Changes in any app trigger a live reload in the browser.

| App | URL |
|-----|-----|
| Shell (host) | http://localhost:4200 |
| weather-app (remote) | http://localhost:4201 |
| weatheredit-app (remote) | http://localhost:4202 |

> **Auth in dev mode:** The Angular auth guard calls `/.ory/kratos/public/sessions/whoami`. In dev mode there is no Traefik proxy, so this request goes directly to `http://localhost:4200/.ory/kratos/public/` — which the webpack dev server does not proxy by default. To test the auth guard locally, either run a Kratos instance on port 4433 and add a proxy rule for `/.ory/kratos/public/` in `apps/shell/proxy.conf.json`, or temporarily bypass the guard during frontend development.

### Serve shell only (remotes served as static builds)

```bash
npx nx serve shell
```

Starts only the shell dev server. The remotes must have been built previously — the shell loads them from their static `dist/` output rather than live dev servers. Useful when you are only changing shell code.

### Serve a single remote app

```bash
npx nx serve weather-app
npx nx serve weatheredit-app
```

Starts a standalone dev server for one remote at its port (4201 or 4202). Depends on `shell:serve` being running. Primarily useful for isolated component development or debugging a remote in isolation.

---

## Building

### Build a single app (production)

```bash
npx nx build shell
npx nx build weather-app
npx nx build weatheredit-app
```

Runs a production webpack build for one app. Output lands in `dist/apps/<name>/`. The default configuration is `production` (optimized, hashed filenames, no source maps). weather-app and weatheredit-app builds include `baseHref` set to `/weather-app/` and `/weatheredit-app/` respectively for correct asset resolution when served from sub-paths.

### Build a single app (development)

```bash
npx nx build shell --configuration=development
npx nx build weather-app --configuration=development
npx nx build weatheredit-app --configuration=development
```

Runs a development build with source maps, named chunks, and no optimization. Faster than production and easier to debug — the `dist/` output can be inspected directly with readable filenames.

### Build all apps in parallel (production)

```bash
npx nx build-all shell
```

Runs production builds for shell, weather-app, and weatheredit-app in parallel (`--parallel=3`). This is the same build step that `podman-build` triggers automatically as a dependency. Outputs to:
- `dist/apps/shell/`
- `dist/apps/weather-app/`
- `dist/apps/weatheredit-app/`

---

## Testing and Linting

### Run unit tests for one app

```bash
npx nx test shell
npx nx test weather-app
npx nx test weatheredit-app
```

Runs Vitest unit tests for the specified app. Coverage reports are written to `coverage/apps/<name>/`.

### Run unit tests for all apps

```bash
npx nx run-many --target=test --all
```

Runs Vitest for every project in the workspace in parallel. Nx caches test results — only re-runs tests for projects whose files have changed since the last run.

### Lint one app

```bash
npx nx lint shell
npx nx lint weather-app
npx nx lint weatheredit-app
```

Runs ESLint for the specified app using the project's `eslint.config.mjs`. Reports rule violations and any TypeScript type errors caught by the linter.

### Lint all apps

```bash
npx nx run-many --target=lint --all
```

Lints every project in the workspace in parallel.

---

## Container (Podman)

### Build the Podman image

```bash
npx nx podman-build shell
```

First runs `build-all` (production builds for all three apps), then runs:

```
podman build -t claude-hello-world -f Containerfile.nginx .
```

The multi-stage `Containerfile.nginx` compiles the apps inside a `node:20-alpine` container and copies the outputs into an `nginx:alpine` image. The resulting image is tagged `localhost/claude-hello-world:latest`. This image only serves static files — SSL termination and reverse proxying are handled by Traefik.

To verify the image was created:

```bash
podman images | grep claude-hello-world
```

### Start the container

```bash
npx nx podman-up shell
```

Runs `podman run -d` to start the `claude-hello-world` container in detached mode, mapping port 8080 on the host to port 8080 in the container (static files only, no SSL). For the full setup with Traefik SSL termination, use `kube-up` instead.

The image must have been built first with `podman-build`.

| URL | Serves |
|-----|--------|
| http://localhost:8080 | Shell (host app, HTTP only — no Traefik) |
| http://localhost:8080/weather-app/ | weather-app remote |
| http://localhost:8080/weatheredit-app/ | weatheredit-app remote |

> **Browser trust:** The first time you open `https://localhost:8443` your browser will warn about the self-signed certificate. To suppress this, run the install script for your OS (see `ssl/` directory and the SSL section of `README.md`).

### Stop the container

```bash
npx nx podman-down shell
```

Runs `podman rm -f claude-hello-world`, forcibly stopping and removing the container. The image is preserved — you can restart with `podman-up` without rebuilding.

---

## Ory Kratos (authentication)

Ory Kratos handles identity and session management. Two images are produced: the Kratos server (`ory-kratos`) and a one-shot init container (`ory-kratos-init`) that seeds the default users.

### Build the Kratos images

```bash
npx nx podman-build ory
```

Runs two sequential builds from the `apps/ory/` directory:

1. `podman build -t ory-kratos -f Containerfile .` — extends `oryd/kratos:v1.3.0-distroless` with the project's `kratos.yml` and `identity.schema.json`
2. `podman build -t ory-kratos-init -f Containerfile.init .` — an `alpine:3.21` image with `wget` and the `init-users.sh` script

### Default users created by the init container

| Role | Email | Password |
|------|-------|----------|
| `admin` | `admin@example.com` | `Admin1234!` |
| `weather_admin` | `weatheradmin@example.com` | `WeatherAdmin1234!` |

The init container calls `POST /admin/identities` on the Kratos Admin API for each user, skipping any that already exist. It is run as a Kubernetes `initContainer` before the Kratos server starts accepting traffic.

### Kratos API ports

| Port | Purpose |
|------|---------|
| 4433 | Public API (sessions, self-service login flows) |
| 4434 | Admin API (identity management) |

Traefik proxies `/.ory/kratos/public/` → `http://host.containers.internal:4433/` so the Angular app can reach Kratos without cross-origin issues.

---

## Kubernetes (podman play kube)

Runs the Traefik reverse proxy, nginx static file server, weather-api, postgres, and Ory Kratos containers together using Kubernetes Pod manifests and `podman play kube`. Traefik handles SSL termination and proxying; nginx only serves Angular static files. All images must be built before running.

### Prerequisites — build all images

```bash
npx nx podman-build shell
npx nx podman-build traefik
npx nx podman-build weather-api
npx nx podman-build ory
# postgres is built automatically via dependsOn
```

### Start all containers

```bash
npx nx kube-up shell
```

Runs `podman play kube k8s/pod.yaml`, which creates and starts all pods defined in the manifest. The `ory-kratos` pod starts Kratos and the `ory-kratos-init` sidecar simultaneously; the sidecar waits for Kratos to become ready, then seeds the default users and exits.

| URL | Serves |
|-----|--------|
| https://localhost:8443 | Shell (host app, HTTPS) |
| https://localhost:8443/weather-app/ | weather-app remote (public) |
| https://localhost:8443/weatheredit-app/ | weatheredit-app remote (login required) |
| https://localhost:8443/.ory/kratos/public/ | Ory Kratos public API (proxied) |
| http://localhost:8080 | Redirects to HTTPS |
| http://localhost:5221/weatherforecast | Weather API (GET public, writes require auth) |
| http://localhost:5221/openapi/v1.json | Weather API OpenAPI spec |
| http://localhost:4433 | Ory Kratos public API (direct) |
| http://localhost:4434 | Ory Kratos admin API |

### Stop all containers

```bash
npx nx kube-down shell
```

Runs `podman play kube k8s/pod.yaml --down`, stopping and removing all pods defined in the manifest.

---

## Observability (Prometheus, Loki, Grafana)

The observability stack runs as a separate pod — it is **not** started by `kube-up shell` and is never activated during e2e tests. Stand it up independently when you want metrics and logs locally.

### Build observability images

```bash
npx nx run observability:podman-build
```

Builds four images in parallel:

| Image | Base | Purpose |
|-------|------|---------|
| `localhost/prometheus:latest` | `prom/prometheus` | Metrics scraping and storage |
| `localhost/loki:latest` | `grafana/loki` | Log aggregation and storage |
| `localhost/promtail:latest` | `grafana/promtail` | Log collection from pod/container logs |
| `localhost/grafana:latest` | `grafana/grafana` | Dashboards for metrics and logs |

### Start the observability pod

```bash
npx nx run observability:kube-up
```

Builds images (if not already built) then runs `podman play kube k8s/observability-pod.yaml`.

| Service | URL | Purpose |
|---------|-----|---------|
| Grafana | http://localhost:3000 | Dashboards (login: `admin` / `admin`) |
| Prometheus | http://localhost:9090 | Metrics query UI |
| Loki | http://localhost:3100 | Log query API (used by Grafana) |
| Promtail | — | No external port; ships logs to Loki |

### What gets scraped

**Metrics (Prometheus):**
- `weather-api` — ASP.NET Core HTTP metrics via `prometheus-net` at `host.containers.internal:5221/metrics`
- `nginx` — connection stats via the `nginx-prometheus-exporter` sidecar at `host.containers.internal:9113`
- `prometheus` — self-scrape at `localhost:9090`

**Logs (Promtail → Loki):**
- `/var/log/pods/*/*/*.log` — CRI-format logs written by the container runtime for all running pods
- `/var/lib/containers/storage/overlay-containers/*/userdata/ctr.log` — raw Podman container logs (fallback)

> **macOS note:** Podman containers run inside a Linux VM. The `hostPath` volume mounts (`/var/log`, `/var/lib/containers`) refer to paths inside that VM, not the macOS host filesystem. Log collection works automatically when `kube-up shell` and `kube-up observability` are both running inside the same Podman Machine.

### Grafana datasources (auto-provisioned)

Both datasources are provisioned at startup — no manual setup required.

| Datasource | Type | URL |
|-----------|------|-----|
| Prometheus | Prometheus | `http://localhost:9090` |
| Loki | Loki | `http://localhost:3100` |

The pre-built **Weather API** dashboard (under the Default folder) shows HTTP request rate, p99 latency, in-flight requests, process memory, and nginx active connections. Use **Explore → Loki** to query container logs.

### Stop the observability pod

```bash
npx nx run observability:kube-down
```

---

## Weather API (.NET)

### Build the API

```bash
NX_DAEMON=false npx nx build weather-api
```

Runs `dotnet build` on `apps/weather-api/WeatherApi.csproj` in Debug configuration. Output lands in `dist/apps/weather-api/net9.0/`. The `NX_DAEMON=false` flag avoids a known Nx Daemon hang when calculating the project graph after a .NET build.

### Serve the API (with hot reload)

```bash
NX_DAEMON=false npx nx serve weather-api
```

Runs `dotnet watch run` against the project, enabling hot reload. The API listens on:

| URL | Description |
|-----|-------------|
| http://localhost:5220/weatherforecast | Sample weather forecast endpoint |
| http://localhost:5220/scalar/v1 | Scalar API reference UI (dev only) |
| http://localhost:5220/openapi/v1.json | Raw OpenAPI JSON spec |

### Build the container image

```bash
npx nx podman-build weather-api
```

Runs a two-stage Podman build using `apps/weather-api/Containerfile` with the workspace root as the build context:

1. **builder** — `mcr.microsoft.com/dotnet/sdk:9.0-alpine`: restores packages and publishes a Release build to `/app/publish`
2. **runner** — `mcr.microsoft.com/dotnet/aspnet:9.0-alpine`: copies the published output and sets the entrypoint

The resulting image is tagged `localhost/weather-api:latest`. The runtime image contains only the ASP.NET runtime (no SDK), keeping the image size minimal.

### Start the container

```bash
npx nx podman-up weather-api
```

Runs the container in detached mode, mapping host port 5221 to the container's port 8080 (ASP.NET Core's default HTTP port in containers).

| URL | Description |
|-----|-------------|
| http://localhost:5221/weatherforecast | Weather forecast endpoint |
| http://localhost:5221/openapi/v1.json | OpenAPI JSON spec |

Note: Scalar UI is not available in the containerized build — `app.MapScalarApiReference()` is only registered in the `Development` environment.

### Stop the container

```bash
npx nx podman-down weather-api
```

Runs `podman rm -f weather-api`, forcibly stopping and removing the container. The image is preserved.

---

## Nx Workspace Utilities

### View all targets for a project

```bash
npx nx show project shell
npx nx show project weather-app
npx nx show project weatheredit-app
```

Prints all available targets (build, serve, test, lint, podman-build, etc.) for the given project along with their executor and options.

### Visualize the project graph

```bash
npx nx graph
```

Opens a browser-based interactive graph showing all projects in the workspace and their dependencies. Useful for understanding how the shell depends on its remotes and which projects are affected by a given change.

### See what is affected by current changes

```bash
npx nx affected --target=build
npx nx affected --target=test
```

Compares the current working tree against the base branch and runs the specified target only for projects that are affected by the changes. Speeds up CI pipelines significantly in larger monorepos.

### Clear the Nx build cache

```bash
npx nx reset
```

Deletes the local `.nx/cache` directory. Run this if builds are returning unexpected cached results or after significant dependency changes.

---

## E2E Tests (Playwright against EKS pods)

Three Playwright suites (`shell-e2e`, `weather-app-e2e`, `weatheredit-app-e2e`) test the apps as they run inside the Kubernetes pods. The pods must be up before running.

### Prerequisites — build images and start pods

```bash
npx nx podman-build shell        # builds Angular MFEs + nginx image
npx nx podman-build traefik      # builds Traefik reverse proxy image
npx nx podman-build weather-api  # builds .NET API image
npx nx podman-build ory          # builds ory-kratos and ory-kratos-init images
# postgres is built automatically via dependsOn
npx nx kube-up shell             # starts all pods (traefik :8080/:8443, nginx internal, weather-api :5221, postgres :5432, kratos :4433/:4434)
```

> **Auth note:** `weatheredit-app-e2e` navigates to `/weatheredit-app/` which triggers the Ory auth guard. The guard redirects to Kratos if no valid session cookie is present. The e2e suite expects Kratos to be running (included in the pod manifest) and tests cover the redirect behaviour.


### Run all e2e suites against the local pods

```bash
npx nx run shell-e2e:e2e
npx nx run weather-app-e2e:e2e
npx nx run weatheredit-app-e2e:e2e
```

Each suite reads `BASE_URL` from the environment. When `BASE_URL` is not set, the configs default to the local pod URLs:

| Suite | Default `BASE_URL` |
|-------|--------------------|
| `shell-e2e` | `https://localhost:8443` |
| `weather-app-e2e` | `https://localhost:8443/weather-app/` |
| `weatheredit-app-e2e` | `https://localhost:8443/weatheredit-app/` |

### Run against a specific (remote) host

```bash
BASE_URL=https://<eks-node>:8443                    npx nx run shell-e2e:e2e
BASE_URL=https://<eks-node>:8443/weather-app/       npx nx run weather-app-e2e:e2e
BASE_URL=https://<eks-node>:8443/weatheredit-app/   npx nx run weatheredit-app-e2e:e2e
```

When `BASE_URL` is set, no local dev server is started — Playwright connects directly to the target host.

### View the HTML report

After a run, open the generated HTML report:

```bash
npx playwright show-report apps/shell-e2e/playwright-report
npx playwright show-report apps/weather-app-e2e/playwright-report
npx playwright show-report apps/weatheredit-app-e2e/playwright-report
```

### Teardown

```bash
npx nx kube-down shell
```

---

## CI — EKS E2E Workflows

Two workflows cover EKS E2E testing at different levels of coverage.

### Smoke workflow (automatic)

`eks-e2e.yml` runs on every push to `main` (i.e., every merged PR). It runs only the `shell-e2e` suite, which is enough to confirm all pods are healthy:

1. Builds all container images (nginx, traefik, weather-api, postgres, ory) inside the runner
2. Starts all pods with `podman play kube` — including the Ory Kratos init container that seeds default users
3. Waits for the Traefik and weather-api pods to pass health checks (parallel)
4. Runs `shell-e2e` — verifies the shell host, MFE navigation to `/weather-app` and `/weatheredit-app`, and the `/weather` API proxy
5. Stops the pods
6. Publishes JUnit XML as a GitHub Check Run (`dorny/test-reporter`)
7. Uploads the `shell-e2e` HTML report as a 30-day artifact
8. Posts a pass/fail comment on the merged PR with a link to the full workflow

```bash
gh run list --workflow=eks-e2e.yml --repo joebarbere/claude-hello-world
```

### Full workflow (manual)

`eks-e2e-full.yml` runs on demand via `workflow_dispatch`. It runs all three Playwright suites for full CRUD coverage:

1. Same build and pod-startup steps as the smoke workflow
2. Runs `shell-e2e`, `weather-app-e2e`, and `weatheredit-app-e2e` in sequence
3. Same teardown and reporting (Check Run + artifact upload for all three suites)

```bash
gh workflow run eks-e2e-full.yml --repo joebarbere/claude-hello-world
gh run list --workflow=eks-e2e-full.yml --repo joebarbere/claude-hello-world
```

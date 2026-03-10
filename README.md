# claude-hello-world

[![EKS E2E Tests](https://github.com/joebarbere/claude-hello-world/actions/workflows/eks-e2e.yml/badge.svg)](https://github.com/joebarbere/claude-hello-world/actions/workflows/eks-e2e.yml)

An Nx monorepo demonstrating Angular Module Federation micro-frontends with a .NET 9 Weather API backend and PostgreSQL, all containerized with Podman and orchestrated via `podman play kube`.

## Architecture

```
Browser
  └── Shell (Angular MFE host, :4200 / :8080)
        ├── weather-app (remote, :4201) — weather forecast table
        └── weatheredit-app (remote, :4202) — weather forecast CRUD

nginx (container, :8080)
  ├── /              → shell app
  ├── /weather-app/  → weather-app remote
  ├── /weatheredit-app/        → weatheredit-app remote
  └── /weather    → proxy → weather-api

weather-api (.NET 9, :5220 dev / :5221 container)
  └── Repository layer
        ├── Random   (default, read-only)
        ├── InMemory (full CRUD, in-process)
        └── EfCore   (full CRUD, PostgreSQL)

PostgreSQL 17 (:5432)
```

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 20+ |
| .NET SDK | 9.0 |
| Podman | any recent |

```sh
npm install
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
npx nx podman-build shell          # nginx image (Angular MFE)
npx nx podman-build weather-api    # .NET API image
npx nx podman-build postgres       # PostgreSQL image
```

## Run (containers)

### All services via Kubernetes (recommended)

```sh
# Build images first, then start all pods
npx nx podman-build shell
npx nx podman-build weather-api
npx nx kube-up shell

# Stop all pods
npx nx kube-down shell
```

| URL | Service |
|-----|---------|
| http://localhost:8080 | Shell |
| http://localhost:8080/weather-app/ | Weather table |
| http://localhost:8080/weatheredit-app/ | Weather CRUD |
| http://localhost:5221/weatherforecast | Weather API |
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

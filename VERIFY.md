## Final Verification

### Individual container workflow

```bash
# Build all images
npx nx podman-build shell          # builds nginx MFE image (claude-hello-world)
npx nx podman-build weather-api    # builds .NET API image
npx nx podman-build postgres       # builds PostgreSQL image
npx nx podman-build ory            # builds ory-kratos and ory-kratos-init images

# Run individually
npx nx podman-up shell             # → http://localhost:8080 (Angular MFE)
npx nx podman-up weather-api       # → http://localhost:5221/weatherforecast

# Stop
npx nx podman-down shell
npx nx podman-down weather-api
```

### Kubernetes workflow (all containers together)

```bash
# Build images (postgres image built automatically via dependsOn)
npx nx podman-build shell
npx nx podman-build weather-api
npx nx podman-build ory

# Start all pods
npx nx kube-up shell

# Verify (nginx redirects HTTP→HTTPS; use -k for the self-signed cert)
curl -Lk https://localhost:8443                    # Angular shell
curl -Lk https://localhost:8443/weather-app/       # weather-app remote (public)
curl -Lk https://localhost:8443/weatheredit-app/   # weatheredit-app (redirects to login)
curl -k  https://localhost:8443/weather            # nginx → weather-api proxy (GET, public)
curl     http://localhost:5221/weatherforecast     # weather-api direct (HTTP, no SSL)
curl     http://localhost:4433/health/ready        # Kratos public health check
psql -h localhost -p 5432 -U appuser -d appdb # PostgreSQL

# Stop all pods
npx nx kube-down shell
```

### Authentication

| User | Email | Password | Role | Access |
|------|-------|----------|------|--------|
| Admin | `admin@example.com` | `Admin1234!` | `admin` | weatheredit-app + all API writes |
| Weather Admin | `weatheradmin@example.com` | `WeatherAdmin1234!` | `weather_admin` | weatheredit-app + all API writes |

### Weather API repository selection

Change `"Repository"` in `apps/weather-api/appsettings.json`:

| Value | Behavior |
|-------|----------|
| `"Random"` (default) | Read-only, random data, no DB |
| `"InMemory"` | Full CRUD, in-process storage, no DB |
| `"EfCore"` | Full CRUD, persisted to PostgreSQL |

### Containerfiles

| File | Base image | Purpose |
|------|-----------|---------|
| `Containerfile.nginx` | `node:20-alpine` → `nginx:alpine` | Angular MFE (shell + weather-app + weatheredit-app) |
| `apps/weather-api/Containerfile` | `dotnet/sdk:9.0-alpine` → `dotnet/aspnet:9.0-alpine` | .NET Weather API |
| `apps/postgres/Containerfile` | `postgres:17-alpine` | PostgreSQL database |
| `apps/ory/Containerfile` | `oryd/kratos:v1.3.0-distroless` | Ory Kratos identity server |
| `apps/ory/Containerfile.init` | `alpine:3.21` | One-shot user seeding sidecar |

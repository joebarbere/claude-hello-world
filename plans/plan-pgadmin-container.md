# Plan: Add a pgAdmin Container

## Goal

Add a browser-based pgAdmin 4 container to the platform for ad-hoc SQL inspection of Postgres databases (appdb, and the future airflow database), accessible through Traefik at `/pgadmin` with optional Kratos SSO gating.

## Current State

- **Postgres**: Runs in `k8s/postgres-pod.yaml` as a standalone pod with `appdb` database on port 5432.
- **SQL access**: Currently requires `podman exec postgres-postgres psql -U appuser` or a local `psql` client. No browser-based query tool exists.
- **Traefik routing**: `traefik/traefik-dynamic.yml` defines routers for all services. Existing patterns include sub-path routing with strip-prefix middleware (e.g., Kafka UI at `/kafka-ui`) and Kratos SSO via `forwardAuth` middleware (e.g., Grafana at `/grafana`, Airflow at `/airflow`).
- **Admin app**: `apps/admin-app/src/app/remote-entry/entry.ts` defines an `ADMIN_LINKS` array with link cards organized by category. Cards support optional health badges and credentials display.
- **Auth proxy**: `apps/observability/auth-proxy/` provides a Kratos-backed forwardAuth endpoint used by Grafana, Airflow, and Jupyter.

## Implementation Steps

### 1. Create the pgAdmin container configuration

Create `apps/pgadmin/servers.json` to pre-configure the appdb connection:

```json
{
  "Servers": {
    "1": {
      "Name": "appdb (Weather API)",
      "Group": "Local",
      "Host": "host.containers.internal",
      "Port": 5432,
      "MaintenanceDB": "appdb",
      "Username": "appuser",
      "SSLMode": "prefer"
    }
  }
}
```

**Note**: If the Airflow Postgres migration is also implemented, add a second server entry for the `airflow` database.

### 2. Add pgAdmin to an existing pod or create a new pod manifest

Option A (recommended): Add to the postgres pod since pgAdmin is tightly coupled to Postgres.

Option B: Create a standalone `k8s/pgadmin-pod.yaml`.

Going with Option A, add a pgAdmin container to `k8s/postgres-pod.yaml`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres
  labels:
    app: postgres
spec:
  containers:
    - name: postgres
      image: localhost/postgres:latest
      ports:
        - containerPort: 5432
          hostPort: 5432
      env:
        - name: POSTGRES_DB
          value: appdb
        - name: POSTGRES_USER
          value: appuser
        - name: POSTGRES_PASSWORD
          value: apppassword

    - name: pgadmin
      image: docker.io/dpage/pgadmin4:latest
      ports:
        - containerPort: 5050
          hostPort: 5050
      env:
        - name: PGADMIN_DEFAULT_EMAIL
          value: admin@example.com
        - name: PGADMIN_DEFAULT_PASSWORD
          value: admin
        - name: PGADMIN_LISTEN_PORT
          value: "5050"
        - name: SCRIPT_NAME
          value: /pgadmin
      volumeMounts:
        - name: pgadmin-servers
          mountPath: /pgadmin4/servers.json
          subPath: servers.json
          readOnly: true

  volumes:
    - name: pgadmin-servers
      hostPath:
        path: /tmp/pgadmin/servers.json
```

The `SCRIPT_NAME=/pgadmin` env var tells pgAdmin to serve from the `/pgadmin` sub-path, eliminating the need for Traefik strip-prefix middleware.

### 3. Create a sync step for the servers.json file

Add to `scripts/sync-datascience.sh` (or create a dedicated `scripts/sync-pgadmin.sh`):

```bash
# Sync pgAdmin servers.json
mkdir -p /tmp/pgadmin
cp "${REPO_ROOT}/apps/pgadmin/servers.json" /tmp/pgadmin/servers.json
if command -v chcon &>/dev/null; then
  chcon -R -t container_file_t -l s0 /tmp/pgadmin
fi
chmod -R a+rX /tmp/pgadmin
```

### 4. Add Traefik routing

Add to `traefik/traefik-dynamic.yml`:

Router:
```yaml
    # pgAdmin — database management UI
    pgadmin-router:
      rule: "PathPrefix(`/pgadmin`)"
      entryPoints:
        - websecure
      service: pgadmin
      priority: 22
      middlewares:
        - kratos-auth
      tls: {}
```

Service:
```yaml
    # pgAdmin in postgres pod
    pgadmin:
      loadBalancer:
        servers:
          - url: "http://host.containers.internal:5050"
```

The `kratos-auth` middleware reuses the existing forwardAuth setup, so only authenticated users can reach pgAdmin.

### 5. Add admin-app link card

In `apps/admin-app/src/app/remote-entry/entry.ts`, add to the `ADMIN_LINKS` array:

```typescript
{
  name: 'pgAdmin',
  url: '/pgadmin',
  description: 'Browser-based PostgreSQL management and SQL query tool.',
  category: 'Infrastructure',
  badge: { type: 'health', endpoint: '/pgadmin/misc/ping' },
},
```

Place it after the existing Infrastructure entries (Kafka UI, Traefik Dashboard).

### 6. Optional: Kratos SSO auto-login

For a tighter SSO experience, pgAdmin supports OAuth2 authentication. However, this is complex to configure with Kratos and the basic pgAdmin login (admin@example.com / admin) behind the Kratos forwardAuth gate is sufficient for a dev environment. Defer full SSO integration unless there is a specific need.

## Files to Create/Modify

- **Create**: `apps/pgadmin/servers.json` -- pre-configured server connections
- **Modify**: `k8s/postgres-pod.yaml` -- add pgAdmin container, volume mount
- **Modify**: `traefik/traefik-dynamic.yml` -- add pgAdmin router and service
- **Modify**: `apps/admin-app/src/app/remote-entry/entry.ts` -- add pgAdmin link card
- **Modify**: `scripts/sync-datascience.sh` (or create `scripts/sync-pgadmin.sh`) -- sync servers.json to host path

## Testing

1. **Container starts**: After `podman kube play k8s/postgres-pod.yaml`, verify pgAdmin is running:
   ```bash
   podman logs postgres-pgadmin 2>&1 | grep "Listening at"
   ```

2. **Direct access**: Navigate to `http://localhost:5050/pgadmin/` and log in with `admin@example.com` / `admin`.

3. **Traefik routing**: Navigate to `https://localhost:8443/pgadmin/` -- should redirect to Kratos login if not authenticated, then show pgAdmin.

4. **Pre-configured server**: After logging in, the "Servers" tree in the left panel should show "appdb (Weather API)" without manual setup. Connecting requires entering the `apppassword` password (pgAdmin does not store passwords in `servers.json` by default for security).

5. **Health badge**: The admin-app link card should show a green "Healthy" badge when pgAdmin is running (the `/pgadmin/misc/ping` endpoint returns `PING` with HTTP 200).

6. **Run a query**: Connect to appdb and run `SELECT count(*) FROM "WeatherForecasts";` to confirm database access works.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| pgAdmin container is ~300 MB, increasing pull time | Use a specific version tag instead of `latest` to benefit from layer caching. Consider `sosedoff/pgweb` (~15 MB) as a lighter alternative if full pgAdmin features are not needed. |
| pgAdmin is slow to start in constrained environments | It takes 15-30 seconds to initialize. Not a problem for dev use. |
| `servers.json` password storage | By default, `servers.json` does not store passwords (user must enter on first connect). This is intentional for security. To auto-fill, add `"PassFile": "/pgadmin4/pgpass"` and mount a `.pgpass` file. |
| Shared pod with Postgres means pgAdmin restarts when Postgres restarts | Acceptable for dev. If this becomes a problem, move pgAdmin to its own pod. |
| hostPath volume for servers.json requires sync step | Same pattern as Airflow DAGs and Jupyter notebooks -- developers already run `sync-datascience.sh`. |

## Dependencies

- **Separate Postgres stack** (`plan-separate-postgres-stack.md`): Not a hard dependency, but if Postgres moves to an independent lifecycle, pgAdmin should move with it (or be its own pod).
- **Airflow Postgres metadata** (`plan-airflow-postgres-metadata.md`): If implemented, add the `airflow` database as a second entry in `servers.json`.
- **No blockers**: This change can be implemented independently.

## Estimated Complexity

**Small** -- One new container added to an existing pod, one Traefik route, one admin-app link card. The main work is creating the `servers.json` and wiring the volume mount.

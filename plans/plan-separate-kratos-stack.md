# Plan: Separate Ory Kratos into an Independent Stack

## Goal

Formalize Ory Kratos as an independently managed infrastructure pod with explicit startup dependencies on Postgres, readiness gates for downstream consumers, and CI workflow integration so identity infrastructure can be versioned and upgraded without touching the application layer.

## Current State

- **Kratos pod**: `k8s/ory-kratos-pod.yaml` is already a standalone pod manifest with three containers:
  - `kratos-migrate` (initContainer) -- runs `migrate sql` against Postgres at `host.containers.internal:5432`
  - `ory-kratos` -- the main Kratos server, ports 4433 (public) and 4434 (admin)
  - `ory-kratos-init` -- seeds initial identities/configuration via the admin API at `http://localhost:4434`
- **Postgres dependency**: Both the initContainer and main container use DSN `postgres://appuser:apppassword@host.containers.internal:5432/appdb?sslmode=disable`. Kratos will fail to start if Postgres is not available.
- **Downstream dependents**:
  - `k8s/apps-pod.yaml` -- weather-api uses `OryKratosPublicUrl=http://host.containers.internal:4433` for session validation
  - `traefik/traefik-dynamic.yml` -- the `kratos-auth` forwardAuth middleware routes to `http://host.containers.internal:4180` (auth-proxy), which in turn calls Kratos at `host.containers.internal:4433`
  - `k8s/observability-pod.yaml` -- auth-proxy container uses Kratos for session checks
- **No readiness checks**: No pod has a mechanism to wait for Kratos to be ready before attempting to use it. If apps-pod starts before Kratos is healthy, auth-protected routes return 502 errors.
- **No health probes**: The ory-kratos-pod.yaml has no liveness or readiness probes.
- **CI workflow**: `.github/workflows/ci.yml` does not start pods. The e2e workflows would need Kratos started between Postgres and apps.

## Implementation Steps

### 1. Add health probes to the Kratos container

Edit `k8s/ory-kratos-pod.yaml` to add probes to the `ory-kratos` container:

```yaml
    - name: ory-kratos
      image: localhost/ory-kratos:latest
      ports:
        - containerPort: 4433
          hostPort: 4433
        - containerPort: 4434
          hostPort: 4434
      env:
        - name: DSN
          value: postgres://appuser:apppassword@host.containers.internal:5432/appdb?sslmode=disable
        - name: OryKratosPublicUrl
          value: http://host.containers.internal:4433
      readinessProbe:
        httpGet:
          path: /health/ready
          port: 4433
        initialDelaySeconds: 5
        periodSeconds: 5
      livenessProbe:
        httpGet:
          path: /health/alive
          port: 4433
        initialDelaySeconds: 10
        periodSeconds: 15
```

### 2. Add a Postgres readiness wait initContainer

Add a `wait-for-postgres` initContainer before `kratos-migrate` (same pattern as in `plan-separate-postgres-stack.md`):

```yaml
  initContainers:
    - name: wait-for-postgres
      image: docker.io/library/postgres:17-alpine
      command:
        - sh
        - -c
        - |
          until pg_isready -h host.containers.internal -p 5432 -U appuser; do
            echo "Waiting for Postgres..."
            sleep 2
          done
    - name: kratos-migrate
      image: localhost/ory-kratos:latest
      args: ["migrate", "sql", "--yes", "-e", "-c", "/etc/config/kratos/kratos.yml"]
      env:
        - name: DSN
          value: postgres://appuser:apppassword@host.containers.internal:5432/appdb?sslmode=disable
```

### 3. Add a Kratos readiness wait to apps-pod startup

The weather-api in `k8s/apps-pod.yaml` depends on Kratos being healthy for auth middleware to function. Options:

**Option A**: Add an initContainer to apps-pod that waits for Kratos:

```yaml
  initContainers:
    - name: wait-for-kratos
      image: docker.io/curlimages/curl:latest
      command:
        - sh
        - -c
        - |
          until curl -sf http://host.containers.internal:4433/health/ready; do
            echo "Waiting for Kratos..."
            sleep 2
          done
```

**Option B**: The weather-api handles Kratos unavailability gracefully (returns 503 on auth endpoints until Kratos is up). This is the more resilient approach but requires application-level changes.

Recommend Option A for simplicity -- it adds a one-time 5-10 second wait on startup but guarantees Kratos is ready.

### 4. Add Kratos readiness wait to observability pod

The auth-proxy in `k8s/observability-pod.yaml` also depends on Kratos. Add a similar initContainer:

```yaml
  initContainers:
    - name: wait-for-kratos
      image: docker.io/curlimages/curl:latest
      command:
        - sh
        - -c
        - |
          until curl -sf http://host.containers.internal:4433/health/ready; do
            echo "Waiting for Kratos..."
            sleep 3
          done
```

Alternatively, the auth-proxy (`apps/observability/auth-proxy/auth-proxy.py`) could be made resilient to Kratos being temporarily unavailable by returning a 503 instead of crashing. This is a better long-term approach but more work.

### 5. Update RUN.md with startup order

Ensure the pod startup documentation (from `plan-separate-postgres-stack.md`) includes Kratos in position 2:

```
1. postgres
2. ory-kratos (depends on postgres)
3. apps (depends on postgres, ory-kratos)
4. kafka (depends on postgres)
5. datascience (depends on postgres if using Postgres metadata)
6. observability (depends on ory-kratos for auth-proxy)
```

### 6. Update CI e2e workflows

In `.github/workflows/eks-e2e.yml` and `eks-e2e-full.yml`, ensure the pod startup sequence is:

```yaml
- name: Start Postgres
  run: podman kube play k8s/postgres-pod.yaml

- name: Wait for Postgres
  run: |
    for i in $(seq 1 30); do
      pg_isready -h localhost -p 5432 -U appuser && break
      sleep 2
    done

- name: Start Ory Kratos
  run: podman kube play k8s/ory-kratos-pod.yaml

- name: Wait for Kratos
  run: |
    for i in $(seq 1 30); do
      curl -sf http://localhost:4433/health/ready && break
      sleep 2
    done

- name: Start Apps
  run: podman kube play k8s/apps-pod.yaml
```

## Files to Create/Modify

- **Modify**: `k8s/ory-kratos-pod.yaml` -- add health probes, add `wait-for-postgres` initContainer
- **Modify**: `k8s/apps-pod.yaml` -- add `wait-for-kratos` initContainer
- **Modify**: `k8s/observability-pod.yaml` -- add `wait-for-kratos` initContainer
- **Modify**: `RUN.md` -- document Kratos in startup order
- **Modify**: `.github/workflows/eks-e2e.yml` and `eks-e2e-full.yml` -- add Kratos startup and wait steps

## Testing

1. **Health endpoints respond**: After starting the Kratos pod:
   ```bash
   curl -sf http://localhost:4433/health/ready  # should return {"status":"ok"}
   curl -sf http://localhost:4433/health/alive   # should return {"status":"ok"}
   ```

2. **Kratos tolerates late Postgres**: Start Kratos pod before Postgres. The `wait-for-postgres` initContainer should block. Then start Postgres -- Kratos should proceed through migration and become healthy.

3. **Apps tolerate late Kratos**: Start apps-pod before Kratos. The `wait-for-kratos` initContainer should block. Then start Kratos -- the apps pod should proceed and auth middleware should work.

4. **Kratos independent restart**: With all pods running:
   ```bash
   podman kube down k8s/ory-kratos-pod.yaml
   podman kube play k8s/ory-kratos-pod.yaml
   ```
   After Kratos restarts, verify:
   - Auth-protected routes (`/grafana`, `/airflow`) work again
   - The weather-api session validation resumes
   - Existing user sessions are preserved (Kratos stores sessions in Postgres, which was not restarted)

5. **Login flow works end-to-end**: Navigate to `https://localhost:8443/`, trigger a login via Kratos, and verify the session is established.

6. **CI e2e passes**: Run the full e2e workflow and confirm all tests pass with the new startup ordering.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| initContainer images (`postgres:17-alpine`, `curlimages/curl`) add image pull time | These are small images (~80 MB, ~10 MB) and are typically cached after the first pull. |
| Kratos migration takes longer than expected | The `wait-for-postgres` timeout is 60 seconds (30 iterations x 2 seconds). Kratos migration against an existing schema is fast (<5 seconds). |
| Adding initContainers to apps-pod and observability-pod increases startup time | The wait is only active when Kratos is not yet ready. When Kratos is already running (the common case), the curl check succeeds immediately. |
| `host.containers.internal` resolution may fail in some environments | This is already used by all pods and is a known-working pattern in this project. Document it as a requirement. |
| The `ory-kratos-init` sidecar starts concurrently with `ory-kratos` and may try to call the admin API before it is ready | This is an existing issue, not introduced by this change. The init container likely retries internally. If not, add a health check loop to its startup script. |

## Dependencies

- **Separate Postgres stack** (`plan-separate-postgres-stack.md`): Should be implemented first or simultaneously. Both plans share the `wait-for-postgres` initContainer pattern.
- **Lifecycle scripts** (`plan-lifecycle-scripts.md`): Would automate the startup order documented here.
- **No blockers**: The Kratos pod already exists as a separate manifest. This plan formalizes what is already partially in place.

## Estimated Complexity

**Medium** -- Changes span 5 files but are all configuration-level (YAML edits, no application code). The main effort is in testing the initContainer wait patterns across different startup orderings.

# Plan: Nx Targets for Kube Play/Down

## Goal

Standardize all Podman `kube play` / `kube play --down` operations as Nx targets with proper `dependsOn` ordering, so the entire stack can be brought up or torn down with a single `nx run-many` command, and CI workflows can reference Nx targets instead of ad-hoc shell scripts.

## Current State

Several projects already have `kube-up` and `kube-down` targets, but coverage is inconsistent and dependency ordering is only partially modeled:

| Project | Has `kube-up` | Has `kube-down` | Has `dependsOn` | K8s manifest |
|---------|:---:|:---:|:---:|---|
| `shell` | Yes | Yes | Yes (postgres, ory, traefik, weather-api, self podman-build) | `k8s/apps-pod.yaml` (also postgres-pod, ory-kratos-pod) |
| `kafka` | Yes | Yes | Yes (podman-build) | `k8s/kafka-pod.yaml` |
| `datascience` | Yes | Yes | Yes (podman-build, sync-files) | `k8s/datascience-pod.yaml` |
| `observability` | Yes | Yes | Yes (podman-build) | `k8s/observability-pod.yaml` |
| `postgres` | **No** | **No** | N/A | `k8s/postgres-pod.yaml` |
| `ory` | **No** | **No** | N/A | `k8s/ory-kratos-pod.yaml` |
| `traefik` | **No** | **No** | N/A | N/A (Traefik runs inside the apps pod) |
| `weather-api` | Has `podman-up/down` (standalone container, not kube) | | N/A | Runs inside the apps pod |

**Problems with current approach:**

1. `shell:kube-up` is a monolithic target that handles postgres, ory-kratos, AND apps pods in sequence via inline shell commands. This means `postgres` and `ory` are not independently deployable via Nx.
2. The CI workflows (`eks-e2e.yml`, `eks-e2e-full.yml`) call `npx nx kube-up shell` which triggers the monolithic target. If any step fails, the error is buried in a multi-command output.
3. There is no way to bring up just postgres + ory without also bringing up the apps pod.
4. Teardown order in `shell:kube-down` is hardcoded (apps, ory, postgres) and does not account for kafka/datascience/observability.

## Implementation Steps

### 1. Add `kube-up` and `kube-down` to `postgres` project

Edit `apps/postgres/project.json`:

```json
"kube-up": {
  "executor": "nx:run-commands",
  "options": {
    "command": "podman play kube k8s/postgres-pod.yaml",
    "cwd": "{workspaceRoot}"
  },
  "dependsOn": ["podman-build"]
},
"kube-down": {
  "executor": "nx:run-commands",
  "options": {
    "command": "podman play kube k8s/postgres-pod.yaml --down || true",
    "cwd": "{workspaceRoot}"
  }
},
"wait-ready": {
  "executor": "nx:run-commands",
  "options": {
    "command": "i=0; until podman run --rm localhost/postgres:latest pg_isready -h host.containers.internal -p 5432 -U appuser; do i=$((i+1)); [ $i -ge 30 ] && echo 'ERROR: postgres unreachable' && exit 1; echo 'waiting for postgres...'; sleep 2; done",
    "cwd": "{workspaceRoot}"
  },
  "dependsOn": ["kube-up"]
}
```

### 2. Add `kube-up` and `kube-down` to `ory` project

Edit `apps/ory/project.json`:

```json
"kube-up": {
  "executor": "nx:run-commands",
  "options": {
    "command": "podman play kube k8s/ory-kratos-pod.yaml",
    "cwd": "{workspaceRoot}"
  },
  "dependsOn": ["podman-build", "postgres:wait-ready"]
},
"kube-down": {
  "executor": "nx:run-commands",
  "options": {
    "command": "podman play kube k8s/ory-kratos-pod.yaml --down || true",
    "cwd": "{workspaceRoot}"
  }
}
```

### 3. Add `kube-up` to `traefik` project (traefik is part of apps pod, but needs a build dep)

Traefik does not have its own pod (it runs inside the apps pod), so no kube target is needed. But ensure `traefik:podman-build` is in the dependency chain for `shell:kube-up`.

### 4. Refactor `shell:kube-up` to use Nx dependency graph

Replace the monolithic multi-command target. Edit `apps/shell/project.json`:

```json
"kube-up": {
  "executor": "nx:run-commands",
  "options": {
    "commands": [
      "for d in /var/log/traefik /var/log/nginx; do if [ -d \"$d\" ] && [ -w \"$d\" ]; then continue; fi; (mkdir -p \"$d\" 2>/dev/null || sudo mkdir -p \"$d\") && (chmod -R 777 \"$d\" 2>/dev/null || sudo chmod -R 777 \"$d\") && (command -v chcon >/dev/null && (chcon -Rt container_file_t \"$d\" 2>/dev/null || sudo chcon -Rt container_file_t \"$d\" 2>/dev/null) || true); done",
      "podman play kube k8s/apps-pod.yaml"
    ],
    "parallel": false,
    "cwd": "{workspaceRoot}"
  },
  "dependsOn": [
    "ory:kube-up",
    "traefik:podman-build",
    "weather-api:podman-build",
    "podman-build"
  ]
},
"kube-down": {
  "executor": "nx:run-commands",
  "options": {
    "command": "podman play kube k8s/apps-pod.yaml --down || true",
    "cwd": "{workspaceRoot}"
  }
}
```

Key changes:
- Postgres and Ory pod creation moved to their own projects' `kube-up` targets.
- `shell:kube-up` now only creates the apps pod.
- `dependsOn` ensures Nx runs `postgres:kube-up` -> `postgres:wait-ready` -> `ory:kube-up` -> `shell:kube-up` in the correct order.
- The `podman machine ssh` logic for macOS is removed from the inline commands and moved to a standalone helper (see step 6).

### 5. Update `kafka:kube-up` to depend on postgres

Kafka's Debezium connector needs postgres to be ready:

```json
"kube-up": {
  "executor": "nx:run-commands",
  "options": {
    "command": "podman play kube k8s/kafka-pod.yaml",
    "cwd": "{workspaceRoot}"
  },
  "dependsOn": ["podman-build", "postgres:wait-ready"]
}
```

### 6. Add a workspace-level `stack-up` and `stack-down` target

Add to `nx.json` under `targetDefaults` or create a root `project.json`:

Option A -- Use `nx run-many`:

```bash
# Full stack up (in dependency order)
npx nx run-many --target=kube-up --projects=shell,kafka,observability,datascience

# Full stack down (reverse order, parallel is fine for teardown)
npx nx run-many --target=kube-down --projects=datascience,observability,kafka,shell,ory,postgres --parallel=3
```

Option B -- Create a root project with aggregate targets. Create `project.json` at workspace root:

```json
{
  "name": "workspace",
  "targets": {
    "stack-up": {
      "executor": "nx:run-commands",
      "options": {
        "command": "echo 'Full stack is up'"
      },
      "dependsOn": [
        "shell:kube-up",
        "kafka:kube-up",
        "observability:kube-up",
        "datascience:kube-up"
      ]
    },
    "stack-down": {
      "executor": "nx:run-commands",
      "options": {
        "commands": [
          "npx nx run-many --target=kube-down --projects=datascience,observability,kafka,shell,ory,postgres --parallel=3"
        ],
        "cwd": "{workspaceRoot}"
      }
    }
  }
}
```

### 7. Simplify CI workflows

Update `.github/workflows/eks-e2e.yml` and `eks-e2e-full.yml` to replace `npx nx kube-up shell` with:

```yaml
- name: Start stack
  run: npx nx run-many --target=kube-up --projects=shell,kafka
```

And teardown:

```yaml
- name: Tear down stack
  if: always()
  run: npx nx run-many --target=kube-down --projects=kafka,shell,ory,postgres --parallel=3
```

### 8. Add a health-check pattern for other pods

Follow the `postgres:wait-ready` pattern for kafka (wait for broker) and ory (wait for Kratos health endpoint):

```json
// apps/kafka/project.json
"wait-ready": {
  "executor": "nx:run-commands",
  "options": {
    "command": "i=0; until podman exec kafka-pod-kafka kafka-broker-api-versions --bootstrap-server localhost:9092 2>/dev/null; do i=$((i+1)); [ $i -ge 30 ] && echo 'ERROR: kafka not ready' && exit 1; sleep 2; done",
    "cwd": "{workspaceRoot}"
  },
  "dependsOn": ["kube-up"]
}
```

## Files to Create/Modify

- **Modify** `apps/postgres/project.json` -- add `kube-up`, `kube-down`, `wait-ready`
- **Modify** `apps/ory/project.json` -- add `kube-up`, `kube-down`
- **Modify** `apps/shell/project.json` -- refactor `kube-up` to remove inline postgres/ory orchestration; simplify `kube-down`
- **Modify** `apps/kafka/project.json` -- add `postgres:wait-ready` to `dependsOn`
- **Modify** `apps/datascience/project.json` -- optionally add `kafka:wait-ready` to `kube-up` dependsOn (Airflow CDC DAG needs Kafka)
- **Modify** `.github/workflows/eks-e2e.yml` -- simplify kube-up/down steps
- **Modify** `.github/workflows/eks-e2e-full.yml` -- simplify kube-up/down steps
- **Optionally create** root `project.json` -- `stack-up` / `stack-down` aggregate targets

## Testing

1. **Dependency graph**: Run `npx nx graph` and visually verify the dependency chain: `postgres:podman-build` -> `postgres:kube-up` -> `postgres:wait-ready` -> `ory:kube-up` -> `shell:kube-up`.
2. **Incremental bring-up**: Run `npx nx kube-up postgres` alone, verify the postgres pod starts. Then `npx nx kube-up ory`, verify ory-kratos connects to postgres.
3. **Full stack**: Run `npx nx kube-up shell` and verify all pods come up in order.
4. **Teardown**: Run `npx nx kube-down shell` and verify only the apps pod goes down (not postgres/ory). Then `npx nx run-many --target=kube-down --all` to tear down everything.
5. **CI dry run**: Push a branch that modifies the CI workflow and verify the e2e job runs the new kube-up/down commands.
6. **Idempotency**: Run `npx nx kube-up shell` twice -- second run should either no-op or gracefully handle already-running pods.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Breaking the monolithic `shell:kube-up` may break CI if the refactor has a dependency ordering bug | Test locally with `--dry-run` first; keep the old target commented out until the new one is verified |
| `postgres:wait-ready` adds ~30s timeout to the critical path | Postgres usually starts in <5s; the 30-iteration loop is a safety net, not the expected path |
| Root `project.json` may conflict with Nx workspace detection | Nx supports root project.json -- verify with `npx nx show project workspace` |
| Some developers may still run `podman play kube` directly | Document in CLAUDE.md that `nx kube-up <project>` is the preferred method |
| The `podman machine ssh` macOS logic is removed from shell:kube-up | Move it to a separate `setup-volumes` target or a prerequisite script; document the macOS-specific step |

## Dependencies

- None required before this work.
- **Enables**: `plan-playwright-test-fixtures.md` -- once `kube-up` targets are granular, the Playwright seed script can programmatically bring up just the API layer for seeding.

## Estimated Complexity

**Medium** -- mostly project.json edits and CI workflow updates. The main risk is ensuring the dependency ordering is correct across all environments (macOS Podman machine, Linux rootless Podman, CI).

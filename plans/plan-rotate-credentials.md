# Plan: Rotate Hardcoded Credentials

## Goal

Replace all hardcoded passwords, secrets, and credentials in pod manifests, config files, and init scripts with environment-variable references backed by a `.env` file and Podman secrets, eliminating secret sprawl and enabling safe rotation.

## Current State

Every credential in this repo is hardcoded in plain text, committed to Git:

| Secret | Value | Files |
|--------|-------|-------|
| PostgreSQL password | `apppassword` | `k8s/postgres-pod.yaml` (line 20), `k8s/apps-pod.yaml` (line 16), `k8s/ory-kratos-pod.yaml` (lines 14, 30), `k8s/kafka-pod.yaml` (line 135), `k8s/observability-pod.yaml` (line 84), `apps/ory/kratos.yml` (line 3), `apps/weather-api/appsettings.json` (line 13), `apps/kafka/debezium-init/register-connector.sh` (line 33), `apps/kafka/slot-guard/slot-guard.sh` (line 8) |
| PostgreSQL user | `appuser` | Same files as above |
| Grafana admin password | `admin` | `k8s/observability-pod.yaml` (line 28) |
| Airflow webserver secret key | `datascience-dev-key` | `k8s/datascience-pod.yaml` (line 26) |
| Airflow admin password | `admin` | `k8s/datascience-pod.yaml` (line 34) |
| MinIO root user/password | `minioadmin`/`minioadmin` | `k8s/datascience-pod.yaml` (lines 83-85) |
| Kratos cookie secret | `CHANGE-ME-COOKIE-SECRET-32-CHARS!!` | `apps/ory/kratos.yml` (line 81) |
| Kratos cipher secret | `CHANGE-ME-CIPHER-SECRET-32-CHARS` | `apps/ory/kratos.yml` (line 83) |
| Kratos seed users | `Admin1234!`, `WeatherAdmin1234!` | `apps/ory/init-users.sh` (lines 59-60) |
| Kafka cluster ID | `MkU3OEVBNTcwNTJENDM2Qk` | `k8s/kafka-pod.yaml` (line 42) |

There is no `.env` file, no `.env.example`, no `.gitignore` entry for `.env`, and no secret scanning in CI or pre-commit hooks.

## Implementation Steps

### 1. Design the `.env` file schema

Create a single `.env` file at the repo root with all secrets:

```env
# PostgreSQL
POSTGRES_DB=appdb
POSTGRES_USER=appuser
POSTGRES_PASSWORD=apppassword

# Grafana
GF_SECURITY_ADMIN_PASSWORD=admin

# Airflow
AIRFLOW_SECRET_KEY=datascience-dev-key
AIRFLOW_ADMIN_USER=admin
AIRFLOW_ADMIN_PASSWORD=admin

# MinIO
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin

# Kratos
KRATOS_COOKIE_SECRET=CHANGE-ME-COOKIE-SECRET-32-CHARS!!
KRATOS_CIPHER_SECRET=CHANGE-ME-CIPHER-SECRET-32-CHARS
KRATOS_SEED_ADMIN_PASSWORD=Admin1234!
KRATOS_SEED_WEATHERADMIN_PASSWORD=WeatherAdmin1234!

# Kafka
KAFKA_CLUSTER_ID=MkU3OEVBNTcwNTJENDM2Qk
```

### 2. Create `.env.example` with placeholder values

Create `.env.example` at the repo root identical to the above but with placeholder values like `change-me-postgres-password`. This file gets committed; `.env` does not.

### 3. Add `.env` to `.gitignore`

Add the following to `.gitignore`:

```
# Secrets
.env
.env.local
.env.*.local
```

### 4. Update pod manifests to use environment variable substitution

Podman kube play supports `--env-file` but does not do variable substitution inside YAML. Two approaches:

**Option A (recommended): envsubst wrapper script**

Create `scripts/kube-play.sh` that runs `envsubst` on each pod YAML before piping to `podman kube play`:

```bash
#!/usr/bin/env bash
set -euo pipefail
source .env
for manifest in k8s/*-pod.yaml; do
  envsubst < "$manifest" | podman kube play -
done
```

Update each pod manifest to use `${VARIABLE}` syntax, e.g. in `k8s/postgres-pod.yaml`:
```yaml
- name: POSTGRES_PASSWORD
  value: "${POSTGRES_PASSWORD}"
```

**Option B: Podman secrets**

For each secret, create a Podman secret:
```bash
echo -n "$POSTGRES_PASSWORD" | podman secret create postgres-password -
```

Then reference in pod YAML (requires Podman 4.0+):
```yaml
env:
  - name: POSTGRES_PASSWORD
    valueFrom:
      secretKeyRef:
        name: postgres-password
```

Option A is simpler and works with all Podman versions. Option B is more secure (secrets are not visible via `podman inspect`). Recommend starting with Option A, migrating to Option B later.

### 5. Update config files that embed credentials

- **`apps/ory/kratos.yml`**: Replace the `dsn` value and `secrets` block with `${VARIABLE}` references (processed by envsubst before container build or at runtime via entrypoint).
- **`apps/weather-api/appsettings.json`**: This is a .NET config file. The pod manifest already overrides `ConnectionStrings__DefaultConnection` via env var (line 16 of `k8s/apps-pod.yaml`), so the appsettings value is only used in local `dotnet run`. Document that local dev should set the env var or use `dotnet user-secrets`.
- **`apps/kafka/debezium-init/register-connector.sh`**: Replace hardcoded `"database.password": "apppassword"` with `"database.password": "${POSTGRES_PASSWORD}"` and ensure the env var is passed to the container.
- **`apps/kafka/slot-guard/slot-guard.sh`**: Already reads from `$PGPASSWORD` env var with a fallback default. Remove the fallback default so it fails fast if the env var is missing.

### 6. Update `apps/ory/init-users.sh`

Replace hardcoded passwords on lines 59-60 with environment variable references:
```bash
create_identity "admin@example.com" "${KRATOS_SEED_ADMIN_PASSWORD}" "admin"
create_identity "weatheradmin@example.com" "${KRATOS_SEED_WEATHERADMIN_PASSWORD}" "weather_admin"
```

Pass these env vars through the pod manifest.

### 7. Install gitleaks as a pre-commit hook

Add a `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.21.2
    hooks:
      - id: gitleaks
```

And a `.gitleaks.toml` to allowlist known non-secret patterns:

```toml
[allowlist]
description = "Known safe patterns"
paths = [
  '''.env.example''',
  '''package-lock.json''',
]
```

### 8. Add gitleaks to GitHub Actions CI

Add a new job to `.github/workflows/ci.yml`:

```yaml
secret-scan:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v6
      with:
        fetch-depth: 0
    - uses: gitleaks/gitleaks-action@v2
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### 9. Set up GitHub Actions secrets for CI/CD

If any workflow (e.g., `eks-e2e.yml`) needs credentials at deploy time, store them as GitHub Actions secrets:
- `POSTGRES_PASSWORD`
- `KRATOS_COOKIE_SECRET`
- `KRATOS_CIPHER_SECRET`
- `MINIO_ROOT_PASSWORD`

Reference via `${{ secrets.POSTGRES_PASSWORD }}` in workflow files.

### 10. Generate strong default secrets for fresh clones

Add a `scripts/generate-env.sh` that creates `.env` from `.env.example` with randomly generated passwords:

```bash
#!/usr/bin/env bash
cp .env.example .env
sed -i "s/change-me-postgres-password/$(openssl rand -base64 24)/" .env
# ... repeat for each secret
```

## Files to Create/Modify

**Create:**
- `.env.example` -- committed template with placeholder values
- `.gitleaks.toml` -- gitleaks configuration and allowlist
- `.pre-commit-config.yaml` -- pre-commit hook configuration
- `scripts/kube-play.sh` -- envsubst wrapper for pod manifests
- `scripts/generate-env.sh` -- generates `.env` with random secrets

**Modify:**
- `.gitignore` -- add `.env` patterns
- `k8s/postgres-pod.yaml` -- replace hardcoded password with `${POSTGRES_PASSWORD}`
- `k8s/apps-pod.yaml` -- replace hardcoded connection string with variable references
- `k8s/ory-kratos-pod.yaml` -- replace hardcoded DSN with variable references
- `k8s/kafka-pod.yaml` -- replace hardcoded `PGPASSWORD` and cluster ID
- `k8s/observability-pod.yaml` -- replace Grafana password and postgres-exporter DSN
- `k8s/datascience-pod.yaml` -- replace Airflow, MinIO secrets with variable references
- `apps/ory/kratos.yml` -- replace DSN and secrets block with variable references
- `apps/ory/init-users.sh` -- replace hardcoded seed user passwords
- `apps/kafka/debezium-init/register-connector.sh` -- replace hardcoded DB password
- `apps/kafka/slot-guard/slot-guard.sh` -- remove fallback default password
- `.github/workflows/ci.yml` -- add gitleaks secret scanning job

## Testing

1. **Fresh clone test**: Clone the repo, run `scripts/generate-env.sh`, verify `.env` is created with random values.
2. **Kube play test**: Run `scripts/kube-play.sh` and verify all pods start successfully with envsubst-expanded credentials.
3. **Connectivity test**: Verify weather-api can connect to Postgres, Kratos can migrate, Debezium connector registers, Grafana/Airflow login works.
4. **Gitleaks test**: Attempt to commit a file with a hardcoded password and verify the pre-commit hook blocks it.
5. **CI test**: Push a PR and verify the `secret-scan` job passes (no leaked secrets in the cleaned-up codebase).
6. **Rotation test**: Change `POSTGRES_PASSWORD` in `.env`, restart all pods, verify everything reconnects.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| envsubst breaks YAML if variables contain special characters (`$`, `{`, etc.) | Use `.env` values that are alphanumeric + basic symbols. Document escaping rules. |
| Existing Git history still contains all secrets | After migration, rotate ALL credentials to new values. Add a note to SUMMARY.md that pre-rotation history contains leaked secrets. Consider `git-filter-repo` if the repo is not widely forked. |
| Developers forget to create `.env` before running `kube-play.sh` | Script checks for `.env` existence and exits with a helpful message pointing to `scripts/generate-env.sh`. |
| `.env` accidentally committed despite `.gitignore` | gitleaks pre-commit hook catches `.env` file contents. CI gitleaks job provides a second safety net. |
| envsubst replaces unintended `$VARIABLE` patterns in YAML | Use `envsubst` with an explicit variable list: `envsubst '$POSTGRES_PASSWORD $POSTGRES_USER ...'` |

## Dependencies

- **None required first**, but this plan pairs well with:
  - **plan-tls-certificate-management.md** -- TLS cert paths could also be externalized
  - Any future "deploy to EKS" plan would need these secrets in a real secret manager (AWS Secrets Manager, etc.)

## Estimated Complexity

**Large** -- Touches 12+ files across every pod manifest, multiple config files, and CI. Requires careful coordination to avoid breaking the local dev workflow. Recommend implementing in stages: (1) `.env` + `.gitignore` + `.env.example`, (2) pod manifest updates one pod at a time, (3) gitleaks hooks, (4) CI integration.

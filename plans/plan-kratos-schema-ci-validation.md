# Plan: Kratos Identity Schema CI Validation

## Goal

Add automated validation of the Ory Kratos identity schema and configuration to CI so that schema errors, invalid Kratos config, and broken migrations are caught before merge rather than at runtime.

## Current State

- **Identity schema**: `apps/ory/identity.schema.json` -- a JSON Schema (draft-07) defining the `Person` identity with `email` (required, password identifier) and `role` (enum: `admin`, `weather_admin`) traits.
- **Kratos config**: `apps/ory/kratos.yml` -- references the schema at `file:///etc/config/kratos/identity.schema.json`, configures DSN, selfservice flows, secrets, and courier.
- **Init script**: `apps/ory/init-users.sh` -- seeds two identities (`admin@example.com` with role `admin`, `weatheradmin@example.com` with role `weather_admin`) using the Kratos admin API.
- **Pod manifest**: `k8s/ory-kratos-pod.yaml` -- runs `kratos migrate sql --yes` as an init container before starting the Kratos server.
- **CI workflows**: `.github/workflows/ci.yml` has `build` and `unit-tests` jobs for Angular and .NET projects. There is no validation of Kratos config, identity schemas, or migration health.

### What can go wrong today (undetected until runtime)

1. A typo in `identity.schema.json` (e.g., removing `"identifier": true` from the email trait) would silently break login.
2. An invalid `kratos.yml` (e.g., malformed DSN, unknown config key) would crash the Kratos container on startup.
3. A schema change that conflicts with existing identities would cause migration failures (discovered only when running `kratos migrate sql`).
4. Adding a new required trait without updating `init-users.sh` would cause seed user creation to fail silently.

## Implementation Steps

### 1. Validate `identity.schema.json` as valid JSON Schema

Use `ajv-cli` (already in the npm ecosystem) to validate that the identity schema is itself a valid JSON Schema draft-07 document:

```bash
npx ajv validate --spec=draft7 -s apps/ory/identity.schema.json
```

Alternatively, use `check-jsonschema` (Python-based) which can validate a schema against the JSON Schema meta-schema:

```bash
pip install check-jsonschema
check-jsonschema --check-metaschema apps/ory/identity.schema.json
```

**Recommendation**: Use `ajv-cli` since the project is already Node.js-based and it avoids adding a Python dependency to CI.

### 2. Validate Kratos config syntax with `kratos validate`

The Ory Kratos CLI has a built-in config validation command:

```bash
kratos validate config apps/ory/kratos.yml
```

This checks:
- All required config keys are present
- Values have correct types
- No unknown/deprecated keys

To avoid installing the full Kratos binary in CI, use the official Docker image:

```bash
docker run --rm -v "$PWD/apps/ory:/etc/config/kratos:ro" \
  oryd/kratos:v1.3.0 \
  validate config /etc/config/kratos/kratos.yml
```

### 3. Validate identity schema against Kratos expectations

Kratos requires specific `ory.sh/kratos` extensions in the identity schema (e.g., at least one credential identifier). Validate this with:

```bash
docker run --rm -v "$PWD/apps/ory:/etc/config/kratos:ro" \
  oryd/kratos:v1.3.0 \
  validate identity-schema /etc/config/kratos/identity.schema.json
```

### 4. Validate seed data against the schema

Write a small validation script (`scripts/validate-kratos-seed.sh`) that checks `init-users.sh` seed payloads against `identity.schema.json`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCHEMA="apps/ory/identity.schema.json"

# Extract the traits sub-schema for validation
TRAITS_SCHEMA=$(jq '.properties.traits' "$SCHEMA")

# Validate each seed identity's traits
for traits in \
  '{"email":"admin@example.com","role":"admin"}' \
  '{"email":"weatheradmin@example.com","role":"weather_admin"}' \
; do
  echo "Validating: $traits"
  echo "$traits" | npx ajv validate --spec=draft7 -s <(echo "$TRAITS_SCHEMA") -d /dev/stdin \
    || { echo "FAILED: $traits does not match schema"; exit 1; }
done

echo "All seed identities are valid."
```

### 5. Add migration dry-run testing

Test that Kratos migrations can run against a fresh PostgreSQL database:

```yaml
- name: Test Kratos migration (dry-run)
  run: |
    # Start a temporary Postgres
    docker run -d --name kratos-test-db \
      -e POSTGRES_DB=testdb \
      -e POSTGRES_USER=testuser \
      -e POSTGRES_PASSWORD=testpass \
      -p 5433:5432 \
      postgres:17

    # Wait for Postgres
    for i in $(seq 1 30); do
      docker exec kratos-test-db pg_isready -U testuser && break
      sleep 1
    done

    # Create a temporary kratos config with test DSN
    sed 's|postgres://appuser:apppassword@host.containers.internal:5432/appdb|postgres://testuser:testpass@localhost:5433/testdb|' \
      apps/ory/kratos.yml > /tmp/kratos-test.yml

    # Run migration
    docker run --rm --network=host \
      -v /tmp/kratos-test.yml:/etc/config/kratos/kratos.yml:ro \
      -v "$PWD/apps/ory/identity.schema.json:/etc/config/kratos/identity.schema.json:ro" \
      oryd/kratos:v1.3.0 \
      migrate sql --yes -c /etc/config/kratos/kratos.yml

    # Cleanup
    docker rm -f kratos-test-db
```

### 6. Add CI job to `.github/workflows/ci.yml`

```yaml
kratos-validation:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v6

    - uses: actions/setup-node@v6
      with:
        node-version: 24
        cache: 'npm'

    - run: npm ci

    # 1. Validate identity schema is valid JSON Schema
    - name: Validate identity schema (JSON Schema meta-validation)
      run: npx ajv validate --spec=draft7 --valid -s apps/ory/identity.schema.json

    # 2. Validate Kratos config
    - name: Validate Kratos config
      run: |
        docker run --rm \
          -v "$PWD/apps/ory:/etc/config/kratos:ro" \
          oryd/kratos:v1.3.0 \
          validate config /etc/config/kratos/kratos.yml

    # 3. Validate identity schema against Kratos expectations
    - name: Validate Kratos identity schema
      run: |
        docker run --rm \
          -v "$PWD/apps/ory:/etc/config/kratos:ro" \
          oryd/kratos:v1.3.0 \
          validate identity-schema /etc/config/kratos/identity.schema.json

    # 4. Validate seed data matches schema
    - name: Validate seed identities
      run: ./scripts/validate-kratos-seed.sh

    # 5. Migration dry-run against fresh Postgres
    - name: Test Kratos migration
      run: |
        docker run -d --name kratos-test-db \
          -e POSTGRES_DB=testdb \
          -e POSTGRES_USER=testuser \
          -e POSTGRES_PASSWORD=testpass \
          -p 5433:5432 \
          postgres:17

        for i in $(seq 1 30); do
          docker exec kratos-test-db pg_isready -U testuser && break
          sleep 1
        done

        sed 's|postgres://appuser:apppassword@host.containers.internal:5432/appdb|postgres://testuser:testpass@localhost:5433/testdb|' \
          apps/ory/kratos.yml > /tmp/kratos-test.yml

        docker run --rm --network=host \
          -v /tmp/kratos-test.yml:/etc/config/kratos/kratos.yml:ro \
          -v "$PWD/apps/ory/identity.schema.json:/etc/config/kratos/identity.schema.json:ro" \
          oryd/kratos:v1.3.0 \
          migrate sql --yes -c /etc/config/kratos/kratos.yml

        docker rm -f kratos-test-db
```

### 7. Add an Nx target for local validation

Add a `validate` target to `apps/ory/project.json` so developers can run validation locally:

```json
{
  "targets": {
    "validate": {
      "executor": "nx:run-commands",
      "options": {
        "commands": [
          "npx ajv validate --spec=draft7 --valid -s apps/ory/identity.schema.json",
          "podman run --rm -v ./apps/ory:/etc/config/kratos:ro oryd/kratos:v1.3.0 validate config /etc/config/kratos/kratos.yml",
          "podman run --rm -v ./apps/ory:/etc/config/kratos:ro oryd/kratos:v1.3.0 validate identity-schema /etc/config/kratos/identity.schema.json"
        ],
        "parallel": false
      }
    }
  }
}
```

Run locally with: `npx nx run ory:validate`

## Files to Create/Modify

**Create:**
- `scripts/validate-kratos-seed.sh` -- validates seed identity payloads against the schema

**Modify:**
- `.github/workflows/ci.yml` -- add `kratos-validation` job
- `apps/ory/project.json` -- add `validate` target
- `package.json` -- add `ajv-cli` as a dev dependency (if not already present)

## Testing

1. **Happy path**: Run the validation locally with `npx nx run ory:validate` -- all checks should pass with the current schema and config.
2. **Break the schema**: Temporarily remove `"identifier": true` from `identity.schema.json`, run validation -- should fail on the Kratos identity-schema check.
3. **Break the config**: Add an invalid key to `kratos.yml`, run validation -- should fail on the config check.
4. **Break seed data**: Add a required trait to the schema without updating `init-users.sh` -- seed validation should fail.
5. **CI test**: Push a PR with a valid schema change and verify the `kratos-validation` job passes.
6. **Migration test**: Verify the migration dry-run completes successfully against a fresh Postgres 17 instance.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `kratos validate config` may flag the `${VARIABLE}` placeholders after credential rotation is implemented | Run validation before envsubst, or create a CI-specific kratos config with dummy values for validation purposes. |
| Docker image pull for `oryd/kratos:v1.3.0` adds CI time | Cache the Docker image using `docker pull` + GitHub Actions cache, or pin to a specific digest. The image is ~50MB. |
| Migration dry-run adds ~30s to CI for Postgres startup | Run the migration job in parallel with other CI jobs (it has no dependencies on `build` or `unit-tests`). |
| `ajv-cli` version may have different validation behavior than Kratos's internal validator | The Kratos `validate identity-schema` command is the authoritative check; `ajv` is a belt-and-suspenders meta-schema check. |
| Kratos version in CI Docker image may drift from the version used in the pod manifest | Pin the Kratos version in both places. Consider extracting it to a shared variable (e.g., in `.env` or a Makefile variable). |

## Dependencies

- **plan-rotate-credentials.md** -- if credentials are externalized to `.env` with `${VARIABLE}` placeholders, the Kratos config validation step needs to handle unexpanded variables. Either validate before substitution (current config has real values) or maintain a separate test config.
- No hard blockers; this plan can be implemented independently.

## Estimated Complexity

**Small** -- The core implementation is a single new CI job with 3-5 validation commands, one small shell script, and a project.json update. The migration dry-run adds moderate complexity but is optional for the initial implementation. Recommend shipping schema + config validation first, then adding migration testing as a follow-up.

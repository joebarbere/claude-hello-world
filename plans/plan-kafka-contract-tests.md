# Plan: Kafka Avro Schema Contract Tests

## Goal

Add automated contract tests that verify the EF Core `WeatherForecast` and `Minion` model definitions remain compatible with the Avro schemas registered in the Confluent Schema Registry by Debezium, catching schema drift before it breaks the CDC pipeline.

## Current State

- **EF Core models**: `apps/weather-api/Models/WeatherForecast.cs` defines `Id` (int), `Date` (DateOnly), `TemperatureC` (int), `Summary` (string?). `apps/weather-api/Models/Minion.cs` defines `Id`, `Name`, `ScheduleType`, `ScheduleValue`, `IsActive`, `LastRunAt`, `CreatedAt`, `UpdatedAt`.
- **DbContext**: `apps/weather-api/Data/WeatherDbContext.cs` exposes `WeatherForecasts` and `Minions` DbSets.
- **Debezium connector**: `apps/kafka/debezium-init/register-connector.sh` registers a Postgres CDC connector with `table.include.list=public.*`, using `AvroConverter` with Schema Registry at `http://localhost:8081`. Topic prefix is `weather`, producing topics like `weather.public.WeatherForecasts`.
- **Kafka CDC DAG**: `apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py` consumes Avro messages using `confluent_kafka.schema_registry.avro.AvroDeserializer` and expects fields `Id`, `Date` (int32 days-since-epoch), `TemperatureC` (int), `Summary` (string|null) inside a Debezium envelope with `before`, `after`, `op`, `ts_ms`.
- **Existing .NET tests**: `apps/weather-api-tests/` uses xUnit with `WeatherApi.Tests.csproj` referencing `WeatherApi.csproj`. Tests cover model validation and repository behavior. CI runs them via `npx nx run weather-api-tests:test`.
- **CI pipeline**: `.github/workflows/ci.yml` runs lint, build, Angular unit tests, and .NET unit tests. No Kafka or schema-related tests exist.
- **No contract tests exist today.** A schema change in EF Core (e.g., adding a non-nullable column) would silently break Debezium's Avro serialization or the Airflow consumer.

## Implementation Steps

### 1. Create a pytest project for Kafka contract tests

Create a new directory `apps/kafka/contract-tests/` with a dedicated test suite. This is kept separate from the .NET tests because the Kafka/Avro tooling is Python-native.

Create `apps/kafka/contract-tests/requirements.txt`:

```
fastavro>=1.9.0
pytest>=8.0
pyyaml>=6.0
```

The tests will NOT require a running Schema Registry or Kafka broker. Instead, they will validate schema compatibility statically by:
- Parsing the EF Core model snapshot (from the latest migration `ModelSnapshot.cs`) to extract column definitions.
- Loading a reference Avro schema (checked into the repo) that represents the Debezium-generated schema.
- Checking compatibility rules between the two.

### 2. Create the reference Avro schema file

Create `apps/kafka/contract-tests/schemas/weather_forecasts_value.avsc`:

```json
{
  "type": "record",
  "name": "Envelope",
  "namespace": "weather.public.WeatherForecasts",
  "fields": [
    {
      "name": "before",
      "type": ["null", {
        "type": "record",
        "name": "Value",
        "fields": [
          {"name": "Id", "type": "int"},
          {"name": "Date", "type": {"type": "int", "logicalType": "date"}},
          {"name": "TemperatureC", "type": "int"},
          {"name": "Summary", "type": ["null", "string"], "default": null}
        ]
      }],
      "default": null
    },
    {
      "name": "after",
      "type": ["null", "Value"],
      "default": null
    },
    {"name": "op", "type": "string"},
    {"name": "ts_ms", "type": "long"}
  ]
}
```

Also create `apps/kafka/contract-tests/schemas/minions_value.avsc` with the corresponding Minion fields.

### 3. Create a model-snapshot parser

Create `apps/kafka/contract-tests/parse_ef_snapshot.py`:

This module parses `apps/weather-api/Migrations/WeatherDbContextModelSnapshot.cs` using regex to extract table names, column names, CLR types, and nullability annotations. The snapshot is the single source of truth for the database schema that EF Core will apply.

Key extraction patterns:
- `b.Property<TYPE>("COLUMN")` lines define columns and their CLR types.
- `.IsRequired()` indicates non-nullable.
- `.HasColumnType("TYPE")` indicates the Postgres column type.
- `b.ToTable("TABLE")` defines the table name.

Output: a dict mapping `table_name -> [{"name": str, "clr_type": str, "nullable": bool}]`.

### 4. Write the contract test assertions

Create `apps/kafka/contract-tests/test_schema_compatibility.py`:

```python
"""
Contract tests: EF Core model <-> Avro schema compatibility.

These tests verify that:
1. Every non-nullable column in the EF Core model has a corresponding
   non-null Avro field (or a field with a default value).
2. Every column in the EF Core model has a type-compatible Avro field.
3. New columns added to EF Core are nullable or have defaults in the
   Avro schema (backward compatibility).
4. No Avro field references a column that has been removed from EF Core
   (forward compatibility).
"""
import json
import pytest
from pathlib import Path
from parse_ef_snapshot import parse_snapshot

# CLR type -> compatible Avro types mapping
CLR_TO_AVRO = {
    "int": {"int"},
    "long": {"long"},
    "string": {"string"},
    "bool": {"boolean"},
    "DateTime": {"long"},       # Debezium encodes as ms-since-epoch
    "DateOnly": {"int"},        # Debezium encodes as days-since-epoch
    "decimal": {"double", "bytes"},  # depends on decimal.handling.mode
}

def test_weatherforecasts_all_columns_present_in_avro():
    """Every EF Core column must have a matching Avro field."""
    ...

def test_weatherforecasts_nullable_columns_are_avro_nullable():
    """Non-nullable EF Core columns must not be optional-only in Avro."""
    ...

def test_weatherforecasts_type_compatibility():
    """EF Core CLR types must map to compatible Avro types."""
    ...

def test_no_removed_columns_in_avro():
    """Avro schema must not reference columns removed from EF Core."""
    ...

def test_minions_schema_compatibility():
    """Same checks for the Minions table."""
    ...
```

### 5. Add an Nx project target for the contract tests

Create `apps/kafka/contract-tests/project.json` (or add a target to the existing `apps/kafka/project.json`):

```json
{
  "targets": {
    "contract-test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "python -m pytest apps/kafka/contract-tests/ -v",
        "cwd": "{workspaceRoot}"
      }
    }
  }
}
```

### 6. Add to the CI pipeline

Edit `.github/workflows/ci.yml` to add a new job:

```yaml
  kafka-contract-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install contract test dependencies
        run: pip install -r apps/kafka/contract-tests/requirements.txt

      - name: Run Kafka schema contract tests
        run: python -m pytest apps/kafka/contract-tests/ -v
```

This job has no dependencies on the build or unit-test jobs and can run in parallel.

### 7. Add a live schema validation test (optional, for local dev)

Create `apps/kafka/contract-tests/test_live_registry.py` with a `@pytest.mark.live` marker:

```python
"""
Live validation: fetch the actual registered schema from Schema Registry
and compare against the reference schema file.

Only runs when SCHEMA_REGISTRY_URL is set (skipped in CI by default).
"""
import os
import pytest
import requests

REGISTRY_URL = os.environ.get("SCHEMA_REGISTRY_URL")

@pytest.mark.live
@pytest.mark.skipif(not REGISTRY_URL, reason="SCHEMA_REGISTRY_URL not set")
def test_registered_schema_matches_reference():
    """The schema in the registry must match the checked-in reference."""
    ...
```

### 8. Document the schema update workflow

Add a comment block at the top of the reference `.avsc` files explaining:
- When to update: after any EF Core migration that changes `WeatherForecasts` or `Minions` columns.
- How to update: run the connector against a dev database, fetch the schema from `GET /subjects/weather.public.WeatherForecasts-value/versions/latest` on the Schema Registry, and replace the `.avsc` file.
- The contract tests will fail in CI if the reference schema is out of date.

## Files to Create/Modify

- **Create** `apps/kafka/contract-tests/requirements.txt`
- **Create** `apps/kafka/contract-tests/conftest.py`
- **Create** `apps/kafka/contract-tests/parse_ef_snapshot.py`
- **Create** `apps/kafka/contract-tests/test_schema_compatibility.py`
- **Create** `apps/kafka/contract-tests/test_live_registry.py`
- **Create** `apps/kafka/contract-tests/schemas/weather_forecasts_value.avsc`
- **Create** `apps/kafka/contract-tests/schemas/minions_value.avsc`
- **Modify** `apps/kafka/project.json` — add `contract-test` target
- **Modify** `.github/workflows/ci.yml` — add `kafka-contract-tests` job

## Testing

1. **Local**: Run `python -m pytest apps/kafka/contract-tests/ -v` from the workspace root. All tests should pass against the current model snapshot and reference schemas.
2. **Break it on purpose**: Add a non-nullable column to `WeatherForecast.cs`, run `dotnet ef migrations add TestBreak`, and confirm the contract tests fail because the Avro schema lacks the new field.
3. **CI**: Push a branch and verify the `kafka-contract-tests` job appears and passes in the GitHub Actions run.
4. **Live (optional)**: Start the Kafka stack locally (`nx kube-up kafka`), set `SCHEMA_REGISTRY_URL=http://localhost:8081`, and run `pytest -m live` to validate the reference schema matches the registry.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| EF Core model snapshot parsing is brittle (regex on generated C#) | The snapshot format is stable across EF Core 9.x. Pin the parser to known patterns and add a test that detects unparseable lines. |
| Reference Avro schema drifts from what Debezium actually registers | The optional live test (`test_live_registry.py`) catches this. Document the update workflow prominently. |
| Debezium's Avro encoding of .NET types is not 1:1 (e.g., `DateOnly` -> `int32` date logical type) | The `CLR_TO_AVRO` mapping table is the single place to maintain these translations. |
| Python is not available in CI | GitHub Actions `ubuntu-latest` includes Python. The `actions/setup-python` step pins the version. |

## Dependencies

- None required. This plan is self-contained.
- **Benefits from**: "Add location to WeatherForecast" (IDEAS.md) — when new columns are added, these contract tests will immediately verify Avro compatibility, demonstrating their value.
- **Benefits from**: "Ory Kratos identity schema validation in CI" (IDEAS.md) — same pattern of schema validation in CI; the two efforts share infrastructure knowledge.

## Estimated Complexity

**Small** — No running infrastructure required for the core tests. The main effort is writing the EF Core snapshot parser and the reference Avro schemas. Estimated 2-4 hours of implementation.

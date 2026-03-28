# Plan: DAG Development Hot-Reload and Linting

## Goal

Add a fast feedback loop for Airflow DAG development: automatic linting on save, pre-commit enforcement, pytest coverage for shared helpers, and editor integration so Python issues are caught before they reach the Airflow scheduler.

## Current State

- **3 DAG files** in `apps/datascience/airflow/dags/`: `dag_download_weather.py`, `dag_kafka_cdc_to_duckdb.py`, `dag_quality_report.py`.
- **2 shared helper modules** in `apps/datascience/shared/`: `minio_helper.py` and `weather_sources.py`. DAGs add the `dags/shared/` subdirectory to `sys.path` at import time; the sync script (`scripts/sync-datascience.sh`) copies `apps/datascience/shared/` into the host path the container mounts.
- **No Python linting config** exists anywhere in the repo (no `.flake8`, `pyproject.toml [tool.ruff]`, `pylintrc`, etc.).
- **No pre-commit hooks** -- `.pre-commit-config.yaml` does not exist.
- **No pytest tests** for the shared helpers or DAG structure.
- **No editor integration** for Python quality (no `.vscode/settings.json` Python section, no `pyrightconfig.json`).
- The Airflow container (`apps/datascience/airflow/Containerfile`) is based on `apache/airflow:slim-2.10.4-python3.11` and installs `duckdb`, `minio`, `pandas`, `confluent-kafka`, etc.
- DAG files are synced to `/tmp/datascience/airflow/dags/` via `scripts/sync-datascience.sh`, which is wired as the Nx target `datascience:sync-files`.

## Implementation Steps

### 1. Add Python linting with Ruff (replaces flake8 + pylint)

Ruff is a single fast linter/formatter that subsumes flake8, pylint, isort, and black. It is a better fit than flake8+pylint because it is a single dependency, runs in milliseconds, and has first-class `pyproject.toml` support.

Add a `[tool.ruff]` section to the workspace root `pyproject.toml` (create the file if needed):

```toml
# pyproject.toml (workspace root)
[tool.ruff]
target-version = "py311"
line-length = 120
src = ["apps/datascience"]

[tool.ruff.lint]
select = [
    "E",     # pycodestyle errors
    "W",     # pycodestyle warnings
    "F",     # pyflakes
    "I",     # isort
    "N",     # pep8-naming
    "UP",    # pyupgrade
    "B",     # flake8-bugbear
    "ANN",   # flake8-annotations (warnings only)
    "S",     # flake8-bandit (security)
    "AIR",   # airflow-specific rules
]
ignore = [
    "ANN101",  # missing self annotation
    "ANN102",  # missing cls annotation
    "S101",    # allow assert in tests
]

[tool.ruff.lint.per-file-ignores]
"apps/datascience/airflow/dags/*.py" = ["ANN"]  # DAGs don't need full annotations
"tests/**/*.py" = ["S101", "ANN"]

[tool.ruff.format]
quote-style = "double"
```

### 2. Add an Nx `lint-python` target to the datascience project

Edit `apps/datascience/project.json` to add:

```json
"lint-python": {
  "executor": "nx:run-commands",
  "options": {
    "commands": [
      "ruff check apps/datascience/",
      "ruff format --check apps/datascience/"
    ],
    "cwd": "{workspaceRoot}"
  }
}
```

### 3. Add a `fix-python` convenience target

```json
"fix-python": {
  "executor": "nx:run-commands",
  "options": {
    "commands": [
      "ruff check --fix apps/datascience/",
      "ruff format apps/datascience/"
    ],
    "cwd": "{workspaceRoot}"
  }
}
```

### 4. Create pre-commit hooks

Create `.pre-commit-config.yaml` at the workspace root:

```yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.8.6
    hooks:
      - id: ruff
        args: [--fix]
        types_or: [python]
      - id: ruff-format
        types_or: [python]

  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: check-yaml
      - id: end-of-file-fixer
      - id: trailing-whitespace
      - id: check-added-large-files
        args: [--maxkb=500]

  - repo: local
    hooks:
      - id: dag-import-check
        name: Verify DAG files parse without import errors
        entry: python -c "import py_compile, sys; [py_compile.compile(f, doraise=True) for f in sys.argv[1:]]"
        language: system
        files: 'apps/datascience/airflow/dags/dag_.*\.py$'
        types: [python]
```

### 5. Add pytest for shared helpers

Create a test directory and initial tests:

- `apps/datascience/tests/__init__.py`
- `apps/datascience/tests/conftest.py` -- fixtures for mocking MinIO client
- `apps/datascience/tests/test_minio_helper.py` -- test `object_exists`, `ensure_bucket`, `upload_file` with mocked Minio client
- `apps/datascience/tests/test_dag_integrity.py` -- test that each DAG file parses without errors and has the expected `dag_id`

Example `test_minio_helper.py`:

```python
from unittest.mock import MagicMock, patch
import pytest
from minio.error import S3Error

# Add shared dir to path the same way DAGs do
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "shared"))

from minio_helper import object_exists, ensure_bucket


def test_object_exists_returns_true_when_present():
    client = MagicMock()
    client.stat_object.return_value = MagicMock()
    assert object_exists(client, "bucket", "key") is True


def test_object_exists_returns_false_for_no_such_key():
    client = MagicMock()
    err = S3Error("NoSuchKey", "not found", "", "", "", "")
    client.stat_object.side_effect = err
    assert object_exists(client, "bucket", "key") is False


def test_ensure_bucket_creates_when_missing():
    client = MagicMock()
    client.bucket_exists.return_value = False
    ensure_bucket(client, "new-bucket")
    client.make_bucket.assert_called_once_with("new-bucket")
```

Example `test_dag_integrity.py`:

```python
import importlib.util
import os
import pytest

DAG_DIR = os.path.join(os.path.dirname(__file__), "..", "airflow", "dags")

DAG_FILES = [f for f in os.listdir(DAG_DIR) if f.startswith("dag_") and f.endswith(".py")]


@pytest.mark.parametrize("dag_file", DAG_FILES)
def test_dag_file_compiles(dag_file):
    """Each DAG file should compile without syntax errors."""
    path = os.path.join(DAG_DIR, dag_file)
    spec = importlib.util.spec_from_file_location(dag_file, path)
    # We only check compilation, not execution (which needs Airflow + MinIO)
    import py_compile
    py_compile.compile(path, doraise=True)
```

Add an Nx target:

```json
"test-python": {
  "executor": "nx:run-commands",
  "options": {
    "command": "python -m pytest apps/datascience/tests/ -v --tb=short",
    "cwd": "{workspaceRoot}"
  }
}
```

### 6. DAG hot-reload via file watcher

The current workflow requires running `nx run datascience:sync-files` after every DAG edit. Add a `watch` target that uses `inotifywait` or `watchexec` to auto-sync:

```json
"dag-watch": {
  "executor": "nx:run-commands",
  "options": {
    "command": "watchexec -w apps/datascience/airflow/dags -w apps/datascience/shared -- bash scripts/sync-datascience.sh",
    "cwd": "{workspaceRoot}"
  },
  "continuous": true
}
```

If `watchexec` is not available, fall back to:

```bash
while inotifywait -r -e modify,create,delete apps/datascience/airflow/dags apps/datascience/shared; do
  bash scripts/sync-datascience.sh
done
```

Airflow's built-in DAG file processor (default 30s interval) will pick up changes automatically after sync.

### 7. Editor integration

Create/update `.vscode/settings.json` to include:

```json
{
  "[python]": {
    "editor.defaultFormatter": "charliermarsh.ruff",
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": {
      "source.fixAll.ruff": "explicit",
      "source.organizeImports.ruff": "explicit"
    }
  },
  "python.analysis.extraPaths": [
    "apps/datascience/shared"
  ]
}
```

Add `.vscode/extensions.json`:

```json
{
  "recommendations": [
    "charliermarsh.ruff",
    "ms-python.python"
  ]
}
```

### 8. Add lint-python to CI

In `.github/workflows/ci.yml`, add a step to the `build` job (or a new `python-lint` job):

```yaml
  python-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: pip install ruff pytest minio pandas
      - run: ruff check apps/datascience/
      - run: ruff format --check apps/datascience/
      - run: python -m pytest apps/datascience/tests/ -v --tb=short
```

## Files to Create/Modify

- **Create** `pyproject.toml` (workspace root) -- Ruff config
- **Create** `.pre-commit-config.yaml` -- pre-commit hook definitions
- **Create** `apps/datascience/tests/__init__.py`
- **Create** `apps/datascience/tests/conftest.py`
- **Create** `apps/datascience/tests/test_minio_helper.py`
- **Create** `apps/datascience/tests/test_dag_integrity.py`
- **Modify** `apps/datascience/project.json` -- add `lint-python`, `fix-python`, `test-python`, `dag-watch` targets
- **Modify** `.github/workflows/ci.yml` -- add `python-lint` job
- **Create or modify** `.vscode/settings.json` -- Python editor config
- **Create** `.vscode/extensions.json` -- recommended extensions
- **Modify** DAG and shared helper files -- fix any issues Ruff finds on first run

## Testing

1. **Ruff**: Run `ruff check apps/datascience/ && ruff format --check apps/datascience/` -- should pass with zero errors after initial fix-up.
2. **Pre-commit**: Run `pre-commit run --all-files` -- all hooks should pass.
3. **Pytest**: Run `python -m pytest apps/datascience/tests/ -v` -- all tests pass.
4. **Hot-reload**: Start `nx run datascience:dag-watch`, edit a DAG file, verify the change appears in `/tmp/datascience/airflow/dags/` within a few seconds.
5. **CI**: Push a branch and verify the `python-lint` job runs green.
6. **Editor**: Open a DAG file in VS Code, introduce a lint error, verify the squiggly underline appears immediately.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Existing DAG code has many Ruff violations, making the initial PR noisy | Run `ruff check --fix` and `ruff format` in a single preparatory commit; review auto-fixes before merging |
| `pyproject.toml` may conflict with other tools if one is added later (e.g., Poetry) | Keep `[tool.ruff]` section only; do not add `[build-system]` unless needed |
| `watchexec` not installed on all dev machines | Document installation (`cargo install watchexec-cli` or `dnf install watchexec`) and provide the `inotifywait` fallback |
| Pre-commit hooks slow down commits | Ruff runs in <100ms for this codebase; the DAG compile check is also fast. Total overhead should be <1s |
| DAG integrity test imports Airflow, which is heavy | Use `py_compile` (syntax check only) rather than full import to avoid needing Airflow installed on the host |

## Dependencies

- None strictly required before this work.
- **Benefits from**: `plan-nx-kube-targets.md` -- once kube targets are standardized, the `dag-watch` target could optionally restart the datascience pod after sync.

## Estimated Complexity

**Medium** -- mostly configuration files and a few small test files. The main effort is the initial Ruff fix-up pass on existing code.

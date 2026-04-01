# Vulnerability Report: apps/kafka/slot-guard/slot-guard.sh

## HIGH: Hardcoded Database Password as Default Value

**CWE:** CWE-259

**Description:** `export PGPASSWORD="${PGPASSWORD:-apppassword}"` — default password exported to process environment, visible in `/proc/<pid>/environ`.

---

## MEDIUM: SQL Injection via Unparameterized LAG_THRESHOLD_BYTES

**CWE:** CWE-89 — SQL Injection

**Description:**
`${LAG_THRESHOLD_BYTES}` interpolated directly into SQL passed to `psql -c`. If the variable is attacker-controlled, arbitrary SQL execution is possible.

**Exploitation Steps:**
Set `LAG_THRESHOLD_BYTES` to `0; SELECT pg_read_file('/etc/passwd');--`

**Remediation:**
```sh
if ! [[ "${LAG_THRESHOLD_BYTES}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: LAG_THRESHOLD_BYTES must be a non-negative integer"
  exit 1
fi
```

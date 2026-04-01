# VULN-015: Promtail Mounts Entire /var/log and /var/lib/containers from Host

**Severity:** MEDIUM
**CWE:** CWE-732 — Incorrect Permission Assignment for Critical Resource

## Description

The observability pod mounts two broad host directories into the Promtail container:

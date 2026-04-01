# Vulnerability Report: apps/admin-app/src/app/minions/minions.component.ts

## MEDIUM: No Validation of Cron Expression Before Submission

**CWE:** CWE-20 — Improper Input Validation

**Description:**
Free-text cron expression accepted without client-side validation. Potential command injection or ReDoS if backend naively processes the expression.

**Remediation:** Add strict cron regex validation before form submission. Backend must also validate.

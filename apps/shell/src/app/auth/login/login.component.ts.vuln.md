# Vulnerability Report: apps/shell/src/app/auth/login/login.component.ts

## MEDIUM: Login Form Action Taken from Server Response Without Validation

**CWE:** CWE-346 — Origin Validation Error

**Description:**
`<form>` binds `action` and `method` directly from Kratos flow API response. A MITM could change `ui.action` to redirect credential submission to an attacker's endpoint.

**Impact:** Full credential theft via form hijacking.

**Remediation:** Validate `flow.ui.action` starts with `/.ory/kratos` before binding.

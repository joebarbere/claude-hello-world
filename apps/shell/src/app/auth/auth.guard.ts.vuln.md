# Vulnerability Report: apps/shell/src/app/auth/auth.guard.ts

## HIGH: Auth Guards Are Client-Side Only — Multiple Routes Unguarded

**CWE:** CWE-602 — Client-Side Enforcement of Server-Side Security

**Description:**
Angular route guards are UX controls only — trivially bypassed by direct HTTP requests. `weather-app` route has no `canActivate` guard. `weatherstream-app` is not in shell routes at all.

**Impact:** False security assumption. Unauthorized access to streaming data if backend doesn't enforce auth (which it doesn't for GET requests).

**Remediation:** Document that guards are UX only. Ensure backend enforces auth on all endpoints.

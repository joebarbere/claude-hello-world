# Vulnerability Report: apps/shell/src/app/auth/auth.service.ts

## HIGH: Open Redirect via Unvalidated `return_to` Query Parameter

**CWE:** CWE-601 — Open Redirect

**Description:**
`initiateLogin()` passes caller-supplied `returnTo` to Kratos login URL without origin validation. `LoginComponent` reads `return_to` directly from query string.

**Exploitation Steps:**
1. Craft: `https://localhost:8443/auth/login?return_to=https://evil.example.com`
2. Victim logs in normally, gets redirected to attacker's site after successful auth.

**Impact:** Phishing amplification, session token theft, credential harvesting in high-trust login context.

---

## MEDIUM: Open Redirect via Unvalidated `logout_url`

**CWE:** CWE-601

**Description:**
`logout()` redirects to `flow.logout_url` from Kratos response without origin validation. A MITM could redirect users to a phishing page after logout.

**Remediation:** Validate both `return_to` and `logout_url` are same-origin before redirecting.

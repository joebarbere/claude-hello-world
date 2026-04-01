# Vulnerability Report: .github/workflows/dependency-check.yml

## MEDIUM: Third-Party Action Pinned to @main Branch — Supply Chain Risk

**CWE:** CWE-494 — Download of Code Without Integrity Check

**Description:**
`uses: dependency-check/Dependency-Check_Action@main` — any commit to upstream `main` executes in CI with access to all repository secrets.

**Exploitation Steps:**
Compromised upstream maintainer pushes malicious code. Next CI run exfiltrates secrets.

**Remediation:** Pin to immutable SHA: `uses: dependency-check/Dependency-Check_Action@<sha>`

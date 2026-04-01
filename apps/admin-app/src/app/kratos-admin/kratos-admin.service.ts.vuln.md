# Vulnerability Report: apps/admin-app/src/app/kratos-admin/kratos-admin.service.ts

## HIGH: Kratos Admin API Callable from Browser — Full Account Takeover via Recovery Link

**CWE:** CWE-862 — Missing Authorization

**Description:**
`KratosAdminService` routes admin operations through `/.ory/kratos/admin` with no server-side auth gate. The critical operation `generateRecoveryLink()` calls `POST /.ory/kratos/admin/admin/recovery/link` with any identity UUID, returning a magic link that grants a full session.

**Exploitation Steps:**
1. `GET /.ory/kratos/admin/admin/identities` — enumerate all identity UUIDs (no auth).
2. `POST /.ory/kratos/admin/admin/recovery/link` with any UUID.
3. Visit the returned link — instant session as that user, including admins.

**Impact:** Complete account takeover of any identity with zero user interaction.

**Remediation:** Add Traefik `forwardAuth` middleware to `/.ory/kratos/admin/*` that validates admin role.

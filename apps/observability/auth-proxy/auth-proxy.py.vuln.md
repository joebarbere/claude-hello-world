# Vulnerability Report: apps/observability/auth-proxy/auth-proxy.py

## HIGH: Open Redirect via Unvalidated X-Forwarded-Host Header

**CWE:** CWE-601 — Open Redirect

**Description:**
The `_redirect` method constructs `return_to` from attacker-controlled headers (`X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Uri`) without validation. Auth-proxy is directly reachable on `hostPort: 4180`.

**Exploitation Steps:**
```bash
curl -v http://<target>:4180/ \
  -H "X-Forwarded-Host: evil.com" \
  -H "X-Forwarded-Proto: https"
# Redirects to login with return_to=https://evil.com/...
```

---

## HIGH: MinIO Auto-Login Endpoint (Port 4181) Requires No Kratos Authentication

**CWE:** CWE-306, CWE-522

**Description:**
`MinioLoginHandler` on port 4181 mints MinIO root session cookies for ANY HTTP GET request — no Kratos session check. Uses hardcoded `minioadmin/minioadmin` credentials.

**Exploitation Steps:**
```bash
curl -v http://localhost:4181/
# Returns Set-Cookie with MinIO admin session JWT
```

**Impact:** Unauthenticated MinIO root admin access.

---

## HIGH: MinIO Root Credentials Shared With All Authenticated Users

**CWE:** CWE-269

**Description:**
Even through Traefik's `kratos-auth`, the MinIO login uses root credentials for ALL users regardless of role. A `weather_admin` user gets full MinIO root access.

---

## MEDIUM: SSL Certificate Verification Disabled Globally

**CWE:** CWE-295

**Description:**
`ssl.CERT_NONE` set globally — all `urlopen` calls skip TLS verification. Enables MITM against Kratos session validation.

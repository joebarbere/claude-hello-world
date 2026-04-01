# Vulnerability Report: apps/ory/kratos.yml

## CRITICAL: Hardcoded Placeholder Cookie and Cipher Secrets — Session Forgery

**CWE:** CWE-321 — Use of Hard-coded Cryptographic Key

**Description:**
Cookie signing and cipher secrets committed in plaintext:
```yaml
secrets:
  cookie:
    - CHANGE-ME-COOKIE-SECRET-32-CHARS!!
  cipher:
    - CHANGE-ME-CIPHER-SECRET-32-CHARS
```
These are used for HMAC session cookie signing and xchacha20-poly1305 encryption of identity fields.

**Exploitation Steps:**
1. Read the cookie secret from the repository.
2. Forge a valid Kratos session cookie for any identity (including admin).
3. Use the cipher secret to decrypt any encrypted identity fields.

**Impact:** Complete authentication bypass. Any repo reader can forge admin session tokens.

---

## HIGH: Hardcoded Database Credentials + sslmode=disable

**CWE:** CWE-259

**Description:** DSN `postgres://appuser:apppassword@host.containers.internal:5432/appdb?sslmode=disable` — credentials in plaintext, database traffic unencrypted.

---

## MEDIUM: SMTP skip_ssl_verify=true

**CWE:** CWE-295

**Description:** SSL verification disabled for SMTP. MITM attacker could intercept recovery email links.

---

## MEDIUM: CORS Allows Plain HTTP Origins

**CWE:** CWE-942

**Description:** `allowed_origins` includes `http://localhost:4200` (plain HTTP). Session cookies could be transmitted unencrypted.

---

## MEDIUM: Weak bcrypt Cost Factor (8)

**CWE:** CWE-916

**Description:** bcrypt cost 8 is 4x faster to crack than OWASP minimum of 10. Combined with accessible database, hashes are trivially obtainable and faster to brute-force.

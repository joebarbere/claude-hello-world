# Vulnerability Report: apps/ory/init-users.sh

## HIGH: Hardcoded Demo Admin Credentials in Version Control

**CWE:** CWE-259 — Use of Hard-coded Password

**Description:**
```sh
create_identity "admin@example.com" "Admin1234!" "admin"
create_identity "weatheradmin@example.com" "WeatherAdmin1234!" "weather_admin"
```
Exact email addresses, passwords, and roles are publicly readable.

**Exploitation Steps:**
1. Read the file from the repository.
2. Log in at `https://localhost:8443/auth/login` with `admin@example.com` / `Admin1234!`.
3. Full admin access to all weather-api operations and Traefik-protected services.

**Impact:** Immediate privileged access to the entire application stack.

---

## HIGH: Unauthenticated Kratos Admin API Consumption

**CWE:** CWE-306

**Description:** Script calls Kratos Admin API with no authentication. The Admin API is also exposed via Traefik and hostPort with no auth gate.

---

## MEDIUM: Shell/JSON Injection Risk in create_identity

**CWE:** CWE-78

**Description:** Variables interpolated directly into JSON string. Unsafe pattern if variables were ever sourced from untrusted input. Use `jq` for proper JSON construction.

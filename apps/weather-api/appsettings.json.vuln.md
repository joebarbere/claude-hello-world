# Vulnerability Report: appsettings.json

## Finding 1 — Hardcoded Database Credentials in Committed Configuration

**Severity:** HIGH
**CWE:** CWE-798 (Use of Hard-coded Credentials), CWE-312 (Cleartext Storage of Sensitive Information)

**Description:**
The database connection string with plaintext credentials is committed directly to source control:

```json
"DefaultConnection": "Host=localhost;Port=5432;Database=appdb;Username=appuser;Password=apppassword"
```

The same credentials also appear in `WeatherDbContextFactory.cs` as a hardcoded string literal.

**Exploitation Steps:**
1. Any person with read access to the repository has the database password.
2. If credentials are reused in production, attacker connects directly to PostgreSQL.
3. Full read/write access to `WeatherForecasts` and `Minions` tables; potential privilege escalation depending on DB user grants.

**Impact:**
Full database compromise if credentials are reused or repository is public.

**Remediation:**
Remove credentials from committed files. Use environment variables or a secret manager at runtime.

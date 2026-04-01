# Vulnerability Report: Program.cs

## Finding 1 — SSRF / Admin API Abuse via Unauthenticated `/signup` + Account Enumeration

**Severity:** HIGH
**CWE:** CWE-918 (Server-Side Request Forgery), CWE-204 (Observable Response Discrepancy)

**Description:**
The `/signup` endpoint is fully unauthenticated and directly calls the Kratos Admin API (`/admin/identities`) — the most privileged Kratos endpoint. The endpoint returns `409 Conflict` when an email already exists vs. `200 OK` for new emails, creating an account enumeration oracle.

```csharp
app.MapPost("/signup", async (SignupRequest request, IConfiguration config) =>
{
    var kratosAdminUrl = config.GetValue<string>("OryKratosAdminUrl") ?? "http://localhost:4434";
    using var httpClient = new HttpClient();
    var response = await httpClient.PostAsJsonAsync($"{kratosAdminUrl}/admin/identities", payload);
```

**Exploitation Steps:**
1. `POST /signup` with `{"email": "target@company.com"}` — no auth required.
2. `409` → email exists; `200` → email not registered. Enumerate at will.
3. Flood the endpoint to create thousands of inactive identities (no rate limiting).
4. If `OryKratosAdminUrl` is attacker-influenced (env var injection), the backend becomes an SSRF pivot.

**Impact:**
Account enumeration, admin API abuse, potential SSRF, database flooding.

**Remediation:**
- Return `200` regardless of `409` to prevent enumeration.
- Add rate limiting via Traefik middleware.
- Validate email format before calling Kratos.

---

## Finding 2 — Information Disclosure via Kratos Error Body Proxying

**Severity:** MEDIUM
**CWE:** CWE-209 (Generation of Error Message Containing Sensitive Information)

**Description:**
When Kratos returns a non-409, non-2xx response, the raw error body is returned verbatim to the client:

```csharp
var body = await response.Content.ReadAsStringAsync();
return Results.Problem($"Failed to create identity: {body}");
```

Kratos error responses can contain stack traces, database errors, internal URLs, and configuration details.

**Exploitation Steps:**
1. Submit a malformed signup request.
2. Trigger a non-standard Kratos error.
3. Receive internal infrastructure details in the HTTP response.

**Impact:**
Internal infrastructure details disclosed to unauthenticated users.

**Remediation:**
Log the Kratos body server-side; return only a generic error message to the client.

---

## Finding 3 — Mass Assignment on WeatherForecast and Minion Create/Update

**Severity:** MEDIUM
**CWE:** CWE-915 (Improperly Controlled Modification of Dynamically-Determined Object Attributes)

**Description:**
POST/PUT endpoints bind the full model directly from the request body without a DTO. Attackers with `weather_admin` role can set server-managed fields like `Id`, `IsActive`, `LastRunAt`, `CreatedAt`.

**Exploitation Steps (Minion):**
1. `POST /minions` with `{"name":"evil","scheduleType":"Interval","scheduleValue":"1","isActive":true,"lastRunAt":"2020-01-01T00:00:00Z"}`.
2. Minion is created already active with stale `LastRunAt` — fires immediately on next scheduler tick.

**Exploitation Steps (WeatherForecast):**
1. `POST /weatherforecast` with `{"id": 1, "temperatureC": 2147483647}` — potential PK collision, no range validation.

**Impact:**
Bypass activation flow, force immediate execution, potential data corruption.

**Remediation:**
Use dedicated request DTOs that exclude server-managed fields.

---

## Finding 4 — No CORS Policy (Cross-Origin Reads)

**Severity:** MEDIUM
**CWE:** CWE-942 (Overly Permissive Cross-domain Whitelist)

**Description:**
`AllowedHosts: "*"` disables host filtering. No explicit CORS policy is registered (`AddCors`/`UseCors` absent). Simple GET requests from any origin succeed without preflight.

**Exploitation Steps:**
1. Attacker hosts page with: `fetch('https://localhost:8443/weatherforecast', {credentials:'include'})`.
2. Browser sends the request; attacker's page receives the full JSON response.

**Impact:**
Cross-origin data exfiltration from any page a logged-in user visits.

**Remediation:**
Add explicit CORS policy locked to known frontend origins with `AllowCredentials()`.

---

## Finding 5 — No Rate Limit on Minion Schedules (DB Flood)

**Severity:** LOW
**CWE:** CWE-400 (Uncontrolled Resource Consumption)

**Description:**
No minimum interval enforcement on Minion schedules. An authenticated admin can create many minions with short intervals, flooding the database with forecast entries.

**Remediation:**
Enforce minimum interval, validate cron expressions, limit max active minions.

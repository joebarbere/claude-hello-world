# Vulnerability Report: KratosAuthMiddleware.cs

## Finding 1 — Unauthenticated Read Access to All Data Endpoints

**Severity:** HIGH
**CWE:** CWE-862 (Missing Authorization)

**Description:**
The middleware short-circuits on any non-write HTTP method (GET, HEAD, OPTIONS, TRACE) and calls `next(context)` immediately without any authentication check. Every `GET /weatherforecast`, `GET /weatherforecast/{id}`, `GET /minions`, and `GET /minions/{id}` endpoint is fully public with zero session validation.

```csharp
if (!WriteMethods.Contains(context.Request.Method, StringComparer.OrdinalIgnoreCase))
{
    await next(context);  // No auth, no logging, no rate limit
    return;
}
```

**Exploitation Steps:**
1. Send `GET https://localhost:8443/weatherforecast` with no cookies or credentials.
2. Receive the full dataset of all weather forecasts — no 401, no challenge.
3. Same for `GET /minions` — attacker enumerates all scheduler jobs, their names, last-run times, and active status.

**Impact:**
All stored data (weather records, minion definitions and schedules) is accessible to any unauthenticated actor on the network.

**Remediation:**
Add session validation for GET paths (skip only the role check for reads). If reads are intentionally public, document it and ensure no sensitive data is in the response models.

---

## Finding 2 — Cookie Header Forwarding Without Sanitization (Header Injection)

**Severity:** HIGH
**CWE:** CWE-113 (Improper Neutralization of CRLF Sequences in HTTP Headers)

**Description:**
The middleware reads all incoming cookies and concatenates them raw into a single string forwarded to Kratos using `TryAddWithoutValidation`, which bypasses .NET's header validation:

```csharp
var cookieHeader = string.Join("; ", context.Request.Cookies.Select(c => $"{c.Key}={c.Value}"));
httpClient.DefaultRequestHeaders.TryAddWithoutValidation("Cookie", cookieHeader);
```

If a cookie name or value contains `\r\n` (CRLF), an attacker can inject arbitrary HTTP headers into the outbound request to Kratos.

**Exploitation Steps:**
1. Craft a request with a cookie value containing a CRLF sequence: `Cookie: legit=value%0d%0aX-Injected: attacker`.
2. The middleware constructs the cookie header with the injected content.
3. `TryAddWithoutValidation` sends the injected header to Kratos.
4. Depending on Kratos's HTTP parser, this may allow spoofing `Authorization`, `X-Forwarded-For`, or a second `Cookie` header.

**Impact:**
Potential header injection into the Kratos session verification request. Worst case: authentication bypass or session spoofing.

**Remediation:**
Only forward the `ory_kratos_session` cookie (not all cookies) and use `Add` instead of `TryAddWithoutValidation`.

---

## Finding 3 — HttpClient Per Request (Socket Exhaustion DoS)

**Severity:** MEDIUM
**CWE:** CWE-400 (Uncontrolled Resource Consumption)

**Description:**
`new HttpClient()` is instantiated on every request with no timeout configured. This is a known .NET anti-pattern that exhausts ephemeral socket connections under load.

```csharp
using var httpClient = new HttpClient(); // New instance per request
```

**Exploitation Steps:**
1. Send sustained write requests (POST/PUT/DELETE) with any cookie.
2. Each request opens a new TCP socket to Kratos with no timeout.
3. Under load, ephemeral ports or thread pool threads are exhausted → DoS.

**Impact:**
Denial of service against the weather-api process.

**Remediation:**
Inject `IHttpClientFactory` via DI and set a timeout of 5 seconds.

---

## Finding 4 — `/signup` Bypass Too Broad

**Severity:** MEDIUM
**CWE:** CWE-706 (Use of Incorrectly-Resolved Name or Reference)

**Description:**
The middleware exempts `/signup` using `StartsWithSegments`. Any future route starting with `/signup` (e.g., `/signup/admin`, `/signup/confirm`) will silently bypass auth.

**Exploitation Steps:**
If a developer adds `POST /signup/admin-create`, that endpoint is permanently unauthenticated.

**Impact:**
Silent authentication bypass on future routes matching the prefix.

**Remediation:**
Use `context.Request.Path.Equals("/signup", StringComparison.OrdinalIgnoreCase)` for exact match.

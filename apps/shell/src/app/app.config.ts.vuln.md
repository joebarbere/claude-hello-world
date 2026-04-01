# Vulnerability Report: apps/shell/src/app/app.config.ts

## MEDIUM: HttpClient Configured Without CSRF Interceptor

**CWE:** CWE-352 — Cross-Site Request Forgery

**Description:**
`provideHttpClient()` registered with no interceptors. No CSRF token header sent on mutating requests. No global `withCredentials`. No centralized 401/403 handler.

**Impact:** Cross-site request forgery possible if session cookie SameSite is not Strict.

**Remediation:** Add `withInterceptors([csrfInterceptor, authErrorInterceptor])`.

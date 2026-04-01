# Vulnerability Report: apps/admin-app/src/app/kratos-admin/kratos-admin.component.ts

## LOW: Error Messages Leak Internal System Details

**CWE:** CWE-209

**Description:**
Raw `err.message` from HTTP errors rendered in UI — leaks internal Kratos API URLs, error codes, and schema details.

---

## LOW: Magic Link Displayed in Plaintext Input Field

**CWE:** CWE-312

**Description:**
Recovery magic link rendered in `type="text"` input — visible to shoulder surfing and screen capture.

**Remediation:** Use `type="password"`. Auto-copy and clear after timeout.

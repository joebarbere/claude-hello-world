# Vulnerability Report: ssl/localhost.key

## HIGH: TLS Private Key Committed to Version Control

**CWE:** CWE-321, CWE-312

**Description:**
The TLS private key `ssl/localhost.key` is committed to Git and baked into the Traefik container image. Anyone with repo access can decrypt captured TLS traffic or impersonate the server.

**Exploitation Steps:**
```bash
git show HEAD:ssl/localhost.key > extracted.key
# Decrypt any captured HTTPS traffic or perform MITM
```

**Impact:** Complete TLS confidentiality loss. Combined with known cookie signing secrets, full session compromise.

**Remediation:** Add `ssl/*.key` to `.gitignore`. Rotate the key pair. Scrub from git history.

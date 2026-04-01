# Vulnerability Report: traefik/Containerfile

## HIGH: TLS Private Key Baked into Container Image

**CWE:** CWE-321, CWE-312

**Description:**
`COPY ssl/localhost.key /etc/traefik/ssl/localhost.key` bakes the private key into an image layer, extractable by anyone who can pull the image.

**Remediation:** Use secret mounts instead of COPY for TLS keys. Never embed private keys in image layers.

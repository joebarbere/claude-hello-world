# Vulnerability Report: nginx/nginx.conf

## LOW: nginx stub_status Endpoint Publicly Accessible

**CWE:** CWE-200

**Description:**
`/nginx_status` with `stub_status` is reachable via Traefik's catch-all route. Exposes active connection count, accepted connections, and request throughput.

**Exploitation Steps:**
```bash
curl -k https://localhost:8443/nginx_status
```

**Impact:** Minor info disclosure. Useful for traffic analysis and DoS capacity planning.

**Remediation:** Restrict to `allow 127.0.0.1; deny all;` in nginx config.

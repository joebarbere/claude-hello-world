# Security Vulnerability Report — .github/workflows/eks-e2e.yml

---

## Finding 16: Unauthenticated API and Admin Surface Confirmed and Exercised in CI

**Severity:** LOW
**CWE:** CWE-200 (Exposure of Sensitive Information to an Unauthorized Actor)
**DEV-ONLY:** Yes — the unauthenticated surfaces are intentional in development; CI validates what exists

### Description

The EKS end-to-end workflow exercises unauthenticated access to both the weather-api read endpoint and the Kratos Admin API directly from CI steps, confirming these surfaces are reachable without credentials in any deployment of this stack. While this is consistent with the documented architecture (GET endpoints are unauthenticated; Kratos admin is unauthenticated in dev), the CI workflow encodes these unauthenticated access patterns as expected behavior — including a direct plaintext HTTP probe to the Kratos Admin API on port 4434.

### Specific CI Steps of Concern

The workflow probes `http://localhost:5221/weatherforecast` with no auth header and no TLS, and probes `http://localhost:4434/health/ready` directly — confirming the admin API is expected to be reachable on its native port.

### Exploitation Steps

1. This is a confirmatory finding rather than a novel attack vector. An attacker who has network access to port 4434 on any deployed instance of this stack can reach the Kratos Admin API without authentication, as confirmed by the CI workflow probing it without credentials.
2. The CI workflow's health-check pattern confirms that no authentication was added to the Admin API between development and EKS deployment.

### Impact

Informational confirmation that the unauthenticated Kratos Admin API and unauthenticated weather-api read surface are present in the EKS deployment, not only in local development. The primary risk is documented under Finding 7. This finding emphasizes that those unauthenticated surfaces must be addressed before any public-facing deployment.

### Remediation

**DEV-ONLY in local context, but HIGH priority for EKS deployment:**

1. Add a Traefik middleware on the EKS ingress that blocks all traffic to `/.ory/kratos/admin/` from outside the cluster network.
2. Update the CI health-check to probe the admin API through an internal cluster DNS name rather than a direct port, reflecting the production access pattern.
3. Ensure the EKS deployment's security group / network policy denies inbound traffic to port 4434 from any source outside the pod network.

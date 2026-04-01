# Vulnerability Report: k8s/postgres-pod.yaml

## CRITICAL: Hardcoded Database Credentials Across All Pod Manifests

**CWE:** CWE-798 — Use of Hard-coded Credentials

**Description:**
The PostgreSQL password `apppassword` is hardcoded in plaintext across 5+ locations: `k8s/postgres-pod.yaml`, `apps/postgres/Containerfile`, `k8s/ory-kratos-pod.yaml`, `k8s/kafka-pod.yaml`, and `k8s/observability-pod.yaml`. PostgreSQL is published on `hostPort: 5432`, directly reachable from the host network.

**Exploitation Steps:**
1. Read credentials from any pod manifest in the repository.
2. Connect directly: `psql -h <target> -p 5432 -U appuser -d appdb` (password: `apppassword`).
3. Dump all tables including Kratos identity data (hashed passwords, session tokens, email addresses).
4. Insert/modify identities to escalate to `admin` role.

**Impact:**
Full database read/write access. Kratos identity store, session data, recovery tokens, and all application data compromised.

**Remediation:**
Use Kubernetes Secrets with `secretKeyRef`. Remove `ENV POSTGRES_PASSWORD` from the Containerfile. Rotate credentials immediately.

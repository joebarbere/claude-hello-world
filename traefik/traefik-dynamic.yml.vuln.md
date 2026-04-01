# Vulnerability Report: traefik/traefik-dynamic.yml

## HIGH: Kafka UI Exposed Without Any Authentication

**CWE:** CWE-306

**Description:**
`kafka-ui-router` has no `middlewares` — no `kratos-auth`. Provides full Kafka admin access: browse/produce/consume messages, manage consumer groups, connectors, schemas.

**Exploitation Steps:**
Access `https://localhost:8443/kafka-ui` — no login required.

---

## Note: Kratos Admin API Route Missing Auth

The `kratos-admin-router` routes `/.ory/kratos/admin` to the Kratos admin service with no auth middleware applied. See `k8s/ory-kratos-pod.yaml.vuln.md` for full details.

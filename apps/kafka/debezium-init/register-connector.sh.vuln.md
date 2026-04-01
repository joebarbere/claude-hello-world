# Vulnerability Report: apps/kafka/debezium-init/register-connector.sh

## HIGH: Hardcoded Database Credentials in Connector JSON

**CWE:** CWE-259

**Description:** `"database.user": "appuser"` and `"database.password": "apppassword"` embedded in the connector registration JSON. These credentials are stored in Kafka Connect's internal config topic (unencrypted) and retrievable via the REST API.

**Exploitation Steps:**
```bash
curl http://localhost:8083/connectors/weather-api-connector/config
# Returns "database.password": "apppassword"
```

---

## MEDIUM: Unauthenticated Kafka Connect REST API

**CWE:** CWE-306

**Description:** No authentication on Kafka Connect REST API. Anyone who can reach port 8083 can list, modify, pause, delete, or create connectors.

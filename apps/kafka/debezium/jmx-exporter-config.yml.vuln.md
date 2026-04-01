# Vulnerability Report: apps/kafka/debezium/jmx-exporter-config.yml

## HIGH: Wildcard JMX Export Rule

**CWE:** CWE-200

**Description:**
Pattern `.*` exports every JMX MBean as Prometheus metrics — potentially including connector passwords as label values. Exposed on unauthenticated `hostPort: 9404`.

**Remediation:** Replace with explicit allowlist of safe metric patterns.

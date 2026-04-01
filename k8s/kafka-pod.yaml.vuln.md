# Vulnerability Report: k8s/kafka-pod.yaml

## HIGH: Entire Kafka Stack Exposed Without Authentication or Encryption

**CWE:** CWE-306, CWE-319

**Description:**
All Kafka listeners use `PLAINTEXT` security protocol. Every component is directly reachable on host ports without authentication: Kafka (9092, 9094), Schema Registry (8085), Debezium Connect (8083), JMX Exporter (9404), Kafka-UI (8090).

**Exploitation Steps:**
```bash
kafka-console-consumer.sh --bootstrap-server <target>:9094 \
  --topic weather.public.WeatherForecasts --from-beginning
curl -X DELETE http://<target>:8083/connectors/weather-api-connector
open http://<target>:8090/kafka-ui
```

**Impact:** Read all CDC events, inject/delete messages, reconfigure/destroy connectors, manipulate Schema Registry.

---

## HIGH: PostgreSQL Credentials in Pod Spec and Init Script

**CWE:** CWE-312, CWE-798

**Description:** `PGPASSWORD: apppassword` hardcoded in slot-guard container env vars and `register-connector.sh`.

---

## HIGH: JMX Exporter Wildcard Rule Leaks All JVM Internal State

**CWE:** CWE-200

**Description:** `jmx-exporter-config.yml` uses pattern `.*` exporting every JMX MBean — potentially including database passwords as metric labels. Exposed on `hostPort: 9404`.

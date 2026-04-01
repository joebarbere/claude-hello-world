# Vulnerability Report: apps/weatherstream-app/src/app/services/kafka-stream.service.ts

## MEDIUM: window.electronKafka API Exposed to Any Script

**CWE:** CWE-749 — Exposed Dangerous Method or Function

**Description:**
`window.electronKafka` is readable/writable by any script. An XSS or malicious extension can override event handlers, trigger Kafka reconnection DoS, or inject malicious event data without schema validation.

**Remediation:** Freeze the API object in preload. Add type-guard validation on all incoming events.

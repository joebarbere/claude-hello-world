# Vulnerability Report: apps/kafka/debezium/Containerfile

## MEDIUM: JMX Exporter JAR Fetched Without Checksum Verification

**CWE:** CWE-494 — Download of Code Without Integrity Check

**Description:**
`ADD https://repo1.maven.org/.../jmx_prometheus_javaagent-0.20.0.jar` downloads at build time with no SHA-256 verification. Supply chain risk if Maven Central or CDN is compromised.

**Remediation:** Add `RUN echo "<sha256> <path>" | sha256sum -c -` after download. Or vendor the JAR.

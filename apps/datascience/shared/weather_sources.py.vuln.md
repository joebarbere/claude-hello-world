# Vulnerability Report: apps/datascience/shared/weather_sources.py

## MEDIUM: External HTTP Downloads Without Integrity Verification

**CWE:** CWE-295, CWE-345

**Description:**
Weather data downloaded from NOAA and Open-Meteo via `requests.get()` with no response integrity verification (checksum/signature). Files written to `/tmp` and uploaded to MinIO as ground truth. The `station_id` parameter is not sanitized for path traversal.

**Impact:** Data poisoning. Compromised CDN or MITM serves malicious CSV that propagates to analytics.

**Remediation:** Verify checksums. Validate station_id against allowlist.

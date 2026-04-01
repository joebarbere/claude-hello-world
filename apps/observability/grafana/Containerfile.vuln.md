# Vulnerability Report: Multiple Containerfiles (Floating :latest Tags)

## Finding 21 of 21

### Vulnerability Title
Floating :latest Image Tags Across Multiple Containerfiles Break Reproducibility and Hide Vulnerability Adoption

### Severity
LOW

### CWE
- CWE-494: Download of Code Without Integrity Check

### Description

The following Containerfiles use floating `:latest` tags for their base images:

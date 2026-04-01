# Vulnerability Report: apps/datascience/jupyter/Containerfile

## MEDIUM: pip Install as root + Floating :latest Base Image

**CWE:** CWE-250, CWE-494

**Description:**
`FROM quay.io/jupyter/minimal-notebook:latest` — floating tag. `USER root` + `pip install` with unpinned versions. Compromised package runs as root during build.

**Remediation:** Pin base image to digest. Pin package versions with hashes. Install as non-root user.

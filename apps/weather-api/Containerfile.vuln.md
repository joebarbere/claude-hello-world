# Vulnerability Report: weather-api/Containerfile

## Finding 1 — Container Runs as Root

**Severity:** MEDIUM
**CWE:** CWE-250 (Execution with Unnecessary Privileges)

**Description:**
The Containerfile has no `USER` directive, so the application runs as `root` (UID 0) inside the container:

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:9.0-alpine AS runner
WORKDIR /app
COPY --from=builder /app/publish .
EXPOSE 8080
ENTRYPOINT ["dotnet", "WeatherApi.dll"]
# No USER instruction
```

**Exploitation Steps:**
1. Attacker exploits any RCE vulnerability in the application.
2. Attacker is immediately root in the container.
3. Can read all mounted secrets, write to filesystem, attempt container escape.

**Impact:**
Privilege escalation within the container upon any code execution vulnerability.

**Remediation:**
Add `USER app` (the Alpine .NET image includes this user at UID 1654).

---

## Finding 2 — No Read-Only Filesystem or Dropped Capabilities

**Severity:** LOW
**CWE:** CWE-732 (Incorrect Permission Assignment for Critical Resource)

**Description:**
No read-only root filesystem or capability drops configured. A compromised container can write executables to the filesystem.

**Remediation:**
Add `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, and `capabilities: drop: ["ALL"]` in the pod manifest security context.

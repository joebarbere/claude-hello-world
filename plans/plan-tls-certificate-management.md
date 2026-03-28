# Plan: TLS Certificate Management

## Goal

Replace the manual self-signed certificate workflow with mkcert for local development and document a Let's Encrypt/ACME path for production, so developers get trusted HTTPS out of the box without browser warnings.

## Current State

TLS is handled via manually generated self-signed certificates:

- **Certificate files**: `ssl/localhost.crt` and `ssl/localhost.key` are committed to the repo (checked into Git).
- **Generation scripts**: Three platform-specific scripts generate a self-signed cert via raw `openssl req` commands:
  - `ssl/generate-cert-linux.sh` -- `openssl req -x509 ... -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`
  - `ssl/generate-cert-macos.sh`
  - `ssl/generate-cert-windows.ps1`
- **Trust scripts**: Three platform-specific scripts install/uninstall the cert to the system trust store:
  - `ssl/install-cert-linux.sh` -- copies to `/usr/local/share/ca-certificates/` or `/etc/pki/ca-trust/source/anchors/`
  - `ssl/install-cert-macos.sh`, `ssl/uninstall-cert-macos.sh`
  - `ssl/install-cert-windows.ps1`, `ssl/uninstall-cert-windows.ps1`
- **Traefik config**: `traefik/traefik-dynamic.yml` (lines 221-224) references the cert at container paths:
  ```yaml
  tls:
    certificates:
      - certFile: /etc/traefik/ssl/localhost.crt
        keyFile: /etc/traefik/ssl/localhost.key
  ```
- **Traefik static config**: `traefik/traefik.yml` defines entrypoints on `:80` (redirects to HTTPS) and `:443`.
- The committed `.crt` and `.key` files are the actual private key material, sitting in the repo.

### Problems with current approach

1. Self-signed certs cause browser warnings ("Your connection is not private") until manually trusted.
2. The private key (`ssl/localhost.key`) is committed to Git -- a security anti-pattern.
3. Six platform-specific scripts to maintain (generate + install for 3 OSes).
4. No ACME/Let's Encrypt path for any non-localhost deployment.
5. Certificate has a 10-year validity (3650 days), which is flagged by some browsers.

## Implementation Steps

### Phase 1: Local Development with mkcert

#### 1. Replace openssl scripts with a single mkcert script

Create `ssl/generate-cert.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v mkcert &>/dev/null; then
  echo "ERROR: mkcert not found."
  echo "Install: https://github.com/FiloSottile/mkcert#installation"
  echo "  Fedora:       sudo dnf install mkcert nss-tools"
  echo "  Debian/Ubuntu: sudo apt install mkcert libnss3-tools"
  echo "  macOS:         brew install mkcert nss"
  echo "  Windows:       choco install mkcert"
  exit 1
fi

# Install the local CA into system and browser trust stores (one-time)
mkcert -install

# Generate cert for localhost and common local aliases
mkcert -cert-file "$SCRIPT_DIR/localhost.crt" \
       -key-file  "$SCRIPT_DIR/localhost.key" \
       localhost 127.0.0.1 ::1 host.containers.internal

echo ""
echo "Certificate generated and CA trusted:"
echo "  $SCRIPT_DIR/localhost.crt"
echo "  $SCRIPT_DIR/localhost.key"
echo ""
echo "Next: rebuild the Traefik container image"
echo "  npx nx podman-build shell"
```

This single script replaces all six generate/install scripts across all platforms because mkcert handles cross-platform CA installation internally.

#### 2. Remove old scripts

Delete:
- `ssl/generate-cert-linux.sh`
- `ssl/generate-cert-macos.sh`
- `ssl/generate-cert-windows.ps1`
- `ssl/install-cert-linux.sh`
- `ssl/install-cert-macos.sh`
- `ssl/install-cert-windows.ps1`
- `ssl/uninstall-cert-linux.sh`
- `ssl/uninstall-cert-macos.sh`
- `ssl/uninstall-cert-windows.ps1`

#### 3. Stop committing certificate files

Add to `.gitignore`:
```
# TLS certificates (generated locally via mkcert)
ssl/localhost.crt
ssl/localhost.key
```

Remove the committed cert/key from tracking:
```bash
git rm --cached ssl/localhost.crt ssl/localhost.key
```

#### 4. Update Traefik Containerfile to copy certs at build time

The Traefik container image build (likely in a Containerfile referenced by the shell project's `podman-build` target) already copies `ssl/localhost.crt` and `ssl/localhost.key` into the image. No path changes needed in `traefik/traefik-dynamic.yml` -- the TLS block stays the same:

```yaml
tls:
  certificates:
    - certFile: /etc/traefik/ssl/localhost.crt
      keyFile: /etc/traefik/ssl/localhost.key
```

The only change is that developers must run `ssl/generate-cert.sh` once before building.

#### 5. Add mkcert to developer setup docs

Document in README or a setup guide:
```
1. Install mkcert (see ssl/generate-cert.sh for OS-specific instructions)
2. Run: ./ssl/generate-cert.sh
3. Build containers: npx nx podman-build shell
```

### Phase 2: Production/Deployment with ACME (Let's Encrypt)

#### 6. Add Traefik ACME configuration for non-localhost deployments

Create a production Traefik static config `traefik/traefik-production.yml`:

```yaml
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"

certificatesResolvers:
  letsencrypt:
    acme:
      email: "${ACME_EMAIL}"
      storage: /etc/traefik/acme/acme.json
      httpChallenge:
        entryPoint: web

providers:
  file:
    filename: /etc/traefik/traefik-dynamic.yml
    watch: false
```

#### 7. Update the dynamic config for ACME

Create `traefik/traefik-dynamic-production.yml` (or use a conditional approach) where routers reference the ACME resolver instead of static certs:

```yaml
http:
  routers:
    nginx-router:
      rule: "PathPrefix(`/`)"
      entryPoints:
        - websecure
      service: nginx
      tls:
        certResolver: letsencrypt
# ... same pattern for all routers
```

#### 8. Add persistent volume for ACME state

In the production pod manifest, mount a persistent volume for `/etc/traefik/acme/` so the ACME certificate and account key survive container restarts.

### Phase 3: CI Integration

#### 9. Generate a throwaway cert in CI

For CI builds that need a TLS cert (e.g., e2e tests), generate one in the workflow:

```yaml
- name: Generate self-signed TLS cert for CI
  run: |
    mkdir -p ssl
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout ssl/localhost.key -out ssl/localhost.crt \
      -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

This avoids needing mkcert in CI (where browser trust does not matter).

## Files to Create/Modify

**Create:**
- `ssl/generate-cert.sh` -- single cross-platform mkcert script
- `traefik/traefik-production.yml` -- ACME-enabled Traefik static config (Phase 2)
- `traefik/traefik-dynamic-production.yml` -- production dynamic config with certResolver (Phase 2)

**Delete:**
- `ssl/generate-cert-linux.sh`
- `ssl/generate-cert-macos.sh`
- `ssl/generate-cert-windows.ps1`
- `ssl/install-cert-linux.sh`
- `ssl/install-cert-macos.sh`
- `ssl/install-cert-windows.ps1`
- `ssl/uninstall-cert-linux.sh`
- `ssl/uninstall-cert-macos.sh`
- `ssl/uninstall-cert-windows.ps1`
- `ssl/localhost.crt` (remove from Git tracking)
- `ssl/localhost.key` (remove from Git tracking)

**Modify:**
- `.gitignore` -- add `ssl/localhost.crt` and `ssl/localhost.key`
- `.github/workflows/ci.yml` -- add cert generation step if e2e tests need TLS
- `.github/workflows/eks-e2e.yml` / `eks-e2e-full.yml` -- add cert generation or ACME config for deployed environment

## Testing

1. **Fresh setup test**: On a clean machine, install mkcert, run `ssl/generate-cert.sh`, build containers, open `https://localhost:8443` -- verify no browser warning and green padlock.
2. **Cross-platform test**: Verify `ssl/generate-cert.sh` works on Linux (Fedora), macOS, and Windows (Git Bash / WSL).
3. **Container build test**: Run `npx nx podman-build shell` and verify Traefik starts with the new cert.
4. **Browser trust test**: Open Chrome/Firefox, navigate to `https://localhost:8443`, confirm the certificate shows "mkcert" as the issuer and is trusted.
5. **CI test**: Verify CI workflows that need TLS still pass with the generated throwaway cert.
6. **Git cleanliness test**: Run `git status` after setup -- `ssl/localhost.crt` and `ssl/localhost.key` should not appear as untracked or modified.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Developers must install mkcert as a new dependency | Provide clear error messages in `generate-cert.sh` with per-OS install commands. mkcert is available in all major package managers. |
| Existing developers have the old cert trusted in their system store | The old `uninstall-cert-*.sh` scripts can be kept temporarily or documented as a one-time cleanup step. |
| mkcert CA key (`~/.local/share/mkcert/rootCA-key.pem`) is a security-sensitive file | This is a known mkcert design trade-off for local dev. Document that this CA should never be shared or used on untrusted networks. |
| ACME (Phase 2) requires a publicly routable domain and port 80 | Only applies to production deployments. Local dev continues to use mkcert. |
| Removing committed certs breaks `podman-build` for developers who don't run `generate-cert.sh` first | Add a pre-build check (or Nx target dependency) that verifies `ssl/localhost.crt` exists before building the Traefik image. |

## Dependencies

- **plan-rotate-credentials.md** -- the ACME email address and any API tokens for DNS challenges could be stored in the `.env` file designed there.
- No hard blockers; Phase 1 can be done independently.

## Estimated Complexity

**Medium** -- Phase 1 (mkcert) is straightforward: one new script, delete nine old scripts, update `.gitignore`. Phase 2 (ACME) is more involved but is only needed when deploying to a real domain. The main risk is coordinating the transition with existing developers who have the old cert trusted.

#!/usr/bin/env bash
# Generate a self-signed SSL certificate for localhost.
# Outputs ssl/localhost.crt and ssl/localhost.key in the ssl/ directory.
# Requires: openssl (ships with macOS via LibreSSL; Homebrew openssl also works)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v openssl &>/dev/null; then
  echo "ERROR: openssl not found." >&2
  echo "Install it with Homebrew: brew install openssl" >&2
  exit 1
fi

openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout "$SCRIPT_DIR/localhost.key" \
  -out    "$SCRIPT_DIR/localhost.crt" \
  -subj   "/CN=localhost/O=claude-hello-world/C=US" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

echo ""
echo "Certificate generated:"
echo "  $SCRIPT_DIR/localhost.crt"
echo "  $SCRIPT_DIR/localhost.key"
echo ""
echo "Next steps:"
echo "  1. Rebuild the container image:  npx nx podman-build shell"
echo "  2. Trust the new cert locally:   ./ssl/install-cert-macos.sh"

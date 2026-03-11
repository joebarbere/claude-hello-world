#!/usr/bin/env bash
# Install the localhost self-signed certificate as a trusted CA on Linux.
# Supports Debian/Ubuntu (update-ca-certificates) and RHEL/Fedora (update-ca-trust).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT="$SCRIPT_DIR/localhost.crt"
CERT_NAME="claude-hello-world-localhost"

if [[ ! -f "$CERT" ]]; then
  echo "ERROR: Certificate not found at $CERT" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (sudo)." >&2
  exit 1
fi

# Debian / Ubuntu
if command -v update-ca-certificates &>/dev/null; then
  DEST="/usr/local/share/ca-certificates/${CERT_NAME}.crt"
  cp "$CERT" "$DEST"
  update-ca-certificates
  echo "Certificate installed to $DEST"
# RHEL / Fedora / CentOS
elif command -v update-ca-trust &>/dev/null; then
  DEST="/etc/pki/ca-trust/source/anchors/${CERT_NAME}.crt"
  cp "$CERT" "$DEST"
  update-ca-trust extract
  echo "Certificate installed to $DEST"
else
  echo "ERROR: Could not detect a supported CA trust store (tried update-ca-certificates and update-ca-trust)." >&2
  exit 1
fi

echo ""
echo "Done. The localhost certificate is now trusted system-wide."
echo "You may need to restart your browser for the change to take effect."

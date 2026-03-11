#!/usr/bin/env bash
# Install the localhost self-signed certificate as a trusted CA on macOS.
# Adds the cert to the System keychain and marks it as always trusted for SSL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT="$SCRIPT_DIR/localhost.crt"

if [[ ! -f "$CERT" ]]; then
  echo "ERROR: Certificate not found at $CERT" >&2
  exit 1
fi

echo "Adding certificate to the System keychain (you will be prompted for your password)..."
sudo security add-trusted-cert \
  -d \
  -r trustRoot \
  -k /Library/Keychains/System.keychain \
  "$CERT"

echo ""
echo "Done. The localhost certificate is now trusted system-wide."
echo "You may need to restart your browser for the change to take effect."

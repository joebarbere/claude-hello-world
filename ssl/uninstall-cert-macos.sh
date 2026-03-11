#!/usr/bin/env bash
# Remove the localhost self-signed certificate from the macOS System keychain.

set -euo pipefail

CERT_SUBJECT="CN=localhost,O=claude-hello-world,C=US"

echo "Removing certificate from the System keychain (you will be prompted for your password)..."

# Find the certificate by subject and delete it
CERT_HASH=$(sudo security find-certificate -c "localhost" -a -Z /Library/Keychains/System.keychain 2>/dev/null \
  | awk '/SHA-256/{print $3}' \
  | head -1)

if [[ -z "$CERT_HASH" ]]; then
  echo "Certificate not found in System keychain. Nothing to remove."
  exit 0
fi

sudo security delete-certificate -Z "$CERT_HASH" /Library/Keychains/System.keychain

echo ""
echo "Done. The localhost certificate has been removed from the System keychain."
echo "You may need to restart your browser for the change to take effect."

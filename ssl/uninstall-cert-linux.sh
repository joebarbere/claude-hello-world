#!/usr/bin/env bash
# Remove the localhost self-signed certificate from the system trust store on Linux.
# Supports Debian/Ubuntu (update-ca-certificates) and RHEL/Fedora (update-ca-trust).

set -euo pipefail

CERT_NAME="claude-hello-world-localhost"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (sudo)." >&2
  exit 1
fi

REMOVED=false

# Debian / Ubuntu
if command -v update-ca-certificates &>/dev/null; then
  DEST="/usr/local/share/ca-certificates/${CERT_NAME}.crt"
  if [[ -f "$DEST" ]]; then
    rm -f "$DEST"
    update-ca-certificates --fresh
    echo "Certificate removed from $DEST"
    REMOVED=true
  fi
fi

# RHEL / Fedora / CentOS
if command -v update-ca-trust &>/dev/null; then
  DEST="/etc/pki/ca-trust/source/anchors/${CERT_NAME}.crt"
  if [[ -f "$DEST" ]]; then
    rm -f "$DEST"
    update-ca-trust extract
    echo "Certificate removed from $DEST"
    REMOVED=true
  fi
fi

if [[ "$REMOVED" == false ]]; then
  echo "Certificate not found in any known trust store location. Nothing to remove."
else
  echo ""
  echo "Done. The localhost certificate has been removed."
  echo "You may need to restart your browser for the change to take effect."
fi

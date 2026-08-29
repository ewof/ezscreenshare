#!/usr/bin/bash
# Copy TLS certs for LiveKit TURN into ./turn-certs.
# Set TURN_CERT_HOST (ssh alias) and TURN_CERT_NAME (certificate CN).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p turn-certs
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
host="${TURN_CERT_HOST:-vps.example.com}"
name="${TURN_CERT_NAME:-turn.example.com}"
if scp -o StrictHostKeyChecking=accept-new \
  "$host:shared-certs/$name/fullchain.pem" "$tmp/fullchain.pem" \
  && scp "$host:shared-certs/$name/privkey.pem" "$tmp/privkey.pem"
then
  install -m 644 "$tmp/fullchain.pem" turn-certs/fullchain.pem
  install -m 644 "$tmp/privkey.pem" turn-certs/privkey.pem
  echo "updated turn-certs/{fullchain,privkey}.pem from $name"
else
  echo "certs not on $host yet; skipping"
  exit 0
fi

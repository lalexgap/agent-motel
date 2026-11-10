#!/bin/bash
# Creates a self-signed code-signing identity in its own keychain, so every local
# build has the same designated requirement and macOS stops re-asking for Keychain
# access after each rebuild. It is not trusted by Gatekeeper and is no use for
# distribution: for other Macs, sign with a Developer ID and notarize.
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Run on macOS." >&2
  exit 1
fi
name="Agent Motel Local Signing"
keychain="$HOME/Library/Keychains/agent-motel-signing.keychain-db"
# Not a secret: the keychain only holds a key that marks a build as made on this Mac.
password="agent-motel-local-signing"
if security find-certificate -c "$name" "$keychain" >/dev/null 2>&1; then
  echo "Signing identity already exists: $keychain"
  exit 0
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat > "$work/openssl.cnf" <<EOF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$name
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$work/key.pem" -out "$work/cert.pem" -config "$work/openssl.cnf" 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
  -out "$work/identity.p12" -passout pass:transfer -name "$name"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$work/identity.p12" -k "$keychain" -P transfer -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
echo "Created \"$name\" in $keychain"
echo "macos/build.sh uses it automatically. Remove it with: security delete-keychain \"$keychain\""

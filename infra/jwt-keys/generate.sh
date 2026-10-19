#!/bin/sh
# DEV-ONLY RS256 keypair for the compose stack (premise 3, A5). Runs once per volume: the keys are
# generated only if absent, live in the `jwt-keys` named volume and are never committed.
#   /keys/private/private.pem  PKCS#8 RSA 2048  -> auth-stub only
#   /keys/public/public.pem    X.509 SPKI PEM   -> chat-1 / chat-2 (read-only)
set -eu

APP_UID="${APP_UID:-10001}"
mkdir -p /keys/private /keys/public

if [ -s /keys/private/private.pem ] && [ -s /keys/public/public.pem ]; then
  echo "jwt-keys: existing dev keypair kept"
else
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /keys/private/private.pem
  openssl pkey -in /keys/private/private.pem -pubout -out /keys/public/public.pem
  echo "jwt-keys: new dev keypair generated"
fi

chown -R "$APP_UID:$APP_UID" /keys/private /keys/public
chmod 0500 /keys/private
chmod 0400 /keys/private/private.pem
chmod 0555 /keys/public
chmod 0444 /keys/public/public.pem

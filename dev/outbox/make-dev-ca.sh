#!/bin/sh
# Create the development CA, the certificate for the host name "outbox" (the local SES stand-in)
# and the outbox SMTP login, in .kasten-dev/outbox/ (or $KASTEN_DEV_DIR/outbox/).
# Idempotent: it does nothing while every file exists and the certificate has more than 30 days
# left. It needs only Docker: openssl runs in a pinned Alpine container, and the CA's private key
# never leaves that container.
set -eu

IMAGE=alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
OUT=${KASTEN_DEV_DIR:-$ROOT/.kasten-dev}/outbox
CERT_DAYS=825
RENEW_SECONDS=2592000
FILES="ca.crt outbox.crt outbox.key smtp-auth smtp-login outbox.expires"

complete=true
for f in $FILES; do
  [ -s "$OUT/$f" ] || complete=false
done
if [ "$complete" = true ]; then
  expires=$(cat "$OUT/outbox.expires")
  case $expires in '' | *[!0-9]*) expires=0 ;; esac
  if [ $((expires - $(date +%s))) -gt "$RENEW_SECONDS" ]; then
    echo "make-dev-ca: $OUT is complete and the outbox certificate is valid; nothing to do"
    exit 0
  fi
fi

umask 077
mkdir -p "$OUT"
work=$(mktemp -d "$OUT/.new.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

# An existing login is kept, so a configured relay route keeps working after a certificate renewal.
login=/dev/null
[ ! -s "$OUT/smtp-login" ] || login=$OUT/smtp-login

# The container reads the optional existing login on stdin and writes a tar of the new files.
# shellcheck disable=SC2016
docker run --rm -i "$IMAGE" sh -eu -c '
  apk add -q --no-cache openssl >/dev/null
  umask 077
  mkdir /w && cd /w
  login=$(cat)
  [ -n "$login" ] || login="kasten-dev:$(openssl rand -hex 24)"
  printf "%s\n" "$login" > smtp-login
  printf "%s:%s\n" "${login%%:*}" "$(printf "%s" "${login#*:}" | openssl passwd -6 -stdin)" > smtp-auth
  openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -sha256 \
    -keyout ca.key -out ca.crt -days 3650 -subj "/CN=Kasten development CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout outbox.key -out outbox.csr -subj "/CN=outbox" 2>/dev/null
  printf "%s\n" "basicConstraints=critical,CA:FALSE" "keyUsage=critical,digitalSignature" \
    "extendedKeyUsage=serverAuth" "subjectAltName=DNS:outbox" \
    "subjectKeyIdentifier=hash" "authorityKeyIdentifier=keyid" > leaf.ext
  openssl x509 -req -in outbox.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 \
    -days "$1" -extfile leaf.ext -out outbox.crt 2>/dev/null
  openssl verify -CAfile ca.crt -verify_hostname outbox outbox.crt >/dev/null
  echo $(( $(date +%s) + $1 * 86400 - 3600 )) > outbox.expires
  rm ca.key ca.srl outbox.csr leaf.ext
  tar -cf - .
' make-dev-ca "$CERT_DAYS" <"$login" | tar -xf - -C "$work"

for f in $FILES; do
  [ -s "$work/$f" ] || {
    echo "make-dev-ca: the container did not produce $f" >&2
    exit 1
  }
done
chmod 0644 "$work/ca.crt" "$work/outbox.crt" "$work/outbox.expires"
chmod 0600 "$work/outbox.key" "$work/smtp-auth" "$work/smtp-login"
for f in $FILES; do
  mv -f "$work/$f" "$OUT/$f"
done
echo "make-dev-ca: wrote the dev CA, the outbox certificate and the outbox SMTP login to $OUT"

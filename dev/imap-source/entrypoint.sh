#!/bin/sh
# Makes a self-signed certificate for localhost and 127.0.0.1 on first start, then runs Dovecot in
# the foreground. The private key stays in the container; the test reads only cert.pem.
set -eu

TLS=/etc/dovecot/tls

if [ ! -s "$TLS/cert.pem" ]; then
  umask 077
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 7 \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$TLS/key.pem" -out "$TLS/cert.pem" 2>/dev/null
  chmod 0644 "$TLS/cert.pem"
fi

# Dovecot's auth process runs as the dovecot group. The test writes the users on stdin.
[ -f /etc/dovecot/users ] || install -m 0640 -g dovecot /dev/null /etc/dovecot/users

exec /usr/sbin/dovecot -F

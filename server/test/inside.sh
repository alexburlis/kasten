#!/bin/bash
# Test-only helpers that run inside a kasten-server container, fed on stdin by verify.sh:
#   docker compose exec -T mail bash -s <command> [args] < server/test/inside.sh
set -euo pipefail

readonly DB=/var/lib/kasten/stalwart/stalwart.sqlite
readonly BUNDLE=/run/kasten/ca-certificates.crt

pid_of() {
  local d
  for d in /proc/[0-9]*; do
    if [ "$(cat "$d/comm" 2>/dev/null)" = "$1" ]; then
      echo "${d#/proc/}"
    fi
  done
}

# counts: per-table row counts of the database, read-only.
counts() {
  local t
  for t in $(sqlite3 -readonly "$DB" "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"); do
    printf '%s %s\n' "$t" "$(sqlite3 -readonly "$DB" "SELECT count(*) FROM \"$t\"")"
  done
}

# procs: user and effective capabilities of the server processes, and Stalwart's file capability.
procs() {
  local d c
  for d in /proc/[0-9]*; do
    c=$(cat "$d/comm" 2>/dev/null) || continue
    case $c in stalwart | unbound | tini | kasten-server) ;; *) continue ;; esac
    printf '%-14s pid=%-5s uid=%s capeff=%s\n' "$c" "${d#/proc/}" \
      "$(awk '/^Uid:/ {print $2}' "$d/status")" "$(awk '/^CapEff:/ {print $2}' "$d/status")"
  done
  printf 'file capability: %s\n' "$(getcap /usr/local/bin/stalwart)"
}

# smtp_plain <host>: MAIL FROM without STARTTLS; prints the server's answer.
smtp_plain() {
  local line reply
  exec 3<>"/dev/tcp/$1/587"
  IFS= read -r -t 5 line <&3
  printf 'EHLO mail.kasten.test\r\n' >&3
  while IFS= read -r -t 5 line <&3; do
    case $line in "250 "*) break ;; esac
  done
  printf 'MAIL FROM:<probe@kasten.test>\r\n' >&3
  IFS= read -r -t 5 reply <&3
  printf 'without STARTTLS, MAIL FROM is answered: %s\n' "${reply%$'\r'}"
}

# smtp_tls <host>: STARTTLS, then MAIL FROM without AUTH; prints the server's answers.
smtp_tls() {
  { sleep 1; printf 'EHLO mail.kasten.test\r\n'; sleep 1; printf 'MAIL FROM:<probe@kasten.test>\r\n'; sleep 1; printf 'QUIT\r\n'; } |
    openssl s_client -quiet -starttls smtp -connect "$1:587" -servername "$1" -CAfile "$BUNDLE" 2>/dev/null |
    tr -d '\r' | grep -E '^(530|250-AUTH)' || true
}

# tls_verify <host>: STARTTLS handshake with certificate and host name checks against the bundle
# that serve built. Exits 0 only if verification succeeded.
tls_verify() {
  local out
  out=$(openssl s_client -brief -starttls smtp -connect "$1:587" -servername "$1" -verify_hostname "$1" \
    -verify_return_error -CAfile "$BUNDLE" </dev/null 2>&1 || true)
  grep -E '^(Verification|Verified peername|verify error|Peer certificate)' <<<"$out" || true
  grep -q '^Verification: OK' <<<"$out"
}

kill_unbound() {
  kill "$(pid_of unbound)"
}

case ${1:-} in
  counts) counts ;;
  procs) procs ;;
  smtp-plain) smtp_plain "$2" ;;
  smtp-tls) smtp_tls "$2" ;;
  tls-verify) tls_verify "$2" ;;
  kill-unbound) kill_unbound ;;
  *)
    echo "usage: inside.sh counts|procs|smtp-plain <host>|smtp-tls <host>|tls-verify <host>|kill-unbound" >&2
    exit 2
    ;;
esac

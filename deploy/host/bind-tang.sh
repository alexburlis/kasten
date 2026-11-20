#!/bin/sh
# bind-tang.sh: let a Tang server unlock the Kasten volume at boot. It adds one Clevis key slot,
# pinned to the thumbprint of the Tang server's signing key. The recovery passphrase slot stays.
#
#   bind-tang.sh URL THUMBPRINT           asks for the recovery passphrase on the terminal
#   bind-tang.sh URL THUMBPRINT < FILE    reads it from the first line of standard input
#
# Example: bind-tang.sh http://100.101.102.103:7500 qZ3...    deploy/tang/README.md shows how to
# read the thumbprint on the Tang host. With a URL that is already bound, it only re-checks it.
set -eu

KASTEN_DM_NAME=kasten
# shellcheck source=deploy/host/host.env
[ ! -r /etc/kasten/host.env ] || . /etc/kasten/host.env
HELPER=$(dirname "$0")/kasten-unlock

die() {
  printf 'bind-tang: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 2 ] || die "usage: bind-tang.sh URL THUMBPRINT"
url=$1
thp=$2
case $url in
  http://* | https://*) ;;
  *) die "the URL must start with http:// or https://" ;;
esac
case $url in
  *[!A-Za-z0-9.:/_-]*) die "the URL may contain only letters, digits and . : / _ -" ;;
esac
case $thp in
  '' | *[!A-Za-z0-9_-]*) die "the thumbprint must be base64url text" ;;
esac
[ "$(id -u)" -eq 0 ] || die "run as root"

dev=$("$HELPER" attach)

# slot_for <url>: the LUKS key slot whose Clevis binding uses this exact Tang URL.
slot_for() {
  clevis luks list -d "$dev" 2>/dev/null |
    awk -v u="\"url\":\"$1\"" 'index($0, u) { sub(/:.*/, "", $1); print $1; exit }'
}

slot=$(slot_for "$url")
if [ -n "$slot" ]; then
  echo "bind-tang: slot $slot is already bound to $url; checking it" >&2
else
  # With a pinned thumbprint Clevis never asks whether to trust the server.
  cfg=$(printf '{"url":"%s","thp":"%s"}' "$url" "$thp")
  if [ -t 0 ]; then
    clevis luks bind -d "$dev" tang "$cfg"
  else
    clevis luks bind -d "$dev" -k - tang "$cfg"
  fi
  slot=$(slot_for "$url")
  [ -n "$slot" ] || die "clevis reported success, but no slot is bound to $url"
fi

# Ask Tang for the slot's key and test it against the LUKS header, without unlocking anything.
if ! clevis luks unlock -d "$dev" -t "$slot"; then
  die "Tang at $url cannot unlock slot $slot. Check that the server is reachable and that its keys did not change."
fi
logger -t kasten-unlock -p daemon.notice -- "event=bind result=ok slot=$slot url=$url" || true
echo "bind-tang: slot $slot unlocks through $url" >&2

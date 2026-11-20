#!/bin/sh
# Run from a trusted administration machine with access to the private admin tunnel.
# kasten.json, pins and reader credentials stay on the Mac. No mail private key goes to the VPS.
set -eu
[ "$#" -ge 2 ] || { echo "usage: check-from-mac.sh <repository> <private-kasten.json> [check options]" >&2; exit 2; }
repo=$1
config=$2
shift 2
[ -f "$repo/cli/src/main.ts" ] && [ -f "$config" ] || { echo "check-from-mac: repository or private config missing" >&2; exit 2; }
exec node "$repo/cli/src/main.ts" check --config "$config" "$@"

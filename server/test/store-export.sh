#!/usr/bin/env bash
# Local cached-image proof. No network, real mail, provider or shared mailbox access. All
# generated config/exports live in container tmpfs and disappear with --rm, including failure.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
docker run --rm -i --pull never --network none --read-only \
  --tmpfs /var/lib/kasten:uid=2525,gid=2525,mode=0700,size=96m \
  --tmpfs /run/kasten:uid=2525,gid=2525,mode=0700,size=4m \
  --mount "type=bind,src=$ROOT/server/bin/kasten-server,dst=/usr/local/bin/kasten-server,readonly" \
  --entrypoint /bin/bash "${KASTEN_TEST_SERVER_IMAGE:-kasten-server:dev}" -se <<'SH'
id=$(kasten-server init | sed -n 's/.*"volumeId":"\([a-f0-9]*\)".*/\1/p')
export KASTEN_VOLUME_ID=$id
kasten-server recovery >/var/lib/kasten/recovery.log 2>&1 & pid=$!
ready=false
for attempt in $(seq 1 100); do
  if kasten-server health >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.2
done
[ "$ready" = true ]
rc=0
kasten-server store-export while-running >/dev/null 2>&1 || rc=$?
[ "$rc" = 4 ]
[ ! -e /var/lib/kasten/upgrade/while-running ]
kill -TERM "$pid"
wait "$pid" || true
kasten-server store-export before
kasten-server store-export identical
kasten-server store-diff before identical
# Controlled bytes in separate native subspaces prove this is a complete-store superset,
# without guessing which opaque subspace contains any particular configuration object.
sqlite3 /var/lib/kasten/stalwart/stalwart.sqlite "INSERT INTO c(k,v) VALUES(x'01',x'74657374'); INSERT INTO s(k,v) VALUES(x'01020304050607080900',x'74657374');"
kasten-server store-export after
rc=0
kasten-server store-diff before after || rc=$?
[ "$rc" = 1 ]
[ "$(stat -c %a /var/lib/kasten/upgrade/before)" = 700 ]
[ "$(stat -c %a /var/lib/kasten/upgrade/before/manifest.sha256)" = 600 ]
rc=0
kasten-server store-export before >/dev/null 2>&1 || rc=$?
[ "$rc" = 3 ]
rc=0
kasten-server store-export ../outside >/dev/null 2>&1 || rc=$?
[ "$rc" = 2 ]
echo 'PASS native complete-store export: exclusive admission, identical/change, fresh labels, permissions, path guards'
SH

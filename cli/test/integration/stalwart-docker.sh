#!/bin/sh
# Integration run against a throwaway Stalwart v1.0.1 in Docker, in the same order as a real
# first boot: recovery mode, `kasten setup --bootstrap`, normal mode, then the live tests, which
# run `kasten setup` twice and require the second run to change nothing.
#
# usage: cli/test/integration/stalwart-docker.sh <empty work directory>
#
# It uses the official image pinned by digest, binds only 127.0.0.1:${KASTEN_IT_PORT:-7536}, names
# every Docker object kasten-research-it-*, and removes them all on exit. Secrets are generated
# into the work directory with mode 0600 and never printed. Set DOCKER_CONTEXT to choose the VM.
set -eu

IMAGE=stalwartlabs/stalwart@sha256:b9da4df8b4efc06bc926dd6e990bdeb0ad7b9261a7c3893d74b0461a00bb389b
RULES_URL=https://github.com/stalwartlabs/spam-filter/releases/download/v3.0.3/spam-filter-rules.json.gz
RULES_SHA256=43124c2ecfb9c5f187c1b9415ae7d37be1318ce0be91132750962a77c5f62505
NAME=kasten-research-it
PORT=${KASTEN_IT_PORT:-7536}
SUBNET_PREFIX=${KASTEN_IT_SUBNET_PREFIX:-172.29.53}

[ "$#" -eq 1 ] || {
  echo "usage: $0 <empty work directory>" >&2
  exit 2
}
WORK=$1
CLI=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
[ -z "$(ls -A "$WORK")" ] || {
  echo "$WORK is not empty" >&2
  exit 2
}

cleanup() {
  docker rm -f "$NAME-recovery" "$NAME-mail" >/dev/null 2>&1 || true
  docker volume rm "$NAME-etc" "$NAME-data" >/dev/null 2>&1 || true
  docker network rm "$NAME-net" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

random() {
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"
}

wait_http() {
  tries=0
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz/live" || true)" = 200 ]; do
    tries=$((tries + 1))
    [ "$tries" -lt 120 ] || {
      echo "Stalwart did not answer on 127.0.0.1:$PORT" >&2
      exit 1
    }
    sleep 0.5
  done
}

umask 077
printf 'admin:%s\n' "$(random 32)" >"$WORK/recovery-admin"
printf 'STALWART_RECOVERY_ADMIN=%s\n' "$(cat "$WORK/recovery-admin")" >"$WORK/recovery.env"
printf 'kasten-test-relay-user\n' >"$WORK/relay-username"
random 40 >"$WORK/relay-password"
printf '%s-Kq7\n' "$(random 24)" >"$WORK/you-password"
cp "$CLI/test/fixtures/throwaway-operator.pub.asc" "$WORK/operator.pub.asc"
curl -fsSL -o "$WORK/spam-filter-rules.json.gz" "$RULES_URL"
echo "$RULES_SHA256  $WORK/spam-filter-rules.json.gz" | sha256sum -c - >/dev/null 2>&1 ||
  echo "$RULES_SHA256  $WORK/spam-filter-rules.json.gz" | shasum -a 256 -c - >/dev/null

# Kasten's sign-in page, as the kasten-server image carries it (server/Dockerfile).
sh "$CLI/../server/signin/build.sh" "$WORK/kasten-signin.zip"
SIGNIN="-v $WORK/kasten-signin.zip:/opt/kasten/kasten-signin.zip:ro --tmpfs /run/kasten:rw,mode=1777"

cat >"$WORK/kasten.json" <<EOF
{
  "//": "Throwaway integration instance $NAME on 127.0.0.1:$PORT.",
  "serverHostname": "mx.kasten.test",
  "mailApiHostname": "mail.kasten.test",
  "domains": [{ "name": "kasten.test", "catchAll": "you@kasten.test" }],
  "users": [{ "email": "you@kasten.test", "description": "Dev user", "aliases": ["hello@kasten.test"], "passwordFile": "you-password" }],
  "webApp": { "origin": "http://localhost:7480", "redirectPath": "/oauth/callback", "oauthClientId": "kasten-web" },
  "http": { "mode": "dev", "bind": "0.0.0.0:8080" },
  "imapImportBind": "0.0.0.0:143",
  "relays": [{ "domain": "kasten.test", "host": "outbox", "port": 587, "usernameFile": "relay-username", "passwordFile": "relay-password" }],
  "operatorPublicKeyFile": "operator.pub.asc",
  "admin": { "apiUrl": "http://127.0.0.1:$PORT", "apiKeyFile": "admin-api-key", "account": "kasten-admin", "allowedIps": ["$SUBNET_PREFIX.1/32"] },
  "spamRulesUrl": "file:///var/lib/stalwart/spam-filter-rules.json.gz",
  "dns": { "ipv4": "192.0.2.10", "sesRegion": "eu-central-1" }
}
EOF

cleanup
docker network create --subnet "$SUBNET_PREFIX.0/24" "$NAME-net" >/dev/null
docker volume create "$NAME-etc" >/dev/null
docker volume create "$NAME-data" >/dev/null
docker run --rm -v "$NAME-etc:/etc/stalwart" -v "$NAME-data:/var/lib/stalwart" -v "$WORK:/work:ro" --entrypoint sh "$IMAGE" -c \
  'printf "%s" "{\"@type\":\"Sqlite\",\"path\":\"/var/lib/stalwart/stalwart.sqlite\",\"poolMaxConnections\":4}" >/etc/stalwart/config.json && cp /work/spam-filter-rules.json.gz /var/lib/stalwart/'

echo "== recovery mode, then kasten setup --bootstrap"
# shellcheck disable=SC2086 # $SIGNIN is two options; the work directory has no spaces
docker run -d --name "$NAME-recovery" --network "$NAME-net" -e STALWART_HOSTNAME=mx.kasten.test \
  -e STALWART_RECOVERY_MODE=1 -e STALWART_RECOVERY_MODE_PORT=8080 --env-file "$WORK/recovery.env" \
  $SIGNIN -v "$NAME-etc:/etc/stalwart" -v "$NAME-data:/var/lib/stalwart" -p "127.0.0.1:$PORT:8080" "$IMAGE" >/dev/null
wait_http
node "$CLI/src/main.ts" setup --config "$WORK/kasten.json" --bootstrap --recovery-admin-file "$WORK/recovery-admin"
docker stop -t 30 "$NAME-recovery" >/dev/null
docker rm "$NAME-recovery" >/dev/null

echo "== normal mode, then the live tests"
# shellcheck disable=SC2086 # as above
docker run -d --name "$NAME-mail" --network "$NAME-net" -e STALWART_HOSTNAME=mx.kasten.test \
  -e "STALWART_PUBLIC_URL=http://127.0.0.1:$PORT" \
  $SIGNIN -v "$NAME-etc:/etc/stalwart" -v "$NAME-data:/var/lib/stalwart" -p "127.0.0.1:$PORT:8080" "$IMAGE" >/dev/null
wait_http

# The first normal run applies what bootstrap defers (x:Jmap, throttles, routes). It must not
# touch x:Asn (bootstrap stores it) and must not need a restart (bootstrap set listeners,
# applications and cleanup schedules before Stalwart's first normal start).
node "$CLI/src/main.ts" setup --config "$WORK/kasten.json" | tee "$WORK/first-normal-setup.txt"

if grep -q '^updated   x:Asn' "$WORK/first-normal-setup.txt"; then
  echo "FAIL: bootstrap did not store x:Asn, so Stalwart inserted its downloading default" >&2
  exit 1
fi

if grep -q '^Restart Stalwart' "$WORK/first-normal-setup.txt"; then
  echo "FAIL: the first normal run after bootstrap needs a restart" >&2
  exit 1
fi

cd "$CLI"
KASTEN_IT_CONFIG="$WORK/kasten.json" ../node_modules/.bin/vitest run --no-file-parallelism test/integration

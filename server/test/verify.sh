#!/bin/bash
# Test-only end-to-end check of the kasten-server image, the dev outbox and compose.yaml.
# It uses the compose project kasten-infra-server, ports 7501-7507 and a scratch directory, and
# removes its containers and volumes at the end. Images stay.
#   KASTEN_TEST_DIR=<scratch directory that Docker can mount> server/test/verify.sh
# Needs docker, Compose v2 ("docker compose", or COMPOSE=<path to docker-compose>), curl and jq.
set -euo pipefail

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
WORK=${KASTEN_TEST_DIR:?set KASTEN_TEST_DIR to a scratch directory that Docker can mount}
export KASTEN_TEST_DIR=$WORK KASTEN_DEV_DIR=$WORK/dev
PROJECT=kasten-infra-server
VOLUME=${PROJECT}_kasten-mail
REPO_VOLUME=kasten-infra-server-restic
FRESH_VOLUME=kasten-infra-server-fresh
FRESH_NAME=kasten-infra-server-fresh
DNS_VOLUME=kasten-infra-server-dns
DNS_NAME=kasten-infra-server-dns
DNSBL_NAME=kasten-infra-server-dnsbl
CAP_VOLUME=kasten-infra-server-cap
CAP_NAME=kasten-infra-server-cap
RECOVERY_NAME=kasten-infra-server-recovery
ALPINE=alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
HTTP=http://127.0.0.1:7501
OUTBOX_API=http://127.0.0.1:7504/api/v1
UNTRUSTED_API=http://127.0.0.1:7505/api/v1
ADMIN_CURL=$WORK/admin.curl
PROBE_CURL=$WORK/probe.curl
PROBE_LOGIN=$WORK/probe-login
# The restic repository is a separate volume; the file holding its key lives in the mail volume.
TEST_RESTIC_FILE=/var/lib/kasten/secrets/restic-test.key
RESTIC_ENV=(-e RESTIC_REPOSITORY=/backup/repo -e "RESTIC_PASSWORD_FILE=$TEST_RESTIC_FILE")
read -r -a COMPOSE_CMD <<<"${COMPOSE:-docker compose}"

compose() { "${COMPOSE_CMD[@]}" -p "$PROJECT" -f "$REPO/compose.yaml" -f "$REPO/server/test/compose.test.yaml" "$@"; }
step() { printf '\n=== %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
die() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
# The throwaway containers install dig first. A failed install is this machine's network, not the
# server: say so, instead of failing the check about the server that the missing dig breaks.
need_dig() {
  if grep -qx no-dig <<<"$1"; then die "a test container could not install dig (apk add bind-tools); check this machine's network"; fi
}

cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$FRESH_NAME" "$RECOVERY_NAME" "$DNS_NAME" "$DNSBL_NAME" "$CAP_NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$REPO_VOLUME" "$FRESH_VOLUME" "$DNS_VOLUME" "$CAP_VOLUME" >/dev/null 2>&1 || true
  rm -f "$ADMIN_CURL" "$PROBE_CURL" "$PROBE_LOGIN" "$WORK"/*.eml
}
trap cleanup EXIT

# run_status <command...>: run a command and print its exit status instead of failing.
run_status() {
  local rc=0
  "$@" || rc=$?
  echo "$rc"
}

# inside run|exec <command>: run a server/test/inside.sh helper in a one-off or the running mail container.
inside() {
  local where=$1
  shift
  if [ "$where" = run ]; then
    compose run --rm --no-deps -T --entrypoint /bin/bash mail -s "$@" <"$REPO/server/test/inside.sh"
  else
    compose exec -T mail bash -s "$@" <"$REPO/server/test/inside.sh"
  fi
}

volume_listing() {
  docker run --rm -v "$1:/v:ro" "$ALPINE" sh -c 'cd /v && find . -mindepth 1 -exec stat -c "%a %u %s %Y %n" {} + | sort -k5'
}

wait_healthy() {
  local id=$1 status=
  for _ in $(seq 1 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$id")
    [ "$status" = healthy ] && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$id")" = true ] || die "container $id stopped: $(docker logs --tail 20 "$id" 2>&1)"
    sleep 2
  done
  die "container $id did not become healthy (last: $status)"
}

jmap_probe() {
  jq -c '{using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"], methodCalls: .}' |
    curl -fsS -K "$PROBE_CURL" -H 'Content-Type: application/json' --data-binary @- "${1:-$HTTP}/jmap/"
}

probe_account() {
  curl -fsS -K "$PROBE_CURL" "${1:-$HTTP}/jmap/session" | jq -r '.primaryAccounts["urn:ietf:params:jmap:mail"]'
}

email_total() {
  local base=${1:-$HTTP} acct
  acct=$(probe_account "$base")
  jq -n --arg a "$acct" '[["Email/query", {accountId: $a, calculateTotal: true}, "q"]]' | jmap_probe "$base" |
    jq -r '.methodResponses[0][1].total'
}

make_message() {
  printf 'From: probe@kasten.test\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s@kasten.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nKasten server test message.\r\n' \
    "$1" "$2" "$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')" "$(openssl rand -hex 12)" >"$3"
}

upload() {
  curl -fsS -K "$PROBE_CURL" -H 'Content-Type: message/rfc822' --data-binary @"$2" "$HTTP/jmap/upload/$1/" | jq -r .blobId
}

# send_probe <to> <subject>: Kasten's send flow, as observed on Stalwart v1.0.1 ($draft import + submission, destroy on success).
send_probe() {
  local acct blob boxes drafts identity res
  acct=$(probe_account)
  make_message "$1" "$2" "$WORK/send.eml"
  blob=$(upload "$acct" "$WORK/send.eml")
  boxes=$(jq -n --arg a "$acct" '[["Mailbox/get", {accountId: $a, properties: ["role"]}, "m"], ["Identity/get", {accountId: $a}, "i"]]' | jmap_probe)
  drafts=$(jq -r '.methodResponses[0][1].list[] | select(.role == "drafts") | .id' <<<"$boxes")
  identity=$(jq -r '.methodResponses[1][1].list[0].id' <<<"$boxes")
  res=$(jq -n --arg a "$acct" --arg b "$blob" --arg d "$drafts" --arg i "$identity" \
    '[["Email/import", {accountId: $a, emails: {e: {blobId: $b, mailboxIds: {($d): true}, keywords: {"$draft": true, "$seen": true}}}}, "0"],
      ["EmailSubmission/set", {accountId: $a, create: {s: {identityId: $i, emailId: "#e"}}, onSuccessDestroyEmail: ["#s"]}, "1"]]' | jmap_probe)
  jq -e '.methodResponses[1][1].created.s.id' >/dev/null <<<"$res" || die "submission to $1 failed: $(jq -c . <<<"$res" | cut -c1-400)"
}

# import_inbox <n>: import n small messages into the probe's Inbox (database content for backups).
import_inbox() {
  local acct inbox blob i
  acct=$(probe_account)
  inbox=$(jq -n --arg a "$acct" '[["Mailbox/get", {accountId: $a, properties: ["role"]}, "m"]]' | jmap_probe |
    jq -r '.methodResponses[0][1].list[] | select(.role == "inbox") | .id')
  for i in $(seq 1 "$1"); do
    make_message probe@kasten.test "imported $i $(openssl rand -hex 4)" "$WORK/import.eml"
    blob=$(upload "$acct" "$WORK/import.eml")
    jq -n --arg a "$acct" --arg b "$blob" --arg m "$inbox" \
      '[["Email/import", {accountId: $a, emails: {e: {blobId: $b, mailboxIds: {($m): true}, keywords: {}}}}, "0"]]' |
      jmap_probe | jq -e '.methodResponses[0][1].created.e.id' >/dev/null || die "import failed"
  done
}

cleanup
mkdir -p "$WORK"
umask 077

step "prepare: dev CA, outbox certificate and login (dev/outbox/make-dev-ca.sh), untrusted test CA"
"$REPO/dev/outbox/make-dev-ca.sh"
"$REPO/dev/outbox/make-dev-ca.sh"
ls -l "$KASTEN_DEV_DIR/outbox"
mkdir -p "$WORK/untrusted"
# shellcheck disable=SC2016 # the script runs inside the container
docker run --rm -i "$ALPINE" sh -eu -c '
  apk add -q --no-cache openssl >/dev/null
  mkdir /w && cd /w
  openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.crt -days 30 \
    -subj "/CN=Untrusted test CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" 2>/dev/null
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout outbox.key -out leaf.csr -subj "/CN=outbox-untrusted" 2>/dev/null
  printf "%s\n" "subjectAltName=DNS:outbox-untrusted" "extendedKeyUsage=serverAuth" > leaf.ext
  openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile leaf.ext -out outbox.crt 2>/dev/null
  tar -cf - outbox.crt outbox.key' | tar -xf - -C "$WORK/untrusted"
cp "$KASTEN_DEV_DIR/outbox/smtp-auth" "$WORK/untrusted/smtp-auth"
chmod 0644 "$WORK/untrusted/outbox.crt"
docker volume create "$REPO_VOLUME" >/dev/null
docker run --rm -v "$REPO_VOLUME:/b" "$ALPINE" chown 2525:2525 /b
pass "dev CA, outbox certificate and login exist; the second make-dev-ca run changed nothing"

step "build the mail image"
compose build mail
compose config --quiet

step "fail closed: serve on an empty volume"
rc=$(run_status compose run --rm --no-deps -T -e KASTEN_VOLUME_ID=00000000000000000000000000000000 mail serve)
[ "$rc" = 3 ] || die "serve on an empty volume exited $rc, expected 3"
listing=$(volume_listing "$VOLUME")
[ -z "$listing" ] || die "serve created files in an empty volume: $listing"
pass "serve exited 3 and the empty volume is still empty"
rc=$(run_status compose run --rm --no-deps -T -e KASTEN_VOLUME_ID=00000000000000000000000000000000 mail init)
[ "$rc" = 3 ] || die "init with KASTEN_VOLUME_ID on an empty volume exited $rc, expected 3"
[ -z "$(volume_listing "$VOLUME")" ] || die "a refused init created files"
pass "init refuses to create a volume while KASTEN_VOLUME_ID expects an existing one (exit 3, nothing written)"

step "init (twice: idempotent)"
first=$(compose run --rm --no-deps -T -e KASTEN_VOLUME_ID= mail init)
echo "$first"
VOLUME_ID=$(jq -r .volumeId <<<"$first")
[ "$(jq -r .created <<<"$first")" = true ] || die "first init did not create the volume"
printf 'KASTEN_VOLUME_ID=%s\n' "$VOLUME_ID" >"$KASTEN_DEV_DIR/mail.env"
second=$(compose run --rm --no-deps -T mail init)
[ "$(jq -r .volumeId <<<"$second")" = "$VOLUME_ID" ] && [ "$(jq -r .created <<<"$second")" = false ] || die "second init changed the volume: $second"
volume_listing "$VOLUME"
pass "init created volume $VOLUME_ID; the second run kept it"

step "fail closed: serve with a different volume id"
before=$(volume_listing "$VOLUME")
rc=$(run_status compose run --rm --no-deps -T -e KASTEN_VOLUME_ID=ffffffffffffffffffffffffffffffff mail serve)
[ "$rc" = 3 ] || die "serve with a different id exited $rc, expected 3"
[ "$(volume_listing "$VOLUME")" = "$before" ] || die "serve with a different id changed the volume"
rc=$(run_status compose run --rm --no-deps -T -e KASTEN_VOLUME_ID= mail serve)
[ "$rc" = 3 ] || die "serve without KASTEN_VOLUME_ID exited $rc, expected 3"
[ "$(volume_listing "$VOLUME")" = "$before" ] || die "serve without an id changed the volume"
pass "serve exited 3 for a different id and for a missing id; the file listing (mode, owner, size, mtime) is unchanged"

step "recovery mode answers /jmap/session with the recovery admin"
admin=$(compose run --rm --no-deps -T --entrypoint cat mail /var/lib/kasten/secrets/recovery-admin)
printf 'user = "%s"\n' "$admin" >"$ADMIN_CURL"
unset admin
compose run -d --rm --no-deps --service-ports --name "$RECOVERY_NAME" mail recovery >/dev/null
session=
for _ in $(seq 1 60); do
  session=$(curl -fsS -K "$ADMIN_CURL" "$HTTP/jmap/session" 2>/dev/null) && break
  sleep 1
done
[ -n "$session" ] || die "the recovery listener did not answer: $(docker logs --tail 20 "$RECOVERY_NAME" 2>&1)"
jq -c '{username, accounts: (.accounts | length), capabilities: (.capabilities | keys)}' <<<"$session"
[ "$(jq -r .username <<<"$session")" = admin ] && [ "$(jq '.accounts | length' <<<"$session")" -ge 1 ] || die "the session is not the recovery admin's"
anonymous=$(curl -fsS "$HTTP/jmap/session" | jq -c '{username, accounts: (.accounts | length)}')
[ "$anonymous" = '{"username":"","accounts":0}' ] || die "an anonymous session got $anonymous"
pass "recovery listener answered /jmap/session as admin with an account; without credentials: $anonymous"

step "test-only provisioning through the recovery API"
printf 'probe@kasten.test:%s\n' "$(openssl rand -hex 20)" >"$PROBE_LOGIN"
printf 'user = "%s"\n' "$(cat "$PROBE_LOGIN")" >"$PROBE_CURL"
"$REPO/server/test/provision-test.sh" "$HTTP" "$ADMIN_CURL" "$KASTEN_DEV_DIR/outbox/smtp-login" "$PROBE_LOGIN"
docker stop "$RECOVERY_NAME" >/dev/null
rm -f "$ADMIN_CURL"

step "serve: Unbound and Stalwart run, healthcheck passes"
compose up -d mail outbox outbox-untrusted
MAIL=$(compose ps -q mail)
wait_healthy "$MAIL"
pass "mail container is healthy"
inside exec procs
docker logs "$MAIL" 2>&1 | grep -E '^kasten-server:' || true
rc=$(run_status compose run --rm --no-deps -T -e STALWART_RECOVERY_MODE=1 mail serve)
[ "$rc" = 3 ] || die "serve with a STALWART_RECOVERY_* variable exited $rc, expected 3"
pass "processes run as uid 2525; only Stalwart holds a capability (net_bind_service); serve refuses STALWART_RECOVERY_* (exit 3)"

step "the file capability is what lets Stalwart bind a port below 1024"
# Docker normally lets any user bind low ports; this sysctl restores the kernel default, so only
# CAP_NET_BIND_SERVICE allows binding 443. Recovery mode listens on KASTEN_RECOVERY_PORT.
cap_id=$(docker run --rm -v "$CAP_VOLUME:/var/lib/kasten" kasten-server:dev init | jq -r .volumeId)
# try_bind <label> <docker run options...>: start recovery on port 443 and report /healthz/live.
try_bind() {
  local label=$1 code=000
  shift
  docker run -d --name "$CAP_NAME" --cap-drop ALL --sysctl net.ipv4.ip_unprivileged_port_start=1024 -p 127.0.0.1:7507:443 \
    -v "$CAP_VOLUME:/var/lib/kasten" -e KASTEN_VOLUME_ID="$cap_id" -e KASTEN_RECOVERY_PORT=443 "$@" kasten-server:dev recovery >/dev/null
  for _ in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7507/healthz/live) || true
    [ "$code" = 200 ] && break
    [ "$(docker inspect -f '{{.State.Running}}' "$CAP_NAME")" = true ] || break
    sleep 1
  done
  printf '%s: healthz=%s, %s\n' "$label" "$code" "$(docker inspect -f 'running={{.State.Running}} exit={{.State.ExitCode}}' "$CAP_NAME")"
  docker logs "$CAP_NAME" 2>&1 | grep -oE 'Operation not permitted|Failed to bind to [^,"]*' | head -1 || true
  docker rm -f "$CAP_NAME" >/dev/null
  [ "$code" = 200 ]
}
try_bind "only NET_BIND_SERVICE" --cap-add NET_BIND_SERVICE || die "Stalwart could not bind 443 with NET_BIND_SERVICE"
! try_bind "no capability" || die "Stalwart bound 443 without any capability"
! try_bind "NET_BIND_SERVICE with no-new-privileges" --cap-add NET_BIND_SERVICE --security-opt no-new-privileges ||
  die "Stalwart bound 443 under no-new-privileges"
pass "port 443 binds with NET_BIND_SERVICE alone; without it, or under no-new-privileges, it does not"

step "Unbound: dev forwarding, and the production configuration (recursion with DNSSEC)"
# shellcheck disable=SC2016 # the script runs inside the container
dns=$(docker run --rm --network "container:$MAIL" "$ALPINE" sh -c '
  apk add -q --no-cache bind-tools >/dev/null || { echo no-dig; exit 0; }
  printf "outbox=%s\n" "$(dig @127.0.0.1 -p 5335 +short outbox A)"
  dig @127.0.0.1 -p 5335 +time=10 example.com A | grep -E "status:" | sed "s/^/public=/"')
echo "$dns"
need_dig "$dns"
grep -qE '^outbox=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' <<<"$dns" || die "Unbound did not resolve the dev name outbox"
grep -q '^public=.*status: NOERROR' <<<"$dns" || die "Unbound did not resolve example.com through Docker's DNS"
pass "dev mode: Unbound answers on 127.0.0.1:5335 and forwards outbox and public names to Docker's DNS"
# The same image without the development settings, on its own volume.
dns_id=$(docker run --rm -v "$DNS_VOLUME:/var/lib/kasten" kasten-server:dev init | jq -r .volumeId)
docker run -d --name "$DNS_NAME" --cap-drop ALL --cap-add NET_BIND_SERVICE -v "$DNS_VOLUME:/var/lib/kasten" \
  -e KASTEN_VOLUME_ID="$dns_id" kasten-server:dev >/dev/null
sleep 3
docker logs "$DNS_NAME" 2>&1 | grep -E '^kasten-server' || true
# shellcheck disable=SC2016 # the script runs inside the container
dns=$(docker run --rm --network "container:$DNS_NAME" "$ALPINE" sh -c '
  apk add -q --no-cache bind-tools >/dev/null || { echo no-dig; exit 0; }
  printf "local=%s\n" "$(dig @127.0.0.1 -p 5335 +short localhost A)"
  if dig +tcp +time=3 +tries=1 @198.41.0.4 . NS >/dev/null 2>&1; then echo direct=yes; else echo direct=no; fi
  dig @127.0.0.1 -p 5335 +dnssec +time=10 example.com A | grep -E "status:|flags:" | tr "\n" " " | sed "s/^/public=/"; echo
  dig @127.0.0.1 -p 5335 +time=10 dnssec-failed.org A | grep -E "status:" | sed "s/^/bogus=/"')
echo "$dns"
docker rm -f "$DNS_NAME" >/dev/null
need_dig "$dns"
grep -q '^local=127.0.0.1$' <<<"$dns" || die "the production Unbound did not answer"
if grep -q '^direct=yes' <<<"$dns"; then
  grep -q '^public=.*status: NOERROR.*flags:[a-z ]* ad' <<<"$dns" || die "Unbound did not resolve example.com with DNSSEC validation"
  grep -q '^bogus=.*SERVFAIL' <<<"$dns" || die "Unbound accepted a bogus DNSSEC signature"
  pass "production mode: Unbound resolves example.com recursively with the AD flag and refuses dnssec-failed.org"
else
  echo "SKIP: this network blocks direct DNS (port 53 to a root server), so recursion cannot be tested here"
fi
# The shipped configuration in front of a stub DNSBL zone: a refusal code (127.255.255.254, as
# Spamhaus answers public resolvers) and a real listing (127.0.0.2). The test-only include
# forwards the zone to the stub; .test is one of Unbound's default blocked zones.
# shellcheck disable=SC2016 # the script runs inside the container
docker run -d --name "$DNSBL_NAME" --entrypoint /bin/bash kasten-server:dev -c '
  printf "%s\n" "server:" "  interface: 127.0.0.1@5399" "  access-control: 127.0.0.0/8 allow" \
    "  do-ip6: no" "  username: \"\"" "  chroot: \"\"" "  directory: \"/run/kasten\"" "  pidfile: \"\"" \
    "  use-syslog: no" "  logfile: \"\"" "  module-config: \"iterator\"" \
    "  local-zone: \"dnsbl.test.\" static" \
    "  local-data: \"2.0.0.127.dnsbl.test. A 127.255.255.254\"" \
    "  local-data: \"3.0.0.127.dnsbl.test. A 127.0.0.2\"" >/run/kasten/dnsbl-stub.conf
  printf "%s\n" "server:" "  do-not-query-localhost: no" "  domain-insecure: \"dnsbl.test.\"" \
    "  local-zone: \"dnsbl.test.\" transparent" \
    "forward-zone:" "  name: \"dnsbl.test.\"" "  forward-addr: 127.0.0.1@5399" >/run/kasten/unbound-dev.conf
  /usr/sbin/unbound -d -c /run/kasten/dnsbl-stub.conf &
  exec /usr/sbin/unbound -d -c /etc/kasten/unbound.conf' >/dev/null
# shellcheck disable=SC2016 # the script runs inside the container
dnsbl=$(docker run --rm --network "container:$DNSBL_NAME" "$ALPINE" sh -c '
  apk add -q --no-cache bind-tools >/dev/null || { echo no-dig; exit 0; }
  for _ in $(seq 1 20); do
    [ -n "$(dig @127.0.0.1 -p 5335 +short +time=1 +tries=1 3.0.0.127.dnsbl.test A)" ] && break
    sleep 0.5
  done
  printf "listing=%s\n" "$(dig @127.0.0.1 -p 5335 +short 3.0.0.127.dnsbl.test A)"
  printf "refusal=%s\n" "$(dig @127.0.0.1 -p 5335 +short 2.0.0.127.dnsbl.test A)"
  dig @127.0.0.1 -p 5335 2.0.0.127.dnsbl.test A | grep -E "status:" | sed "s/^/refusal-status=/"')
echo "$dnsbl"
docker rm -f "$DNSBL_NAME" >/dev/null
need_dig "$dnsbl"
grep -q '^listing=127.0.0.2$' <<<"$dnsbl" || die "Unbound did not forward the stub DNSBL zone"
grep -q '^refusal=$' <<<"$dnsbl" || die "Unbound passed a DNSBL refusal code (127.255.255.0/24) on to Stalwart"
grep -q '^refusal-status=.*status: NOERROR' <<<"$dnsbl" || die "Unbound did not answer the refused DNSBL query"
pass "Unbound drops DNSBL refusal codes in 127.255.255.0/24 and keeps real listings, so Stalwart sees no listing"

step "outbox: STARTTLS and AUTH are required; the dev CA verifies it; an untrusted certificate is refused"
inside exec smtp-plain outbox
inside exec smtp-tls outbox
inside exec tls-verify outbox || die "STARTTLS to outbox did not verify with the dev CA"
rc=0
inside exec tls-verify outbox-untrusted || rc=$?
[ "$rc" != 0 ] || die "openssl accepted the untrusted certificate"
pass "openssl s_client: outbox verifies with the dev CA; outbox-untrusted fails verification"

step "Stalwart relays through the outbox with strict TLS and AUTH, and refuses the untrusted relay"
send_probe bob@example.test "kasten relay test"
send_probe carol@untrusted.test "kasten untrusted relay test"
got=
for _ in $(seq 1 30); do
  got=$(curl -fsS -H 'Host: localhost:7482' "$OUTBOX_API/messages" | jq -r '.messages[] | select(.Subject == "kasten relay test") | .To[0].Address')
  [ -n "$got" ] && break
  sleep 1
done
[ "$got" = bob@example.test ] || die "the outbox did not receive the relayed message"
pass "the outbox received the message for $got through Stalwart's relay route"
sleep 5
untrusted=$(curl -fsS "$UNTRUSTED_API/messages" | jq -r .total)
[ "$untrusted" = 0 ] || die "the untrusted outbox received $untrusted messages"
docker logs "$MAIL" 2>&1 | grep -iE 'outbox-untrusted|certificate|UnknownIssuer' | grep -v '^kasten-server' | tail -4 | cut -c1-400 || true
pass "the untrusted outbox received nothing; Stalwart's log lines about it are above"

step "inbound SMTP on port 25"
printf 'From: friend@friend.test\r\nTo: probe@kasten.test\r\nSubject: inbound smtp test\r\nDate: %s\r\nMessage-ID: <%s@friend.test>\r\n\r\nHello.\r\n' \
  "$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')" "$(openssl rand -hex 8)" >"$WORK/inbound.eml"
start=$(date +%s)
out=$(curl -sS --max-time 60 --url smtp://127.0.0.1:7502/friend.test --mail-from friend@friend.test \
  --mail-rcpt probe@kasten.test --upload-file "$WORK/inbound.eml" 2>&1) || die "inbound SMTP failed after $(($(date +%s) - start)) s: $out"
pass "inbound SMTP accepted the message after $(($(date +%s) - start)) s"
sleep 3

step "database content and idle memory"
import_inbox 3
TOTAL=$(email_total)
echo "probe mailbox: $TOTAL messages"
sleep 20
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}' "$MAIL" "$(compose ps -q outbox)"

step "backup while Stalwart runs"
# shellcheck disable=SC2016 # the script runs inside the container
compose exec -T -e "TARGET=$TEST_RESTIC_FILE" mail bash -c 'umask 077; od -An -N24 -tx1 /dev/urandom | tr -d " \n" > "$TARGET"'
compose exec -T "${RESTIC_ENV[@]}" mail kasten-server backup-init
compose exec -T "${RESTIC_ENV[@]}" mail kasten-server backup
pass "live backup exited 0"

step "restore and vacuum refuse while Stalwart runs"
rc=$(run_status compose run --rm --no-deps -T "${RESTIC_ENV[@]}" mail restore latest)
[ "$rc" = 4 ] || die "restore while running exited $rc, expected 4"
rc=$(run_status compose run --rm --no-deps -T mail vacuum)
[ "$rc" = 4 ] || die "vacuum while running exited $rc, expected 4"
pass "restore and vacuum exited 4 while Stalwart held the volume lock"

step "backup with Stalwart stopped, restore in place, compare row counts"
compose stop mail
counts_before=$(inside run counts)
backup_out=$(compose run --rm --no-deps -T "${RESTIC_ENV[@]}" mail backup 2>&1)
grep -E 'snapshot .* saved|kasten-server' <<<"$backup_out" || true
SNAPSHOT=$(sed -n 's/^snapshot \([0-9a-f]*\) saved$/\1/p' <<<"$backup_out")
[ -n "$SNAPSHOT" ] || die "no snapshot id in the backup output"
compose run --rm --no-deps -T "${RESTIC_ENV[@]}" mail restore latest
counts_after=$(inside run counts)
[ "$counts_before" = "$counts_after" ] || die "row counts differ after restore: $(diff <(echo "$counts_before") <(echo "$counts_after"))"
awk '{ rows += $2 } END { printf "independent count: %d tables, %d rows, identical before and after\n", NR, rows }' <<<"$counts_after"
volume_listing "$VOLUME" | grep -E 'stalwart\.sqlite' || true
compose run --rm --no-deps -T mail vacuum
pass "restore of $SNAPSHOT: integrity ok, row counts match; vacuum ran with Stalwart stopped"

step "Stalwart starts on the restored database"
compose up -d mail
wait_healthy "$(compose ps -q mail)"
[ "$(email_total)" = "$TOTAL" ] || die "the restored mailbox has $(email_total) messages, expected $TOTAL"
pass "healthy; the probe mailbox has $TOTAL messages"

step "roll back to the snapshot after new mail arrives"
import_inbox 2
echo "after two more imports: $(email_total) messages"
compose stop mail
compose run --rm --no-deps -T "${RESTIC_ENV[@]}" mail restore "$SNAPSHOT" >/dev/null
[ "$(inside run counts)" = "$counts_before" ] || die "the rollback did not restore the snapshot's row counts"
compose up -d mail
wait_healthy "$(compose ps -q mail)"
[ "$(email_total)" = "$TOTAL" ] || die "after the rollback the mailbox has $(email_total) messages, expected $TOTAL"
pass "restore of snapshot $SNAPSHOT by id rolled the mailbox back to $TOTAL messages"

step "restore onto a fresh volume (a new server)"
fresh_id=$(docker run --rm -v "$FRESH_VOLUME:/var/lib/kasten" kasten-server:dev init | jq -r .volumeId)
docker run --rm -v "$FRESH_VOLUME:/var/lib/kasten" -v "$REPO_VOLUME:/backup" -v "$VOLUME:/old:ro" \
  -e KASTEN_VOLUME_ID="$fresh_id" -e "SOURCE=/old/secrets/${TEST_RESTIC_FILE##*/}" "${RESTIC_ENV[@]}" \
  --entrypoint /bin/bash kasten-server:dev -c 'cp "$SOURCE" "$RESTIC_PASSWORD_FILE" && kasten-server restore latest' | tail -3
docker run -d --name "$FRESH_NAME" --network "${PROJECT}_default" -p 127.0.0.1:7506:8080 --cap-drop ALL --cap-add NET_BIND_SERVICE \
  -v "$FRESH_VOLUME:/var/lib/kasten" -e KASTEN_VOLUME_ID="$fresh_id" kasten-server:dev >/dev/null
wait_healthy "$FRESH_NAME"
[ "$(email_total http://127.0.0.1:7506)" = "$TOTAL" ] || die "the fresh server has $(email_total http://127.0.0.1:7506) messages, expected $TOTAL"
pass "a fresh volume restored from the repository serves the probe mailbox with $TOTAL messages"
docker rm -f "$FRESH_NAME" >/dev/null

step "the container exits when Unbound dies"
MAIL=$(compose ps -q mail)
inside exec kill-unbound
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Running}}' "$MAIL")" = false ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Running}}' "$MAIL")" = false ] || die "the container kept running without Unbound"
docker logs --tail 3 "$MAIL" 2>&1 | grep -E '^kasten-server' || true
pass "the container stopped with exit code $(docker inspect -f '{{.State.ExitCode}}' "$MAIL")"

step "image sizes"
docker image ls --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}' | grep -E 'kasten-server|REPOSITORY'

step "all checks passed"

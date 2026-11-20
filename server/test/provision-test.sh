#!/bin/bash
# Test-only: the minimal Stalwart configuration that server/test/verify.sh needs, applied through
# the recovery-mode management API. Never use it for a real server; "kasten setup" owns that.
#   provision-test.sh <base-url> <admin-curl-config> <relay-login-file> <probe-login-file>
# Secrets stay in files: curl reads the admin login from a config file, and jq reads the relay and
# probe logins with --rawfile, so no secret appears in a command line.
set -euo pipefail

BASE=$1 ADMIN=$2 RELAY_LOGIN=$3 PROBE_LOGIN=$4

# call <method>: send the arguments on stdin as one urn:stalwart:jmap call; print the response.
call() {
  local res
  res=$(jq -c --arg m "$1" '{using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], methodCalls: [[$m, ., "c"]]}' |
    curl -fsS -K "$ADMIN" -H 'Content-Type: application/json' --data-binary @- "$BASE/jmap/")
  if ! jq -e '.methodResponses[0] | .[0] != "error" and ((.[1].notCreated // {}) == {}) and ((.[1].notUpdated // {}) == {})' >/dev/null <<<"$res"; then
    echo "provision-test: $1 failed: $(jq -c '.methodResponses[0]' <<<"$res" | cut -c1-600)" >&2
    exit 1
  fi
  printf '%s\n' "$res"
}

listener() {
  jq -n --arg n "$1" --arg p "$2" --arg b "0.0.0.0:$3" '{name: $n, protocol: $p, bind: {($b): true}, useTls: false, implicitTls: false}'
}

jq -n --argjson h "$(listener http http 8080)" --argjson s "$(listener smtp smtp 25)" --argjson i "$(listener imap imap 143)" \
  '{create: {http: $h, smtp: $s, imap: $i}}' | call x:NetworkListener/set >/dev/null

jq -n '{update: {singleton: {"@type": "Custom", servers: {
  "0": {protocol: "udp", address: "127.0.0.1", port: 5335},
  "1": {protocol: "tcp", address: "127.0.0.1", port: 5335}}, timeout: 5000, attempts: 2}}}' |
  call x:DnsResolver/set >/dev/null

domain=$(jq -n '{create: {d: {name: "kasten.test", certificateManagement: {"@type": "Manual"}, dnsManagement: {"@type": "Manual"}}}}' |
  call x:Domain/set | jq -r '.methodResponses[0][1].created.d.id')

jq -n --arg d "$domain" '{update: {singleton: {defaultHostname: "mail.kasten.test", defaultDomainId: $d}}}' |
  call x:SystemSettings/set >/dev/null

jq -n --arg d "$domain" --rawfile login "$PROBE_LOGIN" \
  '($login | rtrimstr("\n") | split(":")) as $l
   | {create: {p: {"@type": "User", name: ($l[0] | split("@")[0]), domainId: $d,
                   credentials: {"0": {"@type": "Password", secret: ($l[1:] | join(":"))}}}}}' |
  call x:Account/set >/dev/null

jq -n --rawfile login "$RELAY_LOGIN" \
  '($login | rtrimstr("\n") | split(":")) as $l
   | def relay($n; $h): {"@type": "Relay", name: $n, host: $h, port: 587, protocol: "smtp",
       implicitTls: false, allowInvalidCerts: false, authUsername: $l[0],
       authSecret: {"@type": "Value", secret: ($l[1:] | join(":"))}};
   {create: {o: relay("outbox"; "outbox"), u: relay("untrusted"; "outbox-untrusted")}}' |
  call x:MtaRoute/set >/dev/null

jq -n '{create: {s: {name: "strict", startTls: "require", allowInvalidCerts: false, dane: "disable", mtaSts: "disable"}}}' |
  call x:MtaTlsStrategy/set >/dev/null

jq -n --arg local "'local'" --arg untrusted "'untrusted'" --arg outbox "'outbox'" --arg strict "'strict'" \
  --arg is_untrusted "rcpt_domain == 'untrusted.test'" \
  '{update: {singleton: {
     route: {match: {"0": {if: "is_local_domain(rcpt_domain)", then: $local}, "1": {if: $is_untrusted, then: $untrusted}},
             else: $outbox},
     tls: {match: {}, else: $strict}}}}' |
  call x:MtaOutboundStrategy/set >/dev/null

jq -n '{update: {singleton: {dkimSignDomain: {match: {}, else: "false"}}}}' | call x:MtaStageData/set >/dev/null
jq -n '{update: {singleton: {spamFilterRulesUrl: "file:///var/lib/kasten/stalwart/spam-filter-rules.json.gz", maxRedirectUrls: 0}}}' |
  call x:SpamSettings/set >/dev/null
jq -n '{update: {singleton: {"@type": "Disabled"}}}' | call x:Asn/set >/dev/null
jq -n '{create: {t: {"@type": "Stdout", level: "info", ansi: false, buffered: false}}}' | call x:Tracer/set >/dev/null

apps=$(jq -n '{ids: null}' | call x:Application/get | jq -c '[.methodResponses[0][1].list[].id]')
if [ "$apps" != "[]" ]; then
  jq -n --argjson ids "$apps" '{update: ($ids | map({key: ., value: {enable: false}}) | from_entries)}' |
    call x:Application/set >/dev/null
fi
echo "provision-test: listeners, resolver, domain, probe account, relay routes and tracer are configured"

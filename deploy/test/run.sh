#!/usr/bin/env bash
# The single-quoted strings are scripts for the containers' shells.
# shellcheck disable=SC2016
# Local acceptance test for deploy/: a Fedora 45 VPS in a container with systemd as PID 1, where
# install.sh sets up rootless Podman and the real images run, and Debian 13 containers for the
# Tang host and a client on the internet side.
#
#   deploy/test/run.sh all          every stage, then cleanup
#   deploy/test/run.sh <stage>...   up install firewall server links selinux tang bind check probe
#                                   backup residue crash unlock reboot ports down
#
# It needs Docker on a Linux VM that allows privileged containers, with the dm_crypt and loop
# modules loaded, jq on this machine, and the image kasten-server:${KASTEN_TEST_SERVER_IMAGE_TAG:-dev-arm64}
# for the "server" stage. It builds the kasten-cli image from this checkout. It creates only
# containers, networks, volumes and images named kasten-deploytest-*, publishes no ports, and
# "down" removes all of them. install.sh in the VPS downloads its packages from Fedora's mirrors.
#
# Where a container differs from a VPS, the test says so:
#   - no SELinux: a container cannot enforce it. The test creates /etc/kasten/test-without-selinux,
#     without which install.sh and kasten-podman refuse to run; the "selinux" stage shows both
#     refusals. Enforcing SELinux is tested on Fedora in a VM (test/lima);
#   - Docker leaves / private: a test unit makes it shared, as systemd does on a VPS;
#   - the image lost the file capabilities of newuidmap and newgidmap, and /etc/shadow has mode 0400
#     for the VM's AppArmor profile of unix_chkpwd (test/Dockerfile.fedora says why);
#   - Docker sets net.ipv4.ip_unprivileged_port_start to 0 in a container: the test sets the
#     kernel's default, 1024, before install.sh;
#   - /var/lib and /home are Docker volumes, so that Podman's storage is not on overlayfs;
#   - no udev: device-mapper creates its own nodes (DM_DISABLE_UDEV=1) and a test unit creates
#     the loop nodes;
#   - no binfmt: systemd-binfmt is masked, because binfmt_misc belongs to the shared VM kernel;
#   - no Tailscale: a stand-in tailscaled.service renames the test tailnet interface tailscale0;
#   - the swap step is skipped, because zram and swap belong to the shared VM kernel;
#   - a reboot or poweroff ends the container; the test starts it again, on the same kernel;
#   - no direct DNS on this network: test/mail.env makes Unbound forward to Docker's DNS;
#   - no ACME: test/kasten.json uses the dev-mode HTTP listener on 127.0.0.1:8080;
#   - no SES: a Mailpit container stands in for it on port 587, with STARTTLS, a certificate from
#     a test CA that only the test's mail container trusts, and any login. It relays the probe's
#     messages to the VPS's port 25, as SES and the public MX would.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
P=kasten-deploytest
VPS=$P-vps TANG=$P-tang CLIENT=$P-client
PUB=$P-pub TS=$P-ts
VPS4=10.75.50.10 VPS6=fd75:7550::10 VPS_TS=100.100.75.5
CLIENT4=10.75.50.20 CLIENT6=fd75:7550::20 CLIENT_TS=100.100.75.20
# The relay's name is test/kasten.json's relays[0].host. It is outside .test, because Unbound answers
# every .test name itself, with NXDOMAIN (RFC 6761), even when it forwards everything else.
RELAY=$P-relay RELAY4=10.75.50.40 RELAY6=fd75:7550::40 RELAY_HOST=ses-relay
# The same pins as compose.yaml's outbox and dev/outbox/make-dev-ca.sh.
MAILPIT=axllent/mailpit:v1.33.0@sha256:9b3a463be15354c0f0eba91697d80e3e0d8a5623ef0e627cacc836bc17fd5231
ALPINE=alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
TANG_IP=100.100.75.10 TANG_LISTEN=100.100.75.11 TANG_PORT=7550
TANG_URL=http://$TANG_LISTEN:$TANG_PORT
SERVER_IMAGE=kasten-server:${KASTEN_TEST_SERVER_IMAGE_TAG:-dev-arm64}
CLI_IMAGE=$P-cli:1
ACCOUNT=you@kasten.test
# Records of how the units stop at a reboot, on the VPS's disk (/var/lib is a Docker volume):
# journald keeps its logs in RAM, which the reboot clears.
SHUTDOWN_LOG=/var/lib/kasten-deploytest/shutdown.log
FAILS=0

say() { printf '\n== %s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  FAILS=$((FAILS + 1))
}
# check <description> <command...>: passes if the command succeeds.
check() {
  local d=$1
  shift
  if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi
}
# refuse <description> <command...>: passes if the command fails.
refuse() {
  local d=$1
  shift
  if "$@" >/dev/null 2>&1; then fail "$d"; else pass "$d"; fi
}
# shown <description> <command...>: like check, and prints the end of the command's output.
shown() {
  local d=$1 out rc=0
  shift
  out=$("$@" 2>&1) || rc=$?
  printf '%s\n' "$out" | tail -n "${SHOWN_LINES:-12}" | sed 's/^/      /'
  if [ "$rc" -eq 0 ]; then pass "$d"; else fail "$d (exit $rc)"; fi
}
# wait_for <seconds> <command...>: succeeds once the command does, trying once a second.
wait_for() {
  local n=$1 _
  shift
  for _ in $(seq 1 "$n"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
vx() { docker exec -e DM_DISABLE_UDEV=1 "$VPS" "$@"; }
vsh() { docker exec -e DM_DISABLE_UDEV=1 "$VPS" sh -c "$1"; }
tx() { docker exec "$TANG" "$@"; }
tsh() { docker exec "$TANG" sh -c "$1"; }
cx() { docker exec "$CLIENT" "$@"; }
# kx <script>: a shell script in the VPS as the kasten user, as a container's root would run it.
kx() { docker exec "$VPS" setpriv --reuid=2600 --regid=2600 --init-groups sh -c "$1"; }
# kcli <command...>: the kasten CLI on the VPS, in a one-shot container (kasten-cli).
kcli() { docker exec "$VPS" kasten-cli "$@" --config /etc/kasten/kasten.json; }

wait_boot() {
  local _
  for _ in $(seq 1 90); do
    case $(docker exec "$1" systemctl is-system-running 2>/dev/null || true) in
      running | degraded) return 0 ;;
    esac
    sleep 1
  done
  echo "$1 did not finish booting" >&2
  return 1
}

# The VM's binfmt_misc handlers, seen from a privileged container. Rosetta, for example, must
# survive the test: binfmt_misc is shared by every container on the VM.
binfmt_handlers() {
  docker run --rm --privileged --entrypoint sh $P-systemd:1 -c \
    'mountpoint -q /proc/sys/fs/binfmt_misc || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc; ls /proc/sys/fs/binfmt_misc | tr "\n" " "'
}
BINFMT_BEFORE=

# The SES stand-in's files, made in a throwaway container: a test CA, a certificate for the
# relay's host name ($1) and Mailpit's settings for relaying to the VPS ($2). The CA's key never
# leaves that container.
RELAY_FILES_SH='apk add -q --no-cache openssl >/dev/null
cd /out
umask 077
openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -sha256 -days 2 \
  -keyout /tmp/ca.key -out ca.crt -subj "/CN=Kasten deploy test CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout relay.key -out /tmp/relay.csr \
  -subj "/CN=$1" 2>/dev/null
printf "%s\n" "basicConstraints=critical,CA:FALSE" "keyUsage=critical,digitalSignature" \
  "extendedKeyUsage=serverAuth" "subjectAltName=DNS:$1" >/tmp/leaf.ext
openssl x509 -req -in /tmp/relay.csr -CA ca.crt -CAkey /tmp/ca.key -CAcreateserial -CAserial /tmp/ca.srl \
  -sha256 -days 2 -extfile /tmp/leaf.ext -out relay.crt 2>/dev/null
openssl verify -CAfile ca.crt -verify_hostname "$1" relay.crt >/dev/null
printf "host: %s\nport: 25\nstarttls: false\nauth: none\npreserve-message-ids: true\n" "$2" >relay.yaml
chmod 0644 ca.crt relay.crt relay.yaml'

# relay_up: Mailpit as SES on port 587, reachable as $RELAY_HOST. Like SES, it needs STARTTLS. It
# accepts any login, and relays mail for the probe account to the VPS's port 25. Mailpit greets
# with its host name, and Stalwart refuses an EHLO that is not a domain name.
relay_up() {
  docker volume create $P-relay >/dev/null
  docker run --rm -v $P-relay:/out "$ALPINE" sh -eu -c "$RELAY_FILES_SH" relay-files "$RELAY_HOST" "$VPS4"
  docker run -d --name "$RELAY" --hostname relay.ses.test --network $PUB --ip $RELAY4 --ip6 $RELAY6 \
    --network-alias "$RELAY_HOST" -v $P-relay:/etc/relay:ro "$MAILPIT" \
    --smtp=0.0.0.0:587 --smtp-tls-cert=/etc/relay/relay.crt --smtp-tls-key=/etc/relay/relay.key \
    --smtp-require-starttls --smtp-auth-accept-any --smtp-disable-rdns --listen=127.0.0.1:8025 \
    --disable-version-check --smtp-relay-config=/etc/relay/relay.yaml \
    '--smtp-relay-matching=^probe@kasten\.test$' >/dev/null
}
# relay_count: how many messages the SES stand-in has received.
relay_count() { docker exec "$RELAY" wget -qO- http://127.0.0.1:8025/api/v1/messages | jq -er .total; }

stage_up() {
  say "images, networks and containers"
  docker build -q -t $P-systemd:1 "$ROOT/deploy/test" >/dev/null
  docker build -q --build-arg EXTRA="tang nftables curl jose" -t $P-tang:1 "$ROOT/deploy/test" >/dev/null
  docker build -q -f "$ROOT/deploy/test/Dockerfile.fedora" -t $P-fedora:1 "$ROOT/deploy/test" >/dev/null
  docker build -q -f "$ROOT/cli/Dockerfile" -t "$CLI_IMAGE" "$ROOT" >/dev/null
  BINFMT_BEFORE=$(binfmt_handlers)
  echo "the VM's binfmt handlers before the test: $BINFMT_BEFORE"
  docker network create --subnet 10.75.50.0/24 --ipv6 --subnet fd75:7550::/64 $PUB >/dev/null
  docker network create --internal --subnet 100.100.75.0/24 $TS >/dev/null
  docker volume create $P-varlib >/dev/null
  docker volume create $P-home >/dev/null
  relay_up
  local sysd=(--privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock)
  docker run -d --name "$TANG" --hostname tang "${sysd[@]}" --network $TS --ip $TANG_IP $P-tang:1 >/dev/null
  docker run -d --name "$CLIENT" --hostname client --network $PUB --ip $CLIENT4 --ip6 $CLIENT6 \
    --entrypoint sleep $P-systemd:1 infinity >/dev/null
  docker create --name "$VPS" --hostname kasten-vps "${sysd[@]}" -v $P-varlib:/var/lib -v $P-home:/home \
    --network $PUB --ip $VPS4 --ip6 $VPS6 $P-fedora:1 >/dev/null
  docker network connect --ip $VPS_TS $TS "$VPS"
  docker start "$VPS" >/dev/null
  wait_boot "$VPS"
  wait_boot "$TANG"
  vsh '. /etc/os-release; echo "the VPS: $PRETTY_NAME, kernel $(uname -r), SELinux $(getenforce)"'
  check "the VPS has a tailscale0 interface (stand-in)" vx test -e /sys/class/net/tailscale0
  check "systemd-binfmt and the binfmt_misc mount are masked in the test containers" \
    vsh 'for u in systemd-binfmt.service proc-sys-fs-binfmt_misc.automount proc-sys-fs-binfmt_misc.mount; do [ "$(systemctl is-enabled $u 2>/dev/null)" = masked ] || exit 1; done'
  check "the VPS's / is a shared mount (test unit), as on a VPS" vsh 'findmnt -n -o PROPAGATION / | grep -q shared'
  vx sysctl -q -w net.ipv4.ip_unprivileged_port_start=1024
  vsh 'echo "before install.sh: systemd-oomd is $(systemctl is-enabled systemd-oomd.service) and $(systemctl is-active systemd-oomd.service), as on Fedora Cloud"' || true
  # A throwaway recovery passphrase, generated inside the container and never printed.
  vsh 'umask 077; head -c 30 /dev/urandom | base64 | tr -d "\n/+=" >/root/recovery-passphrase'
}

INSTALL=(/root/kasten-deploy/host/install.sh --skip swap --data-size 2G --mail-api-host mail.kasten.test
  --passphrase-file /root/recovery-passphrase)

copy_deploy() {
  vx rm -rf /root/kasten-deploy
  docker cp "$ROOT/deploy" "$VPS:/root/kasten-deploy"
}

# reinstall <install.sh options...>: a quick re-run of install.sh without packages and swap. These
# runs come faster than nftables.service's start limit (five in 10 s) allows restarts, so they also
# check that install.sh reloads the firewall rather than restarting it.
reinstall() {
  docker exec -e DM_DISABLE_UDEV=1 "$VPS" /root/kasten-deploy/host/install.sh --skip swap --skip packages "$@" </dev/null
}
url_replaced() {
  reinstall --mail-api-host Mail2.Kasten.Test >/dev/null 2>&1 &&
    vsh 'grep -qx STALWART_PUBLIC_URL=https://mail2.kasten.test /opt/kasten/.env && grep -qx KASTEN_VERSION=keep-me /opt/kasten/.env && test "$(grep -c ^STALWART_PUBLIC_URL= /opt/kasten/.env)" = 1'
}
url_kept() {
  reinstall >/dev/null 2>&1 && vsh 'grep -qx STALWART_PUBLIC_URL=https://mail2.kasten.test /opt/kasten/.env'
}

stage_install() {
  copy_deploy
  say "install.sh while SELinux is not enforcing"
  local out rc=0
  out=$(docker exec -e DM_DISABLE_UDEV=1 -e SSH_CONNECTION="$CLIENT_TS 50000 $VPS_TS 22" "$VPS" "${INSTALL[@]}" 2>&1) || rc=$?
  printf '%s\n' "$out" | tail -n 1 | sed 's/^/      /'
  if [ "$rc" -ne 0 ] && grep -q 'SELinux is not enforcing' <<<"$out"; then
    pass "install.sh refuses to run (exit $rc)"
  else
    fail "install.sh did not refuse to run without enforcing SELinux (exit $rc)"
  fi
  refuse "the refused run created no kasten user" vx getent passwd kasten
  # Test only. Never create this file on a real host.
  vsh 'install -d -m 0755 /etc/kasten && : >/etc/kasten/test-without-selinux'

  say "install.sh, first run, from a public SSH address that is not an admin address"
  rc=0
  out=$(docker exec -e DM_DISABLE_UDEV=1 -e SSH_CONNECTION="203.0.113.9 50000 $VPS4 22" "$VPS" "${INSTALL[@]}" 2>&1) || rc=$?
  printf '%s\n' "$out" | grep '^install:' || true
  [ "$rc" -eq 0 ] || printf '%s\n' "$out" | grep -v '^install:' | tail -n 15
  if [ "$rc" -ne 0 ] && grep -q 'which the new firewall would block' <<<"$out"; then
    pass "install.sh refuses a firewall that would block the current SSH session (exit $rc)"
  else
    fail "install.sh did not refuse the firewall for a blocked SSH session (exit $rc)"
  fi
  check "it warned loudly that it did not check SELinux, because of the test's file" \
    grep -q 'WARNING: /etc/kasten/test-without-selinux exists' <<<"$out"
  refuse "no firewall table was loaded by the refused run" vx nft list table inet kasten

  say "install.sh, second run, over the tailnet"
  rc=0
  out=$(docker exec -e DM_DISABLE_UDEV=1 -e SSH_CONNECTION="$CLIENT_TS 50000 $VPS_TS 22" "$VPS" "${INSTALL[@]}" 2>&1) || rc=$?
  printf '%s\n' "$out" | grep '^install:' || true
  [ "$rc" -eq 0 ] || printf '%s\n' "$out" | grep -v '^install:' | tail -n 15
  if [ "$rc" -eq 0 ]; then pass "install.sh completes (exit 0)"; else fail "install.sh failed (exit $rc)"; fi

  say "what install.sh set up"
  vsh 'rpm -q podman crun conmon passt catatonit nftables cryptsetup clevis clevis-luks dnf5-plugin-automatic dnf5-plugins zram-generator sqlite' || true
  check "dnf5 needs-restarting exists (dnf5-plugins), for the operator's reboot check" vsh 'dnf5 needs-restarting --help >/dev/null 2>&1'
  vsh 'rc=0; dnf5 -q needs-restarting >/dev/null 2>&1 || rc=$?; echo "      dnf5 needs-restarting: exit $rc (1: a reboot is due, or an error)"' || true
  refuse "clevis-systemd is not installed" vx rpm -q --quiet clevis-systemd
  vsh 'dnf5 -q repo info fedora updates 2>/dev/null | grep -iE "^ *metalink"' || true
  check "dnf uses HTTPS mirrors only, and the OpenH264 repository is off" \
    vsh 'test "$(dnf5 -q repo info fedora updates 2>/dev/null | grep -iE "^ *metalink" | grep -c "protocol=https")" = 2 && ! dnf5 -q repo list --enabled 2>/dev/null | grep -q openh264'
  check "dnf5-automatic.timer is on, and applies every update without a reboot" \
    vsh 'systemctl is-enabled -q dnf5-automatic.timer && systemctl is-active -q dnf5-automatic.timer && grep -qx "upgrade_type = default" /etc/dnf/automatic.conf && grep -qx "apply_updates = yes" /etc/dnf/automatic.conf && grep -qx "reboot = never" /etc/dnf/automatic.conf'
  check "masked: systemd-oomd (service and socket), auditd, and dnf-makecache.timer with its dnf5 name" \
    vsh 'for u in systemd-oomd.service systemd-oomd.socket auditd.service dnf-makecache.timer dnf5-makecache.timer; do [ "$(systemctl is-enabled $u 2>/dev/null)" = masked ] || exit 1; done'
  check "systemd-oomd is stopped" refuse_active systemd-oomd.service
  check "core dumps are not stored" vsh 'systemd-analyze cat-config systemd/coredump.conf | grep -qx Storage=none'

  say "the kasten user and its rootless Podman"
  vsh 'getent passwd kasten; grep -H "^kasten:" /etc/subuid /etc/subgid; grep "^KASTEN_MAIL_UID=" /etc/kasten/host.env' || true
  check "the kasten user: uid and gid 2600, home /home/kasten, no login shell, password locked" \
    vsh 'test "$(getent passwd kasten | cut -d: -f3,4,6,7)" = 2600:2600:/home/kasten:/usr/sbin/nologin && getent shadow kasten | cut -d: -f2 | grep -q "^!"'
  check "host.env's KASTEN_MAIL_UID is kasten's first subordinate uid plus 2524 (the server's uid 2525)" \
    vsh '. /etc/kasten/host.env; s=$(awk -F: "\$1 == \"kasten\" { print \$2 }" /etc/subuid); test -n "$s" && test "$KASTEN_MAIL_UID" = $((s + 2524))'
  check "linger is on, and the kasten user's manager (user@2600.service) runs" \
    vsh 'test -e /var/lib/systemd/linger/kasten && systemctl is-active -q user@2600.service'
  vsh 'kasten-podman info --format "podman {{.Version.Version}}: {{.Store.GraphDriverName}} storage, cgroups {{.Host.CgroupsVersion}} ({{.Host.CgroupManager}}), {{.Host.OCIRuntime.Name}}, events to {{.Host.EventLogger}}"' || true
  check "Podman is rootless, keeps its state in RAM (transient store) and its images in /home" \
    vsh 'test "$(kasten-podman info --format "{{.Host.Security.Rootless}} {{.Store.TransientStore}} {{.Store.GraphRoot}} {{.Store.RunRoot}}")" = "true true /home/kasten/.local/share/containers/storage /run/user/2600/containers"'
  check "the kasten user's storage.conf belongs to kasten" \
    vsh 'test "$(stat -c %U:%G /home/kasten/.config/containers/storage.conf)" = kasten:kasten'
  check "Podman's default log driver is journald" vsh 'test "$(kasten-podman info --format "{{.Host.LogDriver}}")" = journald'
  check "unprivileged ports start at 25" vsh 'test "$(sysctl -n net.ipv4.ip_unprivileged_port_start)" = 25'

  say "logs, firewall and units"
  # A container inherits net.ipv4.ip_forward=1 from the Docker VM, so the forward chain is the test.
  check "the firewall forwards nothing (forward chain, policy drop)" vsh 'nft list chain inet kasten forward | grep -q "policy drop"'
  check "journald keeps logs in RAM" vsh 'systemd-analyze cat-config systemd/journald.conf | grep -q "^Storage=volatile"'
  # Fedora keeps a persistent journal by default, so the logs from before install.sh stay in
  # /var/log/journal. Once journald keeps logs in RAM, none of those files may change: the check
  # stage compares them with this list, after mail has been logged.
  vsh 'find /var/log/journal -type f -printf "%p %s %T@\n" 2>/dev/null | sort >/root/journal-files.install'
  vsh 'echo "journal files on the disk from before install.sh: $(wc -l </root/journal-files.install)"'
  check "fstrim.timer is enabled" vx systemctl is-enabled fstrim.timer
  local v
  v=$(vx systemd-analyze verify /etc/systemd/system/kasten-unlock.service /etc/systemd/system/kasten.service \
    /etc/systemd/system/kasten-backup.service /etc/systemd/system/kasten-backup.timer \
    /etc/systemd/system/kasten-check.service /etc/systemd/system/kasten-check.timer \
    /etc/systemd/system/kasten-probe.service /etc/systemd/system/kasten-probe.timer 2>&1 | grep -v "Command 'man " || true)
  if [ -z "$v" ]; then pass "systemd-analyze verify: the eight Kasten units"; else fail "systemd-analyze verify: $v"; fi
  v=$(vx systemd-analyze verify default.target 2>&1 | grep -v "Command 'man " || true)
  if grep -qi cycle <<<"$v"; then fail "boot transaction has an ordering cycle: $v"; else pass "systemd-analyze verify default.target: no ordering cycle"; fi
  check "mail, unlock, backup and firewall units are enabled" vx systemctl is-enabled kasten-unlock.service kasten.service kasten-backup.timer nftables.service
  refuse "personal install does not enable co-located observer timers" vx systemctl is-enabled kasten-check.timer kasten-probe.timer
  check "the optional probe timer is installed but not enabled" vsh 'test "$(systemctl is-enabled kasten-probe.timer)" = disabled'
  check "the helpers and the containers' definitions are installed" \
    vsh 'for f in kasten-bootstrap kasten-check kasten-unlock kasten-podman kasten-cli kasten-mail-service kasten-mail-run kasten-mail-exec; do test -x /usr/local/sbin/$f || exit 1; done; test -f /usr/local/lib/kasten/podman.sh'

  say "the encrypted volume"
  vsh 'cryptsetup luksDump /var/lib/kasten.luks | grep -E "^(Version|Label|Flags)|PBKDF|Memory|Threads"'
  check "LUKS2 header: argon2id, 262144 KiB, 4 passes, allow-discards" vsh 'd=$(cryptsetup luksDump /var/lib/kasten.luks); echo "$d" | grep -q "PBKDF:.*argon2id" && echo "$d" | grep -q "Memory:.*262144" && echo "$d" | grep -Eq "Time cost: *4$" && echo "$d" | grep -q "Flags:.*allow-discards"'
  vsh 'losetup -l -O NAME,BACK-FILE,DIO; findmnt -n -o SOURCE,TARGET,FSTYPE,OPTIONS /var/lib/kasten; ls -la /var/lib/kasten'
  check "loop device uses direct I/O" vsh 'test "$(losetup -n -O DIO -j /var/lib/kasten.luks | tr -d " ")" = 1'
  check "the volume is mounted without online discard" vsh 'findmnt -n -o OPTIONS /var/lib/kasten | grep -qv discard'
  check "dm-crypt passes discards" vsh 'dmsetup table "$(. /etc/kasten/host.env; echo $KASTEN_DM_NAME)" | grep -q allow_discards'
  check "on the volume: data/ belongs to the server's host uid, cli/ and cli/state/ to kasten, secrets/ to root, each 0700" \
    vsh '. /etc/kasten/host.env; test "$(stat -c %u:%g:%a /var/lib/kasten/data)" = "$KASTEN_MAIL_UID:$KASTEN_MAIL_UID:700" && test "$(stat -c %U:%G:%a /var/lib/kasten/cli)" = kasten:kasten:700 && test "$(stat -c %U:%G:%a /var/lib/kasten/cli/state)" = kasten:kasten:700 && test "$(stat -c %U:%G:%a /var/lib/kasten/secrets)" = root:root:700'

  say "the mail API URL in /opt/kasten/.env"
  vsh 'grep -v "^#" /opt/kasten/.env'
  check "install.sh derived STALWART_PUBLIC_URL from --mail-api-host" vsh 'grep -qx "STALWART_PUBLIC_URL=https://mail.kasten.test" /opt/kasten/.env'
  vsh 'sed -i "s/^KASTEN_VERSION=.*/KASTEN_VERSION=keep-me/" /opt/kasten/.env'
  local nft_started
  nft_started=$(vsh 'systemctl show -p ExecMainStartTimestampMonotonic --value nftables.service')
  check "--mail-api-host changes the URL in place and keeps the other lines" url_replaced
  refuse "install.sh refuses a mail API host that is not a host name" reinstall --mail-api-host "mail kasten.test"
  check "a run without --mail-api-host keeps the URL in .env" url_kept
  check "without --mail-api-host or a URL in .env, install.sh stops instead of asking on a non-terminal" \
    vsh 'mv /opt/kasten/.env /root/env.keep; out=$(/root/kasten-deploy/host/install.sh --skip swap --skip packages </dev/null 2>&1); rc=$?; mv /root/env.keep /opt/kasten/.env; [ "$rc" -ne 0 ] && echo "$out" | grep -q "pass --mail-api-host"'
  reinstall --mail-api-host mail.kasten.test >/dev/null 2>&1
  vsh 'sed -i "s/^KASTEN_VERSION=.*/KASTEN_VERSION=/" /opt/kasten/.env'
  # A restart would run nftables.service's ExecStart again and count against its start limit.
  check "the re-runs reloaded nftables.service and did not restart it (same start time, still active)" \
    vsh "test \"\$(systemctl show -p ExecMainStartTimestampMonotonic --value nftables.service)\" = '$nft_started' && test '$nft_started' != 0 && systemctl is-active -q nftables.service"

  say "install.sh, third run: nothing changes"
  local before after
  before=$(vx cryptsetup luksUUID /var/lib/kasten.luks)
  rc=0
  out=$(docker exec -e DM_DISABLE_UDEV=1 "$VPS" /root/kasten-deploy/host/install.sh --skip swap 2>&1) || rc=$?
  after=$(vx cryptsetup luksUUID /var/lib/kasten.luks)
  if [ "$rc" -eq 0 ] && grep -q 'encrypted volume exists and is mounted' <<<"$out" && [ "$before" = "$after" ]; then
    pass "a re-run without a passphrase keeps the same volume (LUKS UUID $after)"
  else
    fail "the re-run failed or changed the volume (exit $rc): $out"
  fi
  check "the re-run kept the mail API URL" vsh 'grep -qx "STALWART_PUBLIC_URL=https://mail.kasten.test" /opt/kasten/.env'
  check "install.sh accepts --skip user" reinstall --skip user

  say "install.sh refuses to run beside a syslog daemon"
  check "rsyslog is installed" vsh 'dnf5 -y -q --setopt=install_weak_deps=False install rsyslog'
  rc=0
  out=$(reinstall 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'a syslog daemon is installed: rsyslog' <<<"$out"; then
    pass "install.sh refuses while rsyslog is installed (exit $rc)"
  else
    fail "install.sh did not refuse beside rsyslog (exit $rc)"
  fi
  vsh 'systemctl stop rsyslog.service 2>/dev/null; dnf5 -y -q remove rsyslog >/dev/null 2>&1; rm -f /var/log/messages /var/log/secure /var/log/maillog /var/log/cron /var/log/spooler'
  check "with rsyslog removed, install.sh runs again" reinstall
}
refuse_active() { ! vx systemctl is-active -q "$1"; }

stage_firewall() {
  say "firewall"
  vsh 'nft -c -f /etc/sysconfig/nftables.conf && echo "nft -c -f /etc/sysconfig/nftables.conf: ok"'
  vsh 'nft -c -f /root/kasten-deploy/host/nftables.conf && echo "nft -c -f deploy/host/nftables.conf (template): ok"'
  local p
  # Fedora's ncat listens on one address family per process.
  for p in 22 25 443 8080; do
    docker exec -d "$VPS" ncat -lk 0.0.0.0 "$p"
    docker exec -d "$VPS" ncat -6 -lk :: "$p"
  done
  for p in 25 80 587; do
    docker exec -d "$CLIENT" nc -lk "$p"
    docker exec -d "$CLIENT" nc -6 -lk "$p"
  done
  sleep 1
  check "client -> VPS TCP 25 (IPv4) is allowed" cx nc -z -w 3 $VPS4 25
  check "client -> VPS TCP 25 (IPv6) is allowed" cx nc -z -w 3 $VPS6 25
  check "client -> VPS TCP 443 is allowed" cx nc -z -w 3 $VPS4 443
  refuse "client -> VPS SSH (not an admin address) is dropped" cx nc -z -w 3 $VPS4 22
  refuse "client -> VPS SSH over IPv6 is dropped" cx nc -z -w 3 $VPS6 22
  refuse "client -> VPS 8080 (admin API) is dropped" cx nc -z -w 3 $VPS4 8080
  check "tailnet peer -> VPS SSH on tailscale0 is allowed" tx nc -z -w 3 $VPS_TS 22
  refuse "tailnet peer -> VPS 8080 is dropped" tx nc -z -w 3 $VPS_TS 8080
  check "VPS -> TCP 587 (SES) is allowed" vx ncat -z -w 3 $CLIENT4 587
  check "VPS -> TCP 587 over IPv6 is allowed" vx ncat -z -w 3 $CLIENT6 587
  refuse "VPS -> TCP 25 is dropped" vx ncat -z -w 3 $CLIENT4 25
  refuse "VPS -> TCP 25 over IPv6 is dropped" vx ncat -z -w 3 $CLIENT6 25
  refuse "VPS -> TCP 80 is dropped" vx ncat -z -w 3 $CLIENT4 80

  say "the provider's metadata service (Hetzner's cloud-init): TCP 80 to 169.254.169.254, root only"
  # A stand-in in its own network namespace, behind a veth pair: its traffic leaves through an
  # ordinary interface, as on a VPS, not through lo or tailscale0.
  vsh 'ip netns add kmd && ip link add kmd0 type veth peer name kmd1 && ip link set kmd1 netns kmd &&
    ip addr add 169.254.1.1/16 dev kmd0 && ip link set kmd0 up &&
    ip -n kmd addr add 169.254.169.254/16 dev kmd1 && ip -n kmd link set kmd1 up && ip -n kmd link set lo up'
  docker exec -d "$VPS" ip netns exec kmd ncat -lk 169.254.169.254 80
  docker exec -d "$VPS" ip netns exec kmd ncat -lk 169.254.169.254 81
  sleep 1
  check "root -> 169.254.169.254 TCP 80 is allowed" vx ncat -z -w 3 169.254.169.254 80
  refuse "the kasten user -> 169.254.169.254 TCP 80 is dropped (root only)" kx 'ncat -z -w 3 169.254.169.254 80'
  refuse "root -> 169.254.169.254 TCP 81 is dropped" vx ncat -z -w 3 169.254.169.254 81
  check "the ruleset allows the IPv6 address fe80::a9fe:a9fe the same way" \
    vsh 'nft list chain inet kasten output | grep -q "ip6 daddr fe80::a9fe:a9fe tcp dport 80 meta skuid 0 accept"'
  vsh 'ip netns pids kmd | xargs -r kill; ip link del kmd0; ip netns del kmd' || true

  say "admin address list"
  reinstall --admin-ips "$CLIENT4 $CLIENT6/128" >/dev/null 2>&1
  vsh 'nft list set inet kasten admin_v4; nft list set inet kasten admin_v6' | grep elements
  check "admin client -> VPS SSH (IPv4) is allowed" cx nc -z -w 3 $VPS4 22
  check "admin client -> VPS SSH (IPv6) is allowed" cx nc -z -w 3 $VPS6 22
  # install.sh's own SSH session is older than the ruleset it loads. On a host where nothing used
  # conntrack before, conntrack meets that session in mid-stream and counts the server's next reply
  # as new: on Hetzner, the session froze. Deleting the session's conntrack entry makes that state.
  vsh 'pkill -f "^ncat -lk 0.0.0.0 22$"' || true
  docker exec -d "$VPS" ncat -l 0.0.0.0 22 -c 'sleep 4; echo late-reply'
  sleep 1
  docker exec -d "$CLIENT" sh -c "nc -d -w 15 $VPS4 22 >/tmp/late-reply"
  sleep 1
  check "conntrack deleted the admin session's entry" \
    vsh "conntrack -D -p tcp --orig-src $CLIENT4 --orig-port-dst 22 2>&1 | grep -Eq '[1-9][0-9]* flow entr'"
  check "an admin SSH session that conntrack meets in mid-stream still gets the server's replies" \
    cx sh -c 'for i in $(seq 1 12); do grep -qx late-reply /tmp/late-reply && exit 0; sleep 1; done; exit 1'
  docker exec -d "$VPS" ncat -lk 0.0.0.0 22
  reinstall --admin-ips "" >/dev/null 2>&1
  refuse "after removing the admin address, client SSH is dropped again" cx nc -z -w 3 $VPS4 22
  check "the settings file kept the empty admin list" vsh 'grep -qx "KASTEN_ADMIN_IPS=\"\"" /etc/kasten/host.env'
  vsh 'pkill -x ncat' || true
  docker exec "$CLIENT" pkill -x nc || true

  say "nftables.service replaces only Kasten's table"
  # Tailscale keeps its own tables. Fedora's unit would flush the whole ruleset on reload and stop.
  check "another table survives a reload and a stop of nftables.service, which leaves the firewall loaded" \
    vsh 'nft add table inet deploytest_other && systemctl reload nftables.service && nft list table inet deploytest_other && systemctl stop nftables.service && nft list table inet deploytest_other && nft list chain inet kasten input | grep -q "policy drop"'
  vsh 'nft delete table inet deploytest_other; systemctl start nftables.service' || true
  check "after a start, the table is loaded" vx nft list table inet kasten
}

stage_tang() {
  say "Tang host, following deploy/tang/README.md"
  docker cp "$ROOT/deploy/tang" "$TANG:/root/kasten-tang"
  # TANG_LISTEN is not assigned yet: FreeBind must let the socket start anyway.
  tsh "cd /root/kasten-tang && install -d /etc/systemd/system/tangd.socket.d /etc/kasten \
    && sed -e 's/@TAILNET_IP@/$TANG_LISTEN/' -e 's/@PORT@/$TANG_PORT/' tangd.socket.d/kasten.conf >/etc/systemd/system/tangd.socket.d/kasten.conf \
    && sed -e 's/@VPS_TAILNET_IP@/$VPS_TS/' -e 's/@PORT@/$TANG_PORT/' kasten-tang.nft >/etc/kasten/kasten-tang.nft \
    && install -m 0644 kasten-tang-firewall.service /etc/systemd/system/ \
    && { [ -n \"\$(ls /var/lib/tang)\" ] || /usr/libexec/tangd-keygen /var/lib/tang; } \
    && systemctl daemon-reload && systemctl enable --now kasten-tang-firewall.service && systemctl enable tangd.socket && systemctl restart tangd.socket"
  check "tangd.socket is active before its address exists (FreeBind)" tsh "systemctl is-active tangd.socket && ! ip -4 addr | grep -q $TANG_LISTEN"
  # The table file replaces itself without "destroy" (nftables 1.0.7): loaded over the table the
  # unit created, it must leave its two drop rules once, not twice.
  check "kasten-tang.nft loads again over its own table and keeps one copy of its rules" \
    tsh 'nft -f /etc/kasten/kasten-tang.nft && test "$(nft list table inet kasten_tang | grep -c " drop$")" = 2'
  tsh "ss -ltn | grep :$TANG_PORT"
  tx ip addr add $TANG_LISTEN/24 dev tailscale0
  # verify default.target builds the boot transaction, so it finds ordering cycles.
  local v
  v=$(tx systemd-analyze verify default.target 2>&1 | grep -v "Command 'man " || true)
  if grep -qi cycle <<<"$v"; then fail "boot transaction has an ordering cycle: $v"; else pass "systemd-analyze verify default.target on the Tang host: no ordering cycle"; fi
  # Without DefaultDependencies=no the same drop-in creates a cycle; show it once.
  tsh 'cp /etc/systemd/system/tangd.socket.d/kasten.conf /root/kasten.conf.keep && sed -i "/^DefaultDependencies=no/d" /etc/systemd/system/tangd.socket.d/kasten.conf && systemctl daemon-reload'
  v=$(tx systemd-analyze verify default.target 2>&1 || true)
  grep 'deleted to break' <<<"$v" || true
  # systemd breaks the cycle by deleting one start job; which one varies (tangd.socket, sockets.target).
  # So does the job it starts the report from: "Found ordering cycle on" or "Found dependency on".
  if grep -qE 'Found (ordering cycle|dependency) on tangd\.socket/start' <<<"$v" && grep -q 'deleted to break ordering cycle' <<<"$v"; then
    pass "without DefaultDependencies=no the boot has an ordering cycle through tangd.socket, and systemd deletes a start job"
  else
    fail "expected an ordering cycle without DefaultDependencies=no: $v"
  fi
  tsh 'cp /root/kasten.conf.keep /etc/systemd/system/tangd.socket.d/kasten.conf && rm /root/kasten.conf.keep && systemctl daemon-reload && systemctl restart tangd.socket'
  check "VPS -> Tang adv over tailscale0" vx curl -fsS -m 5 --retry 3 --retry-connrefused -o /dev/null $TANG_URL/adv
  tsh 'ls -la /var/lib/tang'
  docker network connect --ip $CLIENT_TS $TS "$CLIENT"
  refuse "another tailnet peer -> Tang is dropped by the Tang host firewall" cx nc -z -w 3 $TANG_LISTEN $TANG_PORT
  docker network disconnect $TS "$CLIENT"
}

tang_thp() {
  tsh 'for k in /var/lib/tang/*.jwk; do if jose jwk use -i "$k" -r -u verify; then jose jwk thp -i "$k" -a S256; fi; done'
}

stage_bind() {
  say "bind the volume to Tang"
  local thp
  thp=$(tang_thp)
  echo "thumbprint: $thp"
  check "bind-tang.sh with a wrong thumbprint fails" refuse_bind_wrong
  vsh "kasten-bind-tang $TANG_URL $thp </root/recovery-passphrase"
  vsh 'clevis luks list -d "$(kasten-unlock attach)"'
  vsh 'cryptsetup luksDump /var/lib/kasten.luks | sed -n "/^Keyslots:/,/^Tokens:/p" | grep -E "^  [0-9]+: luks2|PBKDF:"'
  check "bind-tang.sh again with the same URL only re-checks" vsh "kasten-bind-tang $TANG_URL $thp </dev/null 2>&1 | grep -q 'already bound'"
}
refuse_bind_wrong() {
  ! vsh "kasten-bind-tang http://$TANG_LISTEN:$TANG_PORT/ AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA </root/recovery-passphrase"
}

# newkey <name> <email> <file>: a new OpenPGP key from @kasten/core in the kasten-cli image, the
# same code the web app uses. Only the public key is kept; the passphrase and the secret key are
# random and never leave the container.
NEWKEY_JS='const { generateMailKey } = await import("@kasten/core/crypto");
const { randomBytes } = await import("node:crypto");
const key = await generateMailKey(process.argv[1], process.argv[2], randomBytes(24).toString("hex"));
process.stdout.write(key.armoredPublicKey);'
newkey() {
  docker exec "$VPS" sh -c 'kasten-podman run --rm --network=none --read-only --entrypoint node -w /opt/kasten/cli \
    localhost/kasten-cli:deploytest --input-type=module -e "$0" "$1" "$2" >"/var/lib/kasten/cli/$3"' "$NEWKEY_JS" "$@"
}
# keyfpr <file>: the fingerprint of the public key in /var/lib/kasten/cli/<file>, read from the
# key file as the owner's recovery sheet shows it, never from the server.
KEYFPR_JS='const { readPublicKeys } = await import("@kasten/core/crypto");
const { readFileSync } = await import("node:fs");
const [key] = await readPublicKeys(readFileSync(0, "utf8"));
process.stdout.write(key.getFingerprint().toUpperCase());'
keyfpr() {
  docker exec "$VPS" sh -c 'kasten-podman run -i --rm --network=none --read-only --entrypoint node -w /opt/kasten/cli \
    localhost/kasten-cli:deploytest --input-type=module -e "$0" <"/var/lib/kasten/cli/$1"' "$KEYFPR_JS" "$1"
}

# The test's kasten.json and the files it names, in /var/lib/kasten/cli. Every secret is random,
# generated inside the VPS and never printed. They are written as root, as an operator's copy
# would be; the server stage then follows kasten-cli's hint to give them to kasten.
test_config() {
  # docker cp cannot see the encrypted volume: the container mounted it itself.
  docker exec -i "$VPS" sh -c 'umask 077; cat >/var/lib/kasten/cli/kasten.json' <"$ROOT/deploy/test/kasten.json"
  vsh 'umask 077; cd /var/lib/kasten/cli \
    && for f in you-password probe-password relay-password; do head -c 24 /dev/urandom | base64 | tr -d "\n/+=" >"$f"; done \
    && printf "deploytest-ses-user\n" >relay-username \
    && printf "http://127.0.0.1:7561/api/push/deploytest?status=up&msg=OK&ping=\n" >kuma-url'
  newkey "Kasten operator" operator@kasten.test operator.pub.asc
  newkey "Deploy Test" "$ACCOUNT" you.pub.asc
  vsh 'ls -l /var/lib/kasten/cli | tail -n +2'
}

# logged <container name> <regex>: the container's journal lines that match.
logged() { vsh "journalctl -o cat --no-pager CONTAINER_NAME=$1 | grep -E '$2'"; }
# Stalwart's events for a finished download: the web admin UI and the ASN/GeoIP data.
DOWNLOADED='resource\.(download-external|application-updated|application-unpacked)|Downloaded'
no_containers() { vsh 'test -z "$(kasten-podman ps -aq)"'; }
# The memory.max of the cgroup of a process in the VPS: $1 is a pgrep -x name.
memory_max() { vsh "p=\$(pgrep -x $1 | head -n 1) && cat /sys/fs/cgroup\$(cut -d: -f3 /proc/\$p/cgroup)/memory.max"; }

stage_server() {
  say "the kasten-server and kasten-cli images, loaded into the kasten user's Podman"
  docker save "$SERVER_IMAGE" "$CLI_IMAGE" | docker exec -i "$VPS" kasten-podman load -q
  # The names they have on a VPS, where both images carry the release's tag.
  vx kasten-podman tag "localhost/$SERVER_IMAGE" localhost/kasten-server:deploytest
  vx kasten-podman tag "localhost/$CLI_IMAGE" localhost/kasten-cli:deploytest
  vx kasten-podman untag localhost/kasten-server:deploytest "localhost/$SERVER_IMAGE"
  vx kasten-podman untag localhost/kasten-cli:deploytest "localhost/$CLI_IMAGE"
  vsh 'kasten-podman images --format "{{.Repository}}:{{.Tag}} {{.Size}}"'
  vsh 'sed -i "s/^KASTEN_VERSION=.*/KASTEN_VERSION=deploytest/" /opt/kasten/.env'
  check "Stalwart's binary keeps its file capability after a rootless load" \
    vsh 'kasten-podman run --rm --network=none --entrypoint getcap localhost/kasten-server:deploytest /usr/local/bin/stalwart 2>/dev/null | grep -q cap_net_bind_service'
  refuse "before init, the mail container does not start: the server finds no marker" \
    vsh 'kasten-mail-service start && kasten-mail-service wait'
  vsh 'journalctl -o cat --no-pager CONTAINER_NAME=kasten-mail | tail -n 1; kasten-mail-service stop' || true
  check "and no container is left" no_containers
  refuse "before init, kasten.service does not start" vx systemctl start kasten.service
  vx systemctl reset-failed kasten.service || true
  local id out rc hint
  id=$(vsh 'kasten-mail-run init 2>/dev/null' | jq -r .volumeId)
  echo "volume id: $id"
  vsh "sed -i 's/^KASTEN_VOLUME_ID=.*/KASTEN_VOLUME_ID=$id/' /opt/kasten/.env"
  check "init wrote the marker in the data directory, owned by the server's host uid" \
    vsh '. /etc/kasten/host.env; test "$(stat -c %u /var/lib/kasten/data/.kasten-volume)" = "$KASTEN_MAIL_UID"'
  test_config
  docker exec -i "$VPS" sh -c 'cat >>/opt/kasten/.env' <"$ROOT/deploy/test/mail.env"
  # The SES stand-in's test CA, for KASTEN_EXTRA_CA_FILE (test/mail.env). Public.
  docker run --rm -v $P-relay:/v:ro "$ALPINE" cat /v/ca.crt |
    docker exec -i "$VPS" sh -c '. /etc/kasten/host.env; f=/var/lib/kasten/data/relay-ca.crt; cat >"$f" && chown "$KASTEN_MAIL_UID:$KASTEN_MAIL_UID" "$f" && chmod 0644 "$f"'

  say "the CLI's files belong to the kasten user"
  rc=0
  out=$(vx kasten-cli help 2>&1) || rc=$?
  printf '%s\n' "$out" | tail -n 1 | sed 's/^/      /'
  hint=$(sed -n 's/.* Run: //p' <<<"$out")
  if [ "$rc" -ne 0 ] && [ -n "$hint" ]; then pass "kasten-cli refuses files that root owns, and prints the fix (exit $rc)"; else fail "kasten-cli ran with root's files (exit $rc)"; fi
  check "the printed command works" vsh "$hint"
  check "kasten-cli help runs" vx kasten-cli help

  say "standard input reaches the CLI through kasten-cli: the AWS guide pipes the SES secret in"
  # Synthetic secrets, not AWS keys. The derived password depends only on the secret and the
  # region, so equal input gives equal files and other input another file.
  local f
  for f in a b a2; do
    vsh "printf 'kasten-deploytest-%s\n' ${f%2} | kasten-cli aws smtp-password --region eu-central-1 --out /etc/kasten/state/deploytest-smtp-$f >/dev/null" || true
  done
  check "kasten-cli aws smtp-password wrote the --out file from piped input: kasten's, mode 0600, in cli/state" \
    vsh 'test "$(stat -c %a:%U:%G /var/lib/kasten/cli/state/deploytest-smtp-a)" = 600:kasten:kasten && test -s /var/lib/kasten/cli/state/deploytest-smtp-a'
  check "the same piped secret gives the same file, another secret another file" \
    vsh 'cd /var/lib/kasten/cli/state && cmp -s deploytest-smtp-a deploytest-smtp-a2 && ! cmp -s deploytest-smtp-a deploytest-smtp-b'
  check "docs/aws-ses.md's move into cli/, as kasten, keeps the file kasten's with mode 0600" \
    vsh 'setpriv --reuid=kasten --regid=kasten --init-groups mv /var/lib/kasten/cli/state/deploytest-smtp-a /var/lib/kasten/cli/deploytest-smtp-a && test "$(stat -c %a:%U:%G /var/lib/kasten/cli/deploytest-smtp-a)" = 600:kasten:kasten'
  vsh 'rm -f /var/lib/kasten/cli/deploytest-smtp-a /var/lib/kasten/cli/state/deploytest-smtp-a /var/lib/kasten/cli/state/deploytest-smtp-b /var/lib/kasten/cli/state/deploytest-smtp-a2'

  say "before the first boot: the volume locked, as after a reboot, and no Tang binding yet"
  # install.sh mounted the volume itself, so kasten-unlock.service may never have run.
  vsh 'systemctl stop kasten.service kasten-unlock.service; kasten-unlock stop' >/dev/null 2>&1 || true
  refuse "the volume is locked" vx mountpoint -q /var/lib/kasten
  refuse "kasten-unlock.service is not active" vx systemctl is-active -q kasten-unlock.service
  rc=0
  out=$(vx kasten-bootstrap 2>&1) || rc=$?
  printf '%s\n' "$out" | sed 's/^/      /'
  hint=$(sed -n 's/.* is not mounted; run: //p' <<<"$out")
  if [ "$rc" -ne 0 ] && [ -n "$hint" ]; then
    pass "kasten-bootstrap refuses the locked volume and prints the unlock command: $hint"
  else
    fail "kasten-bootstrap on the locked volume printed no unlock command (exit $rc)"
  fi
  rc=0
  if [ -n "$hint" ]; then out=$(vsh "$hint </root/recovery-passphrase" 2>&1) || rc=$?; else out='' rc=1; fi
  printf '%s\n' "$out" | sed 's/^/      /'
  if [ "$rc" -eq 0 ]; then pass "the printed command works with the recovery passphrase (exit 0)"; else fail "the printed command failed (exit $rc)"; fi
  check "the volume is mounted" vx mountpoint -q /var/lib/kasten
  refuse "kasten.service was not started" vx systemctl is-active -q kasten.service
  check "Stalwart did not start: the volume has no database yet" vx test ! -e /var/lib/kasten/data/stalwart/stalwart.sqlite
  check "kasten-unlock-passphrase names the next step, kasten-bootstrap" grep -q 'Next: kasten-bootstrap' <<<"$out"
  refuse "kasten.service refuses to start before the first boot" vx systemctl start kasten.service
  check "Stalwart still has no database" vx test ! -e /var/lib/kasten/data/stalwart/stalwart.sqlite
  vx systemctl reset-failed kasten.service || true

  say "an unfinished first boot: kasten-bootstrap stops after recovery mode started"
  vsh 'mv /var/lib/kasten/cli/operator.pub.asc /var/lib/kasten/secrets/operator.pub.asc.keep' || true
  refuse "kasten-bootstrap fails without the operator key" vx kasten-bootstrap
  vsh 'mv /var/lib/kasten/secrets/operator.pub.asc.keep /var/lib/kasten/cli/operator.pub.asc' || true
  check "recovery mode created the database, and the first boot is marked unfinished" \
    vsh 'test -f /var/lib/kasten/data/stalwart/stalwart.sqlite && test -f /var/lib/kasten/.kasten-bootstrap-incomplete'
  check "the failed run removed the recovery container" no_containers
  refuse "kasten.service refuses to start after an unfinished first boot" vx systemctl start kasten.service
  vx systemctl reset-failed kasten.service || true
  check "kasten-unlock-passphrase does not start it either, and names kasten-bootstrap" \
    vsh 'kasten-unlock-passphrase </root/recovery-passphrase 2>&1 | grep -q "Next: kasten-bootstrap" && ! systemctl is-active -q kasten.service'

  say "first boot, offline: kasten-bootstrap"
  vx rm -f /run/kasten-deploytest-bootstrap.out /run/kasten-deploytest-bootstrap.rc
  docker exec -d -e DM_DISABLE_UDEV=1 "$VPS" sh -c 'kasten-bootstrap >/run/kasten-deploytest-bootstrap.out 2>&1; echo $? >/run/kasten-deploytest-bootstrap.rc'
  # While recovery mode waits for its first health check, 30 s after its start.
  check "recovery mode runs in a container without a network (podman inspect: NetworkMode none)" \
    wait_for 60 vsh 'test "$(kasten-podman inspect --format "{{.HostConfig.NetworkMode}}" kasten-recovery)" = none'
  check "its network namespace has only the loopback interface" \
    wait_for 30 vsh 'p=$(kasten-podman inspect --format "{{.State.Pid}}" kasten-recovery) && [ "$p" -gt 0 ] && test "$(nsenter -t "$p" -n ip -o link show | awk -F": " "{ print \$2 }")" = lo'
  check "recovery mode listens on port 8080 inside that namespace" \
    wait_for 30 vsh 'p=$(kasten-podman inspect --format "{{.State.Pid}}" kasten-recovery) && nsenter -t "$p" -n ss -ltnH "( sport = :8080 )" | grep -q .'
  check "and nothing listens on port 8080 on the host" vsh '! ss -ltnH "( sport = :8080 )" | grep -q .'
  wait_for 300 vx test -s /run/kasten-deploytest-bootstrap.rc || true
  vsh 'tail -n 8 /run/kasten-deploytest-bootstrap.out' | sed 's/^/      /' || true
  check "kasten-bootstrap (exit 0): kasten setup --bootstrap reached 127.0.0.1:8080, which only recovery mode's namespace has" \
    vsh 'test "$(cat /run/kasten-deploytest-bootstrap.rc)" = 0'
  vx rm -f /run/kasten-deploytest-bootstrap.out /run/kasten-deploytest-bootstrap.rc
  check "kasten-bootstrap removed the unfinished-first-boot marker" vx test ! -e /var/lib/kasten/.kasten-bootstrap-incomplete
  check "bootstrap wrote the admin API key, for the kasten user only" vsh 'test "$(stat -c %a:%U /var/lib/kasten/cli/admin-api-key)" = 600:kasten'
  check "kasten-bootstrap removed its copy of the recovery login and the recovery container" \
    vsh '! test -e /var/lib/kasten/cli/recovery-admin && test -z "$(kasten-podman ps -aq)"'
  echo "recovery mode's log, start and resource events (it has no network, so its web UI fetch fails):"
  logged kasten-recovery 'recovery-mode|resource\.' | cut -c1-220 | sed 's/^/      /' || true
  check "Stalwart ran in recovery mode" logged kasten-recovery 'server\.recovery-mode'
  refuse "recovery mode downloaded nothing" logged kasten-recovery "$DOWNLOADED"

  say "first normal start"
  vx systemctl reset-failed kasten.service || true
  local t0=$SECONDS
  check "kasten.service starts, once kasten-mail is healthy" vx systemctl start kasten.service
  echo "      the start took $((SECONDS - t0)) s: Podman runs the first health check 30 s after the container's start"
  rc=0
  out=$(kcli setup 2>&1) || rc=$?
  printf '%s\n' "$out" | grep -E 'changed|Restart' | sed 's/^/      /' || true
  if [ "$rc" -eq 0 ]; then pass "kasten setup, the first normal run (exit 0)"; else
    printf '%s\n' "$out" | tail -n 20
    fail "kasten setup, the first normal run (exit $rc)"
  fi
  if grep -q 'Restart Stalwart' <<<"$out"; then vx systemctl restart kasten.service; fi
  rc=0
  out=$(kcli setup 2>&1) || rc=$?
  printf '%s\n' "$out" | grep -E 'changed' | sed 's/^/      /' || true
  if [ "$rc" -eq 0 ] && grep -q '^0 changed' <<<"$out"; then pass "kasten setup again: 0 changed"; else fail "kasten setup again (exit $rc)"; fi
  # A secret file named /dev/stdin, through kasten-cli: inside the container, standard input is a
  # pipe that reports mode 0777, so the CLI refuses it (docs/agent-setup.md says so). The input is
  # the account's own password, so a change in that behaviour changes nothing.
  rc=0
  out=$(vsh "kasten-cli user password $ACCOUNT --password-file /dev/stdin --config /etc/kasten/kasten.json </var/lib/kasten/cli/you-password" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] && grep -q '/dev/stdin can be read by other users' <<<"$out"; then
    pass "kasten-cli refuses a secret file named /dev/stdin: the container's stdin pipe reports mode 0777 (exit $rc)"
  else
    fail "kasten-cli with --password-file /dev/stdin (exit $rc): $(tail -n 1 <<<"$out")"
  fi
  check "the first normal start logged the Stdout tracer's events (the check below is not empty)" logged kasten-mail 'INFO'
  refuse "from the first boot through setup, the mail server downloaded nothing and tried no download" \
    logged kasten-mail 'resource\.|ASN/Geo'

  vsh 'kasten-podman ps --format "{{.Names}} {{.Status}}"; ss -ltnp | grep -E ":(25|8080|5335) "' || true
  check "Stalwart listens on host port 25 as the server's host uid, not root" \
    vsh '. /etc/kasten/host.env; ss -ltnpH "( sport = :25 )" | grep -q stalwart && test "$(ps -o uid= -C stalwart | tr -d " " | sort -u)" = "$KASTEN_MAIL_UID"'
  local a
  for a in $VPS6 $VPS4; do
    docker exec "$CLIENT" sh -c "printf 'EHLO client.test\r\nQUIT\r\n' | nc -w 5 $a 25 | head -n 1" || true
  done
  sleep 2
  vsh 'journalctl -o cat CONTAINER_NAME=kasten-mail --no-pager | grep "SMTP EHLO command" | tail -n 2 | cut -c1-160' || true
  check "Stalwart logged the client's real IPv6 address" vsh "journalctl -o cat CONTAINER_NAME=kasten-mail --no-pager | grep -q '$CLIENT6'"
  check "Stalwart logged the client's real IPv4 address" vsh "journalctl -o cat CONTAINER_NAME=kasten-mail --no-pager | grep -q '$CLIENT4'"
  refuse "the admin API (8080) is not reachable from the client" cx nc -z -w 3 $VPS4 8080
  # The VPS's "ip nat" table is Docker's, for its DNS server at 127.0.0.11.
  check "Podman made no network: no netavark or podman firewall rules and no bridge" \
    vsh '! nft list ruleset | grep -qiE "netavark|podman" && ! ip link show podman0 >/dev/null 2>&1'

  say "the mail container under kasten.service: limits, health and logs"
  vsh 'p=$(pgrep -x stalwart | head -n 1); c=$(cut -d: -f3 /proc/$p/cgroup); echo "      stalwart runs in $c, memory.swap.max $(cat /sys/fs/cgroup$c/memory.swap.max)"' || true
  check "kasten-mail's memory limit is 768 MiB (memory.max of its cgroup)" test "$(memory_max stalwart)" = 805306368
  check "Podman's health check reports healthy" vsh 'test "$(kasten-podman inspect --format "{{.State.Health.Status}}" kasten-mail)" = healthy'
  check "Podman logs its events to the journal, but no health check events (healthcheck_events = false)" \
    vsh 'journalctl --no-pager -q PODMAN_EVENT=start PODMAN_NAME=kasten-mail | grep -q . && ! journalctl --no-pager -q PODMAN_EVENT=health_status | grep -q .'

  say "the mail container writes only to the encrypted volume and to RAM"
  check "its root file system is read-only" vsh 'test "$(kasten-podman inspect --format "{{.HostConfig.ReadonlyRootfs}}" kasten-mail)" = true'
  check "root inside it cannot write to its root file system" \
    vsh 'kasten-podman exec -u 0 kasten-mail touch /etc/kasten-probe 2>&1 | grep -q "Read-only file system"'
  echo "its writable mounts (mount point, file system type, source):"
  writable_mounts | sed 's/^/      /'
  check "every writable mount is the encrypted volume, RAM or a kernel file system without files" only_ram_and_volume
  check "its logs go to journald" vsh 'test "$(kasten-podman inspect --format "{{.HostConfig.LogConfig.Type}}" kasten-mail)" = journald'
  check "its own layer has only Podman's placeholders for /etc (podman diff: C /etc)" \
    vsh 'test "$(kasten-podman diff kasten-mail | tr "\n" " ")" = "C /etc "'
  check "Podman keeps no log file on the disk (none in its storage, image layers aside)" \
    vsh 'test -z "$(find /home/kasten/.local/share/containers -name "*.log" -size +0 -not -path "*/overlay/*/diff/*")"'
  check "Podman keeps the container's state in RAM: its database and config in /run/user/2600, only empty files on the disk" \
    vsh 'G=/home/kasten/.local/share/containers/storage; id=$(kasten-podman inspect --format "{{.Id}}" kasten-mail); u=$(kasten-podman inspect --format "{{.GraphDriver.Data.UpperDir}}" kasten-mail); test -s /run/user/2600/containers/db.sql && test -s "/run/user/2600/containers/overlay-containers/$id/userdata/config.json" && ! test -e $G/db.sql && test -z "$(find "$u" $G/overlay-containers -type f -size +0 2>/dev/null)"'
}

# The mail container's writable mounts, from its mount table: mount point, type, source.
writable_mounts() {
  vsh 'kasten-podman exec kasten-mail cat /proc/self/mountinfo' |
    awk '{ for (i = 7; $i != "-"; i++); split($6, o, ","); if (o[1] == "rw") print $5, $(i + 1), $(i + 2) }'
}
only_ram_and_volume() {
  local device
  # The encrypted volume's device number on the host, as major:minor.
  device=$(vsh 'mountpoint -d /var/lib/kasten')
  writable_mounts | while read -r target type _; do
    case $target:$type in
      /var/lib/kasten:ext4)
        vsh 'kasten-podman exec kasten-mail cat /proc/self/mountinfo' | awk -v d="$device" '$5 == "/var/lib/kasten" && $3 == d { f = 1 } END { exit !f }' || exit 1
        ;;
      # A rootless container on the host's network sees the host's kernel file systems; they hold
      # no files that a process could leave data in.
      *:tmpfs | *:proc | *:devpts | *:mqueue | *:devtmpfs | *:sysfs | *:cgroup2 | *:debugfs | *:tracefs | \
        *:configfs | *:fusectl | *:securityfs | *:pstore | *:bpf | *:efivarfs | *:selinuxfs) ;;
      *) exit 1 ;;
    esac
  done
}

# selinux_refused <description> <command...>: passes if the command ends with kasten-podman's
# refusal: exit status 125 and its message. Any other failure, such as kasten-cli's own checks
# (exit 2), does not count.
selinux_refused() {
  local d=$1 out rc=0
  shift
  out=$("$@" 2>&1) || rc=$?
  printf '%s\n' "$out" | tail -n 1 | sed 's/^/      /'
  if [ "$rc" -eq 125 ] && grep -q 'SELinux is not enforcing' <<<"$out"; then pass "$d (exit 125)"; else fail "$d (exit $rc)"; fi
}
# created_since <unix time>: the containers that Podman created since then, from its events in the
# journal. A --rm container leaves no other trace.
created_since() { vsh "journalctl --since @$1 -o cat --no-pager -q PODMAN_EVENT=create | grep ."; }

stage_selinux() {
  say "without enforcing SELinux and without the test's file, nothing starts a container"
  vsh 'echo "getenforce: $(getenforce)"'
  local t0
  t0=$(vx date +%s)
  vx mv /etc/kasten/test-without-selinux /root/test-without-selinux.keep
  selinux_refused "kasten-podman run refuses" vx kasten-podman run --rm --network=none localhost/kasten-cli:deploytest help
  selinux_refused "kasten-cli refuses, through kasten-podman" vx kasten-cli help
  selinux_refused "kasten-mail-run refuses, through kasten-podman" vsh 'kasten-mail-run version </dev/null'
  check "kasten-podman runs commands that create no container (images, ps)" vsh 'kasten-podman images -q >/dev/null && kasten-podman ps -q'
  refuse "kasten.service does not start the mail server again" vx systemctl restart kasten.service
  check "and no container is left" no_containers
  refuse "Podman created no container meanwhile (no create event in the journal)" created_since "$t0"
  vx mv /root/test-without-selinux.keep /etc/kasten/test-without-selinux
  vx systemctl reset-failed kasten.service || true
  local out rc=0
  t0=$(vx date +%s)
  out=$(vx kasten-podman run --rm --network=none localhost/kasten-cli:deploytest help 2>&1 >/dev/null) || rc=$?
  check "with the test's file, kasten-podman run warns loudly" grep -q 'WARNING: /etc/kasten/test-without-selinux exists' <<<"$out"
  check "and the journal records the skipped check" \
    vsh 'journalctl -t kasten-podman -o cat --no-pager | grep -q "event=selinux-check result=skipped"'
  check "the journal records that container's creation (the check above can see one)" wait_for 10 created_since "$t0"
  check "kasten.service starts again" vx systemctl start kasten.service
}

# Root never follows a link that the kasten user (a container's root) or the server's user left in
# a directory that it owns: such a link would lead root's write, chown or chmod to any file.
LINK_TARGET=/var/lib/kasten-deploytest-linktarget
link_target_intact() { vsh "test \"\$(stat -c %U:%G:%a $LINK_TARGET)\" = root:root:755 && test -z \"\$(ls -A $LINK_TARGET)\""; }
# install_refuses <description> <message>: install.sh fails with that message.
install_refuses() {
  local out rc=0
  out=$(reinstall 2>&1) || rc=$?
  printf '%s\n' "$out" | grep 'error:' | tail -n 1 | sed 's/^/      /'
  if [ "$rc" -ne 0 ] && grep -qF "$2" <<<"$out"; then pass "$1 (exit $rc)"; else fail "$1 (exit $rc)"; fi
}

stage_links() {
  say "install.sh follows no link that the kasten user left in its home or in cli/"
  vsh "install -d -m 0755 -o root -g root $LINK_TARGET"
  kx "mv /home/kasten/.config/containers /home/kasten/.config/containers.keep && ln -s $LINK_TARGET /home/kasten/.config/containers"
  install_refuses "/home/kasten/.config/containers is a link to a directory of root's: install.sh stops" \
    'could not write /home/kasten/.config/containers/storage.conf'
  check "the link's target keeps its owner (root) and mode, and holds no file" link_target_intact
  kx 'rm /home/kasten/.config/containers && mv /home/kasten/.config/containers.keep /home/kasten/.config/containers'
  kx "mv /home/kasten/.config /home/kasten/.config.keep && ln -s $LINK_TARGET /home/kasten/.config"
  install_refuses "/home/kasten/.config is a link to a directory of root's: install.sh stops" \
    'could not write /home/kasten/.config/containers/storage.conf'
  check "the link's target keeps its owner (root) and mode, and holds no file" link_target_intact
  kx 'rm /home/kasten/.config && mv /home/kasten/.config.keep /home/kasten/.config'
  kx "mv /var/lib/kasten/cli/state /var/lib/kasten/cli/state.keep && ln -s $LINK_TARGET /var/lib/kasten/cli/state"
  install_refuses "cli/state is a link to a directory of root's: install.sh stops" 'could not create /var/lib/kasten/cli/state'
  check "the link's target keeps its owner (root) and mode, and holds no file" link_target_intact
  kx 'rm /var/lib/kasten/cli/state && mv /var/lib/kasten/cli/state.keep /var/lib/kasten/cli/state'
  check "without the links, install.sh runs again" reinstall
  check "kasten's storage.conf and cli/state are kasten's, as before" \
    vsh 'test "$(stat -c %U:%G /home/kasten/.config/containers/storage.conf)" = kasten:kasten && test "$(stat -c %U:%G:%a /var/lib/kasten/cli/state)" = kasten:kasten:700'

  say "the docs' write into cli/, as kasten (docs/operations.md), follows a link only as far as kasten could"
  # The docs' command, with "<name>" filled in.
  local write_as_kasten="setpriv --reuid=kasten --regid=kasten --init-groups sh -c 'umask 077 && cat >/var/lib/kasten/cli/deploytest-file'"
  check "the write makes a file of kasten's, mode 0600, with the text from standard input" \
    vsh "printf 'kasten-deploytest\n' | $write_as_kasten && test \"\$(stat -c %U:%G:%a /var/lib/kasten/cli/deploytest-file)\" = kasten:kasten:600 && test \"\$(cat /var/lib/kasten/cli/deploytest-file)\" = kasten-deploytest"
  vsh 'rm -f /var/lib/kasten/cli/deploytest-file'
  vsh "umask 022; printf 'a root-owned file\n' >$LINK_TARGET-file"
  kx "ln -s $LINK_TARGET-file /var/lib/kasten/cli/deploytest-file"
  refuse "through a link that kasten left to a file of root's, the same write fails" \
    vsh "printf 'kasten-deploytest\n' | $write_as_kasten"
  check "the link's target is unchanged: root's, mode 0644, the same text" \
    vsh "test \"\$(stat -c %U:%G:%a $LINK_TARGET-file)\" = root:root:644 && test \"\$(cat $LINK_TARGET-file)\" = 'a root-owned file'"
  vsh "rm -f /var/lib/kasten/cli/deploytest-file $LINK_TARGET-file"

  say "kasten-bootstrap reads the recovery login as the server's user, not as root"
  vx systemctl stop kasten.service
  vsh "umask 077; printf 'kasten-deploytest-not-for-kasten\n' >/root/kasten-deploytest-victim"
  # The server's user replaces its recovery login with a link to a file of root's.
  vsh '. /etc/kasten/host.env; setpriv --reuid="$KASTEN_MAIL_UID" --regid="$KASTEN_MAIL_UID" --clear-groups sh -c "cd /var/lib/kasten/data/secrets && mv recovery-admin recovery-admin.keep && ln -s /root/kasten-deploytest-victim recovery-admin"'
  local out rc=0
  out=$(vx kasten-bootstrap 2>&1) || rc=$?
  printf '%s\n' "$out" | tail -n 1 | sed 's/^/      /'
  if [ "$rc" -ne 0 ] && grep -q 'could not copy' <<<"$out"; then pass "kasten-bootstrap stops: the server's user cannot read root's file (exit $rc)"; else fail "kasten-bootstrap with the link (exit $rc)"; fi
  check "no copy is left in cli/, and no file there holds root's text" \
    vsh '! test -e /var/lib/kasten/cli/recovery-admin && ! grep -rqs kasten-deploytest-not-for-kasten /var/lib/kasten/cli'
  check "no container was started" no_containers
  vsh '. /etc/kasten/host.env; setpriv --reuid="$KASTEN_MAIL_UID" --regid="$KASTEN_MAIL_UID" --clear-groups sh -c "cd /var/lib/kasten/data/secrets && rm recovery-admin && mv recovery-admin.keep recovery-admin"; rm -f /root/kasten-deploytest-victim'
  vsh "rmdir $LINK_TARGET"
  check "kasten.service starts again" vx systemctl start kasten.service
}

# smtp_message <tag>: a plain test message from the test envelope address.
smtp_message() {
  printf 'From: Deploy Test <%s>\r\nTo: %s\r\nSubject: Kasten deploy test %s\r\nMessage-ID: <deploytest-%s-%s@sender.test>\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\nA test message for kasten check.\r\n' \
    "$ENVELOPE" "$ACCOUNT" "$1" "$1" "$RUN_ID" "$(date -u '+%a, %d %b %Y %H:%M:%S +0000')"
}
# deliver <tag>: one SMTP delivery from the client to the VPS's port 25, one command at a time.
deliver() {
  local out
  out=$({
    printf 'EHLO client.test\r\nMAIL FROM:<%s>\r\nRCPT TO:<%s>\r\nDATA\r\n' "$ENVELOPE" "$ACCOUNT"
    smtp_message "$1"
    printf '.\r\nQUIT\r\n'
  } | docker exec -i "$CLIENT" sh -c 'sleep 1; while IFS= read -r line; do printf "%s\n" "$line"; case $line in DATA* | .*) sleep 1 ;; *) sleep 0.2 ;; esac; done | nc -w 10 "$0" 25' "$VPS4")
  grep -qi '^250 .*queued' <<<"$out" || { printf '%s\n' "$out" | tail -n 5 >&2; return 1; }
}
wait_emails() {
  local _
  for _ in $(seq 1 60); do
    [ "$(vx kasten-test-jmap count 2>/dev/null || echo 0)" -ge "$1" ] && return 0
    sleep 1
  done
  return 1
}
# kuma_standin: a one-shot stand-in for an Uptime Kuma push monitor on 127.0.0.1:7561. It answers
# like Kuma ({"ok":true}) and writes the request it got to /run/kuma.txt.
kuma_standin() {
  vsh 'rm -f /run/kuma.txt'
  docker exec -d "$VPS" sh -c "{ printf 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}'; sleep 5; } | ncat -l 127.0.0.1 7561 >/run/kuma.txt"
  sleep 1
}

# The units' output is read by its log identifier (journalctl -t), not by unit (-u): rootless Podman
# moves itself out of the unit's cgroup, so journald files a container's output under
# user@2600.service. The identifier is the unit's SyslogIdentifier, or its first command's name.
stage_check() {
  say "kasten check under kasten-check.service: the key set, the reader credential, the pins"
  docker cp "$ROOT/deploy/test/jmap" "$VPS:/usr/local/bin/kasten-test-jmap"
  vx chmod 0755 /usr/local/bin/kasten-test-jmap
  shown "kasten keys set: the user's key plus the operator key, encryption at rest on" \
    kcli keys set --account "$ACCOUNT" --key /etc/kasten/you.pub.asc
  # The test account has no sign-in codes; the CLI unit and integration tests cover that check.
  shown "kasten lock: the client is no longer first-party, and the key set is pinned" \
    kcli lock --account "$ACCOUNT" --no-mfa --user-fingerprint "$(keyfpr you.pub.asc)"
  check "the pins (two fingerprints) are in the state directory on the encrypted volume" \
    vsh 'jq -e ".accounts[\"you@kasten.test\"].fingerprints | length == 2" /var/lib/kasten/cli/state/lock.json'
  shown "kasten reader create: a read-only app password, proven unable to write" kcli reader create --account "$ACCOUNT"
  check "the reader credential is for the kasten user only, in the state directory" \
    vsh 'test "$(stat -c %a:%U /var/lib/kasten/cli/state/reader-you@kasten.test.secret)" = 600:kasten'

  say "mail from the internet side, stored encrypted"
  RUN_ID=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
  ENVELOPE=deploytest-$RUN_ID@sender.test
  check "SMTP delivery 1 from the client to port 25" deliver one
  check "SMTP delivery 2 from the client to port 25" deliver two
  check "both messages are stored" wait_emails 2

  say "kasten-check.service on a clean mailbox"
  kuma_standin
  check "kasten-check.service passes" vx systemctl start kasten-check.service
  vsh 'journalctl -t kasten-check -o cat --no-pager | grep -E "^(scan|read|result|FINDING|pushed)" | tail -n 4' | sed 's/^/      /' || true
  check "it checked 2 messages, both encrypted to exactly the pinned key set" \
    vsh 'journalctl -t kasten-check -o cat --no-pager | grep -q "2 messages, 2 encrypted to exactly the key set, 0 exceptions, 0 findings"'
  check "it pushed up to the Kuma stand-in" vsh 'grep -q "GET /api/push/deploytest?status=up" /run/kuma.txt'

  say "kasten-check.service with a plaintext copy in Sent"
  local planted
  planted=$(smtp_message planted | docker exec -i "$VPS" kasten-test-jmap plant-sent) || planted=
  if [ -n "$planted" ]; then pass "planted a plaintext message in Sent ($planted)"; else fail "could not plant a plaintext message in Sent"; fi
  kuma_standin
  refuse "kasten-check.service fails" vx systemctl start kasten-check.service
  check "kasten check exited 1 (findings)" vsh 'test "$(systemctl show -p ExecMainStatus --value kasten-check.service)" = 1'
  vsh 'journalctl -t kasten-check -o cat --no-pager | grep -E "^(result|FINDING|pushed)" | tail -n 3' | sed 's/^/      /' || true
  check "the check named the plaintext Sent copy" \
    vsh "journalctl -t kasten-check -o cat --no-pager | grep -q 'FINDING   plaintextSent $planted'"
  check "it pushed down to the Kuma stand-in" vsh 'grep -q "GET /api/push/deploytest?status=down" /run/kuma.txt'

  say "logs stay in RAM: the test mail's envelope address"
  check "Stalwart logged the envelope address (info level), into journald" \
    vsh "journalctl -o cat --no-pager CONTAINER_NAME=kasten-mail | grep -qF '$ENVELOPE'"
  # kasten-residue-check takes a marker of letters, digits, - and _: the address's local part.
  vsh "umask 077; printf '%s\n' '${ENVELOPE%@*}' >/run/kasten-deploytest-canary"
  check "kasten-residue-check finds it in journald's files in RAM (/run/log/journal)" \
    vsh 'kasten-residue-check /run/kasten-deploytest-canary /run/log/journal; test $? = 1'
  vsh 'echo "the disk file systems that kasten-residue-check scans: / $(findmnt -rn -o TARGET -t ext4,xfs,btrfs,vfat | while read -r m; do [ -d "$m" ] && [ "$m" != /var/lib/kasten ] && printf "%s " "$m"; done)"' || true
  no_residue "no file on any disk file system holds it (kasten-residue-check; the LUKS file aside)" /run/kasten-deploytest-canary
  vx rm -f /run/kasten-deploytest-canary
  check "the mail container's own layer is unchanged (podman diff: C /etc)" \
    vsh 'test "$(kasten-podman diff kasten-mail | tr "\n" " ")" = "C /etc "'
  check "no journal file on the disk changed since install.sh (journald keeps logs in RAM)" \
    vsh 'find /var/log/journal -type f -printf "%p %s %T@\n" 2>/dev/null | sort | cmp -s - /root/journal-files.install'
}

stage_probe() {
  say "the daily delivery probe under kasten-probe.service, through the SES stand-in"
  check "deploy/README.md's command enables and starts the probe timer" vx systemctl enable --now kasten-probe.timer
  vsh 'systemctl list-timers kasten-probe.timer --no-pager | head -n 2' | sed 's/^/      /'
  local before after
  before=$(relay_count || echo -1)
  kuma_standin
  shown "kasten-probe.service: the probe's message went out through the relay and came back" \
    vx systemctl start kasten-probe.service
  vsh 'journalctl -t kasten-probe -o cat --no-pager | grep -E "^(submit|relay|mailbox|result|pushed)" | tail -n 5' | sed 's/^/      /' || true
  after=$(relay_count || echo -1)
  if [ "$before" -ge 0 ] && [ "$after" -eq $((before + 1)) ]; then
    pass "the SES stand-in took one message from Stalwart over STARTTLS, which it requires, and relayed it to port 25"
  else
    fail "the SES stand-in holds $after messages, expected $((before + 1))"
  fi
  check "probe.json in the state directory records today's message as received" \
    vsh 'jq -e ".phase == \"received\"" /var/lib/kasten/cli/state/probe.json'
  check "it pushed up to the Kuma stand-in" vsh 'grep -q "GET /api/push/deploytest?status=up" /run/kuma.txt'

  say "kasten-probe.service again on the same day"
  kuma_standin
  check "the second run passes" vx systemctl start kasten-probe.service
  check "it only reports today's message, in the journal under kasten-probe (the unit's SyslogIdentifier)" \
    vsh 'journalctl -t kasten-probe -o cat --no-pager | grep "^today " | tail -n 1 | grep -q "is already received; this probe account does not send again today"'
  check "the SES stand-in got nothing new" test "$(relay_count)" -eq "$after"
  vx systemctl disable --now kasten-probe.timer >/dev/null 2>&1 || true
}

# restic_password: a random restic password in the data volume's secrets directory, for the
# server's user, unless the backup stage made one.
restic_password() {
  vsh 'f=/var/lib/kasten/data/secrets/restic-password; [ -f "$f" ] || { . /etc/kasten/host.env; head -c 24 /dev/urandom | base64 | setpriv --reuid="$KASTEN_MAIL_UID" --regid="$KASTEN_MAIL_UID" --clear-groups sh -c "umask 077 && cat >$f"; }'
}

stage_backup() {
  say "nightly backup unit: a local restic repository and a stand-in Kuma push monitor"
  restic_password
  # The two files named in backup.env are paths inside the mail container.
  vsh 'umask 077; printf "RESTIC_REPOSITORY=/var/lib/kasten/restic-test\nRESTIC_PASSWORD_FILE=%s\nKASTEN_PUSH_URL=http://127.0.0.1:7560/api/push/test-token?status=up\n" /var/lib/kasten/secrets/restic-password >/var/lib/kasten/secrets/backup.env'
  check "backup-init, as deploy/README.md shows it" vsh 'set -a; . /var/lib/kasten/secrets/backup.env; set +a; kasten-mail-exec backup-init'
  # kasten-push refuses an HTTP success without Kuma's {"ok":true}, so the stand-in answers like Kuma.
  docker exec -d "$VPS" sh -c "{ printf 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}'; sleep 3; } | ncat -l 127.0.0.1 7560 >/run/push.txt"
  sleep 1
  check "kasten-backup.service backs up inside the running mail container" vx systemctl start kasten-backup.service
  vsh 'journalctl -t kasten-backup -o cat --no-pager | grep -E "kasten-server|snapshot" | tail -n 3' || true
  check "the backup's report is in the journal under kasten-backup (the unit's SyslogIdentifier): the snapshot and backup complete" \
    vsh 'journalctl -t kasten-backup -o cat --no-pager | grep -Eq "^snapshot [0-9a-f]+ saved" && journalctl -t kasten-backup -o cat --no-pager | grep -q "^kasten-server: backup complete"'
  check "after the backup, kasten-push called the push URL" vsh 'grep -q "GET /api/push/test-token?status=up" /run/push.txt'
  check "the repository has a kasten-sqlite snapshot" vsh 'set -a; . /var/lib/kasten/secrets/backup.env; set +a; kasten-podman exec --env=RESTIC_REPOSITORY --env=RESTIC_PASSWORD_FILE kasten-mail restic snapshots --tag kasten-sqlite --json | grep -q kasten-sqlite'
  local out rc=0
  out=$(vsh 'kasten-mail-run vacuum </dev/null' 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'already using this volume' <<<"$out"; then
    pass "a one-shot mail container (kasten-mail-run vacuum) refuses while mail runs: the server's lock"
  else
    fail "kasten-mail-run vacuum while mail runs (exit $rc): $(tail -n 2 <<<"$out")"
  fi
  say "backup and restore with the mail service stopped, as deploy/README.md and the upgrade rollback show them"
  vx systemctl stop kasten.service
  # kasten-backup.service needs a running kasten.service (Requisite=), so with mail stopped the
  # operator backs up through a temporary mail container instead.
  refuse "kasten-backup.service does not run while kasten.service is stopped" vx systemctl start kasten-backup.service
  check "kasten-mail-run backup, with mail stopped" \
    vsh 'set -a; . /var/lib/kasten/secrets/backup.env; set +a; kasten-mail-run backup </dev/null 2>&1 | tee /run/kasten-deploytest-backup.out | grep -Eq "^snapshot [0-9a-f]+ saved"'
  vsh 'grep -E "^snapshot|backup complete" /run/kasten-deploytest-backup.out | sed "s/^/      /"; rm -f /run/kasten-deploytest-backup.out' || true
  check "kasten-mail-run restore latest" vsh 'set -a; . /var/lib/kasten/secrets/backup.env; set +a; kasten-mail-run restore latest </dev/null'
  check "kasten.service starts on the restored database" vx systemctl start kasten.service
  vsh 'rm -rf /var/lib/kasten/data/restic-test /run/push.txt; rm -f /var/lib/kasten/data/stalwart/stalwart.sqlite.before-restore-*'
}

# blackhole <port>: a listener on 127.0.0.1 that accepts and never answers, so that a request to it
# stays open.
blackhole() {
  docker exec -d "$VPS" sh -c "exec ncat -lk 127.0.0.1 $1 -c 'sleep 600' </dev/null >/dev/null 2>&1"
}
# Ends the blackholes, their connections and what waits on them.
blackholes_off() { vsh 'pkill -x ncat; pkill -x sleep; pkill -x restic' || true; }

# no_residue <description> <canary file>: kasten-residue-check of every disk file system finds no
# match. It exits 1 on a match and 2 when it cannot scan.
no_residue() {
  local out rc=0
  out=$(vx kasten-residue-check "$2" 2>&1) || rc=$?
  printf '%s\n' "$out" | sed 's/^/      /'
  if [ "$rc" -eq 0 ]; then pass "$1"; else fail "$1 (exit $rc)"; fi
}
# in_ram <canary file>: kasten-residue-check finds the canary in Podman's state in RAM.
in_ram() { vsh "kasten-residue-check $1 /run/user/2600/containers >/dev/null; test \$? = 1"; }

stage_residue() {
  say "Podman keeps container state in RAM: canaries in an exec's environment and a CLI command's arguments"
  local exec_canary cli_canary e=/run/kasten-deploytest-exec-canary c=/run/kasten-deploytest-cli-canary
  exec_canary=deploytest$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
  cli_canary=deploytest$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
  vsh "umask 077; printf '%s\n' $exec_canary >$e; printf '%s\n' $cli_canary >$c"
  restic_password
  blackhole 9998
  blackhole 9999
  sleep 1
  vsh "umask 077; printf 'RESTIC_REPOSITORY=rest:http://127.0.0.1:9998/%s\nRESTIC_PASSWORD_FILE=%s\n' $exec_canary /var/lib/kasten/secrets/restic-password >/run/kasten-deploytest-residue.env"
  # The backup's settings reach the container as kasten-backup.service passes them: environment
  # variables that kasten-mail-exec names.
  docker exec -d -e DM_DISABLE_UDEV=1 "$VPS" sh -c 'set -a; . /run/kasten-deploytest-residue.env; set +a; exec kasten-mail-exec backup >/dev/null 2>&1'
  docker exec -d -e DM_DISABLE_UDEV=1 "$VPS" sh -c "exec kasten-cli keys show --account $cli_canary@kasten.test --config /etc/kasten/kasten.json --url http://127.0.0.1:9999 >/dev/null 2>&1"
  check "the backup's exec session and the CLI's container run, each waiting on a listener that never answers" \
    wait_for 30 vsh 'test "$(kasten-podman ps -q | wc -l)" -ge 2 && pgrep -x restic'
  sleep 3
  vsh "for k in $exec_canary $cli_canary; do echo \"      Podman's files in RAM with a canary: \$(grep -rlaF \$k /run/user/2600/containers 2>/dev/null | sed 's|/run/user/2600/containers/||' | tr '\n' ' ' | cut -c1-300)\"; done" || true
  check "the exec's canary is in Podman's state in RAM, so the scan below can see it" in_ram $e
  check "the CLI's canary is there too" in_ram $c
  check "Podman has no database on the disk" vx test ! -e /home/kasten/.local/share/containers/storage/db.sql
  no_residue "while both run, no file on any disk file system holds the exec's canary (kasten-residue-check)" $e
  no_residue "nor the CLI's canary" $c
  blackholes_off
  check "both ended: no CLI container, no exec session" \
    wait_for 90 vsh 'test "$(kasten-podman ps -aq | wc -l)" = 1 && ! pgrep -x restic && test "$(kasten-podman inspect --format "{{len .ExecIDs}}" kasten-mail)" = 0'
  no_residue "after they ended, no file on any disk file system holds the exec's canary" $e
  no_residue "nor the CLI's canary" $c
  vx rm -f $e $c /run/kasten-deploytest-residue.env
}

stage_crash() {
  say "a crash: Podman's restart policy starts the mail server again"
  local before t0
  before=$(vx kasten-podman inspect --format '{{.RestartCount}}' kasten-mail)
  vsh 'kill -9 "$(pgrep -x stalwart)"'
  t0=$SECONDS
  if wait_for 150 vsh "test \"\$(kasten-podman inspect --format '{{.RestartCount}} {{.State.Status}} {{.State.Health.Status}}' kasten-mail)\" = '$((before + 1)) running healthy'"; then
    pass "after kill -9 of Stalwart, Podman started kasten-mail again; healthy after $((SECONDS - t0)) s"
  else
    fail "kasten-mail was not healthy again within 150 s: $(vx kasten-podman inspect --format '{{.RestartCount}} {{.State.Status}} {{.State.Health.Status}}' kasten-mail || true)"
  fi
  check "kasten.service stayed active" vx systemctl is-active -q kasten.service
  check "the new process has the same memory limit, 768 MiB" test "$(memory_max stalwart)" = 805306368
}

# volume_closed: the volume's mapping is closed, its loop device detached, nothing mounted.
volume_closed() {
  vsh '! cryptsetup status "$(. /etc/kasten/host.env; echo $KASTEN_DM_NAME)" >/dev/null 2>&1 && test -z "$(losetup -n -O NAME -j /var/lib/kasten.luks)" && ! mountpoint -q /var/lib/kasten'
}

stage_unlock() {
  say "lock while mail runs: a stop of kasten-unlock.service stops kasten.service first"
  local t0=$SECONDS
  vx systemctl stop kasten-unlock.service
  echo "      the lock took $((SECONDS - t0)) s"
  check "the volume's mapping is closed, its loop device detached and nothing is mounted" volume_closed
  check "no container is left" no_containers
  check "the mail server exited cleanly (kasten.service logged exit status 0)" \
    vsh 'journalctl -o cat --no-pager -u kasten.service | grep "kasten-mail stopped:" | tail -n 1 | grep -q "exit status 0"'
  check "kasten-unlock.service unlocks through Tang" vx systemctl start kasten-unlock.service
  check "the volume is mounted" vx mountpoint -q /var/lib/kasten
  vsh 'journalctl -t kasten-unlock -o cat --no-pager | grep "^event=" | tail -n 2'
  check "dm-crypt passes discards after a Clevis unlock" vsh 'dmsetup table "$(. /etc/kasten/host.env; echo $KASTEN_DM_NAME)" | grep -q allow_discards'

  say "a lock while kasten.service's start waits for the health check"
  # The unlock above started kasten.service with --no-block.
  check "kasten.service is starting: kasten-mail exists, and the start waits for its health check" \
    wait_for 30 vsh 'test "$(systemctl show -p ActiveState --value kasten.service)" = activating && kasten-podman container exists kasten-mail'
  vx systemctl stop kasten-unlock.service
  check "the lock closed the volume" volume_closed
  check "and left no container" no_containers
  refuse "kasten.service is not active" vx systemctl is-active -q kasten.service
  vx systemctl reset-failed kasten.service kasten-unlock.service 2>/dev/null || true

  say "a lock right after the unlock, while kasten.service's start begins"
  vx systemctl start kasten-unlock.service
  vx systemctl stop kasten-unlock.service
  check "the lock closed the volume" volume_closed
  check "and left no container" no_containers
  vx systemctl reset-failed kasten.service kasten-unlock.service 2>/dev/null || true

  say "Tang down: the unlock fails visibly and nothing is mounted"
  tx systemctl stop tangd.socket
  vsh 'sed -i "s/^KASTEN_UNLOCK_TIMEOUT=.*/KASTEN_UNLOCK_TIMEOUT=20/" /etc/kasten/host.env'
  local t1
  t0=$(date +%s)
  refuse "kasten-unlock.service fails while Tang is down" vx systemctl start kasten-unlock.service
  t1=$(date +%s)
  echo "it gave up after $((t1 - t0)) s (KASTEN_UNLOCK_TIMEOUT=20)"
  vsh 'systemctl show -p SubState --value kasten-unlock.service; journalctl -t kasten-unlock -o cat --no-pager | grep "^event=" | tail -n 1'
  check "systemd waits to try the unlock again (Restart=on-failure)" \
    vsh 'test "$(systemctl show -p SubState --value kasten-unlock.service)" = auto-restart'
  vx systemctl stop kasten-unlock.service
  # RestartSec=60: a retry would have started by now.
  sleep 70
  check "a stop ends the retries: the unit is still inactive 70 s later" \
    vsh 'test "$(systemctl show -p ActiveState --value kasten-unlock.service)" = inactive'
  refuse "/var/lib/kasten is not a mount point" vx mountpoint -q /var/lib/kasten
  check "the mount point is empty" vsh 'test -z "$(ls -A /var/lib/kasten)"'
  refuse "nothing can write into the unmounted mount point (immutable)" vx touch /var/lib/kasten/probe
  refuse "kasten.service does not start" vx systemctl start kasten.service
  check "no container runs" no_containers
  local out rc=0
  out=$(vx kasten-mail-service start 2>&1) || rc=$?
  printf '%s\n' "$out" | tail -n 1 | sed 's/^/      /'
  if [ "$rc" -ne 0 ]; then pass "the mail container cannot be started by hand without the volume (exit $rc)"; else fail "the mail container started without the volume"; fi
  check "and none was created" no_containers
  refuse "kasten-cli refuses to run without the volume" vx kasten-cli help

  say "recovery passphrase while Tang is down, during a Tang attempt of kasten-unlock.service"
  vx systemctl start --no-block kasten-unlock.service
  sleep 2
  check "a Tang attempt is running" vsh 'test "$(systemctl show -p SubState --value kasten-unlock.service)" = start'
  check "kasten-unlock-passphrase unlocks, mounts and starts kasten.service" vsh 'kasten-unlock-passphrase </root/recovery-passphrase'
  check "kasten.service is active" vx systemctl is-active kasten.service
  check "kasten-unlock.service is active, on the passphrase's mount" vx systemctl is-active kasten-unlock.service
  vsh 'journalctl -t kasten-unlock -o cat --no-pager | grep "^event=" | tail -n 2'
  # Whichever start mounted second reports nothing; neither may claim a Tang unlock.
  check "while Tang is down, no unlock is reported as Tang's" \
    vsh '! journalctl -t kasten-unlock -o cat --no-pager | grep "^event=unlock result=ok" | tail -n 1 | grep -q method=tang'

  say "Tang back: the unlock works again"
  tx systemctl start tangd.socket
  vx systemctl stop kasten.service kasten-unlock.service
  check "kasten.service pulls in the Tang unlock and starts" vx systemctl start kasten.service
  vsh 'journalctl -t kasten-unlock -o cat --no-pager | grep "^event=" | tail -n 1'
  check "the last unlock used Tang" vsh 'journalctl -t kasten-unlock -o cat --no-pager | grep "^event=unlock result=ok" | tail -n 1 | grep -q method=tang'

  say "a lock while kasten-check.service runs kasten check"
  # Test only: the check's requests go to a listener that never answers, so it keeps running.
  vsh 'install -d /etc/systemd/system/kasten-check.service.d && printf "[Service]\nExecStart=\nExecStart=/usr/local/sbin/kasten-check --url http://127.0.0.1:9999 --no-push\n" >/etc/systemd/system/kasten-check.service.d/zz-deploytest.conf && systemctl daemon-reload'
  blackhole 9999
  vx systemctl start --no-block kasten-check.service
  check "the check's CLI container runs" wait_for 30 vsh 'kasten-podman ps --format "{{.Image}}" | grep -q kasten-cli'
  local cli
  cli=$(vsh 'kasten-podman ps --format "{{.ID}} {{.Image}}" | awk "/kasten-cli/ { print \$1 }"')
  check "the CLI container's memory limit is 384 MiB, although a system unit started it" \
    vsh "p=\$(kasten-podman inspect --format '{{.State.Pid}}' $cli) && test \"\$(cat /sys/fs/cgroup\$(cut -d: -f3 /proc/\$p/cgroup)/memory.max)\" = 402653184"
  check "its PID 1 is catatonit (--init), which passes on the stop's SIGTERM" \
    vsh "test \"\$(stat -L -c %d:%i /proc/\$(kasten-podman inspect --format '{{.State.Pid}}' $cli)/exe)\" = \"\$(stat -L -c %d:%i /usr/libexec/podman/catatonit)\""
  t0=$SECONDS
  vx systemctl stop kasten-unlock.service
  echo "      the lock took $((SECONDS - t0)) s; kasten-check.service: $(vx systemctl show -p ActiveState,Result --value kasten-check.service | tr '\n' ' ')"
  check "the lock closed the volume (its mapping's open count reached 0)" volume_closed
  check "and left no CLI container" no_containers
  vsh 'rm -r /etc/systemd/system/kasten-check.service.d && systemctl daemon-reload && systemctl reset-failed kasten-check.service' || true
  blackholes_off
  check "kasten.service starts again (Tang unlock)" vx systemctl start kasten.service
}

# Test only: drop-ins that record in $SHUTDOWN_LOG how kasten.service, kasten-unlock.service and
# user@2600.service stop. kasten.service's own output goes there too, with the mail server's exit
# status.
shutdown_log_on() {
  vsh "install -d /var/lib/kasten-deploytest
for u in kasten.service kasten-unlock.service user@2600.service; do install -d /etc/systemd/system/\$u.d; done
cat >/etc/systemd/system/kasten.service.d/zz-deploytest.conf <<EOF
[Unit]
RequiresMountsFor=/var/lib/kasten-deploytest
[Service]
StandardOutput=append:$SHUTDOWN_LOG
StandardError=append:$SHUTDOWN_LOG
ExecStopPost=/bin/sh -c 'n=\\\$\\\$(/usr/local/sbin/kasten-podman ps -aq) && c=\\\$\\\$(printf %%s \"\\\$\\\$n\" | wc -w) || c=podman-failed; echo \"kasten.service stop-post result=\\\$\\\$SERVICE_RESULT containers=\\\$\\\$c user@2600=\\\$\\\$(systemctl is-active user@2600.service)\" >>$SHUTDOWN_LOG'
EOF
cat >/etc/systemd/system/kasten-unlock.service.d/zz-deploytest.conf <<EOF
[Unit]
RequiresMountsFor=/var/lib/kasten-deploytest
[Service]
StandardError=append:$SHUTDOWN_LOG
ExecStopPost=/bin/sh -c 'echo \"kasten-unlock.service stop-post result=\\\$\\\$SERVICE_RESULT exit=\\\$\\\$EXIT_STATUS mapped=\\\$\\\$(test -e /dev/mapper/kasten && echo yes || echo no)\" >>$SHUTDOWN_LOG'
EOF
cat >/etc/systemd/system/user@2600.service.d/zz-deploytest.conf <<EOF
[Unit]
RequiresMountsFor=/var/lib/kasten-deploytest
[Service]
ExecStopPost=/bin/sh -c 'echo user@2600.service stop-post >>$SHUTDOWN_LOG'
EOF
systemctl daemon-reload"
}
shutdown_log_off() {
  vsh 'rm -r /etc/systemd/system/kasten.service.d /etc/systemd/system/kasten-unlock.service.d /etc/systemd/system/user@2600.service.d /var/lib/kasten-deploytest && systemctl daemon-reload'
}
# stopped_in_order <log>: the mail server stopped with exit status 0; then kasten.service ended
# with no container left, while the kasten user's manager still ran; then the lock closed the
# volume. Nothing reported a busy device.
stopped_in_order() {
  awk '
    /kasten-mail stopped: exit status 0/ && !m { m = NR }
    /kasten.service stop-post result=success containers=0 user@2600=active/ && !k { k = NR }
    /kasten-unlock.service stop-post result=success exit=0 mapped=no/ && !u { u = NR }
    /busy/ { b = 1 }
    END { exit !(m && k && u && m < k && k < u && !b) }' <<<"$1"
}

stage_reboot() {
  shutdown_log_on
  local kind log t0 _
  for kind in reboot poweroff; do
    say "$kind: mail stops before the lock, and after the boot it starts with nobody present"
    vx systemctl is-active -q kasten.service || vx systemctl start kasten.service
    vsh ": >$SHUTDOWN_LOG"
    t0=$SECONDS
    docker exec "$VPS" systemctl "$kind" || true
    # The container ends with the shutdown; the test starts it again, on the same kernel.
    for _ in $(seq 1 120); do
      [ "$(docker inspect -f '{{.State.Running}}' "$VPS")" = false ] && break
      sleep 1
    done
    docker start "$VPS" >/dev/null
    wait_boot "$VPS"
    log=$(vx cat "$SHUTDOWN_LOG")
    printf '%s\n' "$log" | sed 's/^/      /'
    if stopped_in_order "$log"; then
      pass "$kind: the mail server stopped cleanly, kasten.service left no container, then the lock closed the volume; nothing was busy"
    else
      fail "$kind: the units did not stop in that order, or something was busy"
    fi
    if wait_for 240 vx systemctl is-active -q kasten.service; then pass "$kind: after the boot kasten.service is active ($((SECONDS - t0)) s after the $kind)"; else fail "$kind: kasten.service is not active after the boot"; fi
    check "$kind: the boot unlock used Tang" vsh 'journalctl -b -t kasten-unlock -o cat --no-pager | grep -q "event=unlock result=ok method=tang"'
    check "$kind: both images survived (Podman's storage on the disk)" \
      vsh 'test "$(kasten-podman images --format "{{.Repository}}:{{.Tag}}" | sort | tr "\n" " ")" = "localhost/kasten-cli:deploytest localhost/kasten-server:deploytest "'
    check "$kind: the only container is the new kasten-mail" vsh 'test "$(kasten-podman ps -a --format "{{.Names}}")" = kasten-mail'
    check "$kind: unprivileged ports start at 25 again (systemd-sysctl at boot)" \
      vsh 'test "$(sysctl -n net.ipv4.ip_unprivileged_port_start)" = 25'
  done
  shutdown_log_off
  vsh 'journalctl -b -o short-monotonic --no-pager -u tailscaled.service -u kasten-unlock.service -u user@2600.service -u kasten.service | grep -E "Started|Finished|Starting" | head -n 8' || true

  say "reboot while Tang is down: the unlock fails, and mail starts by itself once Tang is back"
  vsh 'sed -i "s/^KASTEN_UNLOCK_TIMEOUT=.*/KASTEN_UNLOCK_TIMEOUT=20/" /etc/kasten/host.env'
  tx systemctl stop tangd.socket
  docker restart -t 120 "$VPS" >/dev/null
  local failed=false up=false
  for _ in $(seq 1 120); do
    if vsh 'journalctl -b -t kasten-unlock -o cat --no-pager 2>/dev/null | grep -q "^event=unlock result=failed method=tang reason=timeout"'; then
      failed=true
      break
    fi
    sleep 1
  done
  if $failed; then pass "the boot unlock failed while Tang was down"; else fail "no failed boot unlock within 120 s"; fi
  refuse "while Tang is down, /var/lib/kasten is not a mount point" vx mountpoint -q /var/lib/kasten
  refuse "while Tang is down, kasten.service is not active" vx systemctl is-active -q kasten.service
  # Nothing runs on the VPS from here on but read-only checks.
  tx systemctl start tangd.socket
  # RestartSec=60, one attempt, then kasten.service's start, which waits for the health check.
  for _ in $(seq 1 400); do
    if vx systemctl is-active -q kasten.service; then
      up=true
      break
    fi
    sleep 1
  done
  if $up; then pass "with Tang back, kasten.service starts with nobody acting"; else fail "kasten.service did not start within 400 s of Tang's return"; fi
  check "the retry unlocked through Tang" \
    vsh 'journalctl -b -t kasten-unlock -o cat --no-pager | grep "^event=unlock result=ok" | tail -n 1 | grep -q method=tang'
  check "systemd restarted kasten-unlock.service by itself" \
    vsh 'test "$(systemctl show -p NRestarts --value kasten-unlock.service)" -ge 1'
  vsh 'journalctl -b -t kasten-unlock -o cat --no-pager | grep "^event="'

  say "Tang key backup and restore (deploy/tang/README.md)"
  tsh 'umask 077; tar --numeric-owner -C /var/lib/tang -czf /root/tang-keys.tar.gz .'
  tsh 'systemctl stop tangd.socket && mkdir -p /root/tang-lost && mv /var/lib/tang/* /root/tang-lost/ && systemctl start tangd.socket'
  # tangd creates new keys on the first request to an empty key directory.
  vx curl -fsS -m 5 -o /dev/null $TANG_URL/adv
  tsh 'ls /var/lib/tang'
  vx systemctl stop kasten.service kasten-unlock.service
  refuse "with new Tang keys the unlock fails" vx systemctl start kasten-unlock.service
  tsh 'systemctl stop tangd.socket && rm -f /var/lib/tang/*.jwk && tar -C /var/lib/tang -xzf /root/tang-keys.tar.gz && chown -R _tang:_tang /var/lib/tang && systemctl start tangd.socket'
  check "after restoring the keys the unlock works" vx systemctl start kasten.service
  tsh 'rm -rf /root/tang-lost /root/tang-keys.tar.gz'
}

# listens_as_kasten <ncat listen address and port>: ncat as the kasten user still listens after 2 s
# (timeout ends it with 124).
listens_as_kasten() {
  local rc=0
  vx timeout 2 setpriv --reuid=2600 --regid=2600 --init-groups ncat -l "$@" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 124 ]
}
# bind_denied_as_kasten <ncat listen address and port>: the kernel refuses the kasten user the port.
bind_denied_as_kasten() {
  local out
  out=$(vx timeout 2 setpriv --reuid=2600 --regid=2600 --init-groups ncat -l "$@" 2>&1) || true
  grep -q 'Permission denied' <<<"$out"
}

stage_ports() {
  say "ports: the containers' user, kasten, may bind from port 25 up; the ports below stay privileged"
  check "net.ipv4.ip_unprivileged_port_start is 25" vsh 'test "$(sysctl -n net.ipv4.ip_unprivileged_port_start)" = 25'
  check "the kasten user can listen on port 443 (IPv4)" listens_as_kasten 0.0.0.0 443
  check "the kasten user can listen on port 443 (IPv6)" listens_as_kasten -6 :: 443
  check "the kasten user cannot bind port 24 (IPv4), so SSH's port 22 stays root's" bind_denied_as_kasten 0.0.0.0 24
  check "the kasten user cannot bind port 24 (IPv6)" bind_denied_as_kasten -6 :: 24
  say "with the kernel's default, 1024, it could not bind the mail ports"
  vx sysctl -q -w net.ipv4.ip_unprivileged_port_start=1024
  check "port 443 (IPv4) is refused" bind_denied_as_kasten 0.0.0.0 443
  check "port 443 (IPv6) is refused" bind_denied_as_kasten -6 :: 443
  vx sysctl -q -p /etc/sysctl.d/50-kasten.conf
  check "/etc/sysctl.d/50-kasten.conf sets 25 again" vsh 'test "$(sysctl -n net.ipv4.ip_unprivileged_port_start)" = 25'
}

stage_down() {
  say "cleanup"
  # Lock the volume first: its loop and device-mapper devices belong to the VM's kernel, not to
  # the container. Then clear the mount point's immutable flag, so the volume can be deleted.
  if docker inspect "$VPS" >/dev/null 2>&1; then
    vsh 'systemctl stop kasten.service kasten-unlock.service 2>/dev/null; [ ! -x /usr/local/sbin/kasten-unlock ] || kasten-unlock stop' >/dev/null 2>&1 || true
    if vsh '! cryptsetup status "$(. /etc/kasten/host.env 2>/dev/null; echo "${KASTEN_DM_NAME:-kasten}")" >/dev/null 2>&1 && [ -z "$(losetup -n -O NAME -j /var/lib/kasten.luks 2>/dev/null)" ]'; then
      pass "the volume is closed and its loop device detached"
    else
      fail "the volume is still open in the VM kernel"
    fi
    docker stop -t 60 "$VPS" >/dev/null 2>&1 || true
  fi
  if docker volume inspect $P-varlib >/dev/null 2>&1; then
    docker run --rm --cap-add LINUX_IMMUTABLE -v $P-varlib:/v --entrypoint sh $P-systemd:1 \
      -c '[ ! -d /v/kasten ] || chattr -i /v/kasten' >/dev/null 2>&1 || true
  fi
  local x
  for x in "$VPS" "$TANG" "$CLIENT" "$RELAY"; do docker rm -f "$x" >/dev/null 2>&1 || true; done
  for x in $PUB $TS; do docker network rm "$x" >/dev/null 2>&1 || true; done
  for x in $P-varlib $P-home $P-relay; do docker volume rm "$x" >/dev/null 2>&1 || true; done
  if [ -n "$BINFMT_BEFORE" ]; then
    local after
    after=$(binfmt_handlers)
    echo "the VM's binfmt handlers after the test: $after"
    if [ "$after" = "$BINFMT_BEFORE" ]; then pass "the VM's binfmt handlers are unchanged"; else fail "the VM's binfmt handlers changed: $BINFMT_BEFORE -> $after"; fi
  fi
  docker image rm $P-systemd:1 $P-tang:1 $P-fedora:1 "$CLI_IMAGE" >/dev/null 2>&1 || true
  local left
  left=$(docker ps -a --format '{{.Names}}' | grep "^$P" || true)
  left+=$(docker network ls --format '{{.Name}}' | grep "^$P" || true)
  left+=$(docker volume ls --format '{{.Name}}' | grep "^$P" || true)
  left+=$(docker image ls --format '{{.Repository}}' | grep "^$P" || true)
  if [ -z "$left" ]; then pass "no kasten-deploytest-* containers, networks, volumes or images remain"; else fail "left over: $left"; fi
}

stages=("$@")
[ "${#stages[@]}" -gt 0 ] || stages=(all)
finished=false
if [ "${stages[0]}" = all ]; then
  # The server's first boot comes before Tang, as in deploy/README.md's order of use.
  stages=(up install firewall server links selinux tang bind check probe backup residue crash unlock reboot ports down)
  # If a stage stops the script early, still remove everything.
  trap '$finished || stage_down' EXIT
fi
for s in "${stages[@]}"; do "stage_$s"; done
finished=true
printf '\n%s failure(s)\n' "$FAILS"
[ "$FAILS" -eq 0 ]

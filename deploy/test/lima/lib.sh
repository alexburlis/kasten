# shellcheck shell=bash
# lib.sh: what the two Lima stages share. f45.sh and upgrade.sh set VM and TEMPLATE, then source
# this file. The single-quoted strings are scripts for the VM's shell; they run as root.
# shellcheck disable=SC2016
#
# A Lima VM is closer to the VPS than the container test (deploy/test/run.sh): a real kernel, the
# Fedora Cloud image with its btrfs layout, cloud-init, zram and its default services, and SELinux
# enforcing the targeted policy with MCS. Where the VM still differs from the VPS, the stages say so:
#   - aarch64 on Apple's Virtualization framework (Lima's vz driver), not amd64 on KVM;
#   - Lima's plain mode: no host mounts, no port forwarding, no containerd and no guest agent, and
#     none of Lima's boot scripts change the system (no sysctl, no subordinate IDs, no linger);
#   - SSH comes in from Lima over vsock, which the firewall does not see. install.sh still refuses a
#     firewall without an SSH path, so it gets --admin-ips with Lima's network in place of Tailscale;
#   - no Tang: the volume is unlocked with kasten-unlock-passphrase. At boot kasten-unlock.service
#     finds no Tang binding and fails with exit status 6, as on any host without one;
#   - no SES, ACME, observer or internet clients: deploy/test/kasten.json's dev-mode listener on
#     127.0.0.1:8080, and SMTP from the VM to its own address;
#   - Lima's user network answers DNS only at its gateway, 192.168.5.2, so the mail container's
#     Unbound cannot recurse. As in the container test, it forwards every name to 127.0.0.11
#     (KASTEN_DEV_DNS_FORWARD), here an extra listener of systemd-resolved, without DNSSEC;
#   - dontaudit rules are off (semodule -DB) for the whole stage, so that every SELinux denial is
#     logged. The final stage restores them (semodule -B).
#
# Needs: Lima 2.x on an Apple silicon Mac; Docker (for example Colima) with the arm64 image
# kasten-server:dev-arm64 (KASTEN_TEST_SERVER_IMAGE overrides it); jq. The kasten-cli image is
# built from this checkout. LIMA_HOME must name a short directory of the test's own: Lima keeps
# UNIX sockets there, and macOS limits their paths to 104 bytes. The VM's notes (denials, memory
# samples, shutdown order) go to KASTEN_LIMA_OUT, by default $LIMA_HOME/<vm>.out.
# KASTEN_LIMA_DEPLOY names another deploy/ directory to install, for example a copy with a fix.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
LIMA_DIR=$ROOT/deploy/test/lima
if [ -z "${LIMA_HOME:-}" ]; then
  echo "set LIMA_HOME to a short directory of the test's own, for example LIMA_HOME=~/scratch/kasten/lima" >&2
  exit 2
fi
export LIMA_HOME
if [ $((${#LIMA_HOME} + ${#VM})) -gt 70 ]; then
  echo "LIMA_HOME is too long: Lima's socket paths under it would pass macOS's 104-byte limit" >&2
  exit 2
fi
OUT=${KASTEN_LIMA_OUT:-$LIMA_HOME/$VM.out}
DEPLOY=${KASTEN_LIMA_DEPLOY:-$ROOT/deploy}
mkdir -p "$OUT"
SERVER_IMAGE=${KASTEN_TEST_SERVER_IMAGE:-kasten-server:dev-arm64}
CLI_BUILD=kasten-limatest-cli:$VM
# The tag both images get inside the VM, as KASTEN_VERSION.
VERSION=limatest
# Synthetic test secrets, made in the VM and never printed. They live on the VM's disk, because the
# passphrase must outlast reboots; a real host keeps no such file.
PASSPHRASE=/root/kasten-test-passphrase
CANARY=/root/kasten-test-canary
ACCOUNT=you@kasten.test
# Lima's user network: the VM is 192.168.5.15 and Lima's host side 192.168.5.2.
ADMIN_NET=192.168.5.0/24
INSTALL=(/root/kasten-deploy/host/install.sh --data-size 2G --mail-api-host mail.kasten.test
  --admin-ips "$ADMIN_NET" --passphrase-file "$PASSPHRASE")
# Denials that concern the containers or their runtime. Denials outside them are counted and
# saved, but allowed.
CONTAINER_AVC='container_|conmon|crun|runc|podman|catatonit|pasta|passt|netavark|aardvark|newuidmap|newgidmap|fuse|stalwart|unbound|tini|restic|kasten|comm="node"|spc_t'
# One known denial, counted apart: a user's first "podman info" (install.sh's) runs pasta for its
# version, and SELinux refuses pasta the Podman socket it would inherit. No container is involved,
# and the policy does not audit it: with dontaudit on, the same first call logs nothing.
KNOWN_AVC='denied  \{ read write \} for .* comm="pasta" path="socket:\[[0-9]+\]" .*scontext=[^ ]*:pasta_t:[^ ]* tcontext=[^ ]*:container_runtime_t:[^ ]* tclass=unix_dgram_socket'
AVC_KNOWN=0
FAILS=0
AVC_ALL=0
AVC_CONTAINER=0

say() { printf '\n== %s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  FAILS=$((FAILS + 1))
}
# check <description> <command...>: passes if the command succeeds; shows its last lines if not.
check() {
  local d=$1 out
  shift
  if out=$("$@" 2>&1); then
    pass "$d"
  else
    fail "$d"
    printf '%s\n' "$out" | tail -n 6 | sed 's/^/        | /'
  fi
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
  printf '%s\n' "$out" | tail -n "${SHOWN_LINES:-8}" | sed 's/^/      /'
  if [ "$rc" -eq 0 ]; then pass "$d"; else fail "$d (exit $rc)"; fi
}
# wait_for <seconds> <command...>: polls every two seconds.
wait_for() {
  local n=$1 t0=$SECONDS
  shift
  while [ $((SECONDS - t0)) -lt "$n" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# One shared SSH connection of the test's own. Fedora's SSH socket on vsock stops accepting for a
# while after 50 connections in 30 s (PollLimitBurst), and a test opens many more. Every restart of
# the VM ends it (ssh_reset); the next call opens a new one.
ssh_vm() {
  ssh -F "$LIMA_HOME/$VM/ssh.config" -o ControlMaster=auto -o ControlPath="$LIMA_HOME/$VM/t.sock" \
    -o ControlPersist=600 -o LogLevel=ERROR -o ConnectTimeout=15 -o ServerAliveInterval=10 \
    -o ServerAliveCountMax=6 "lima-$VM" "$@"
}
ssh_reset() {
  ssh -F "$LIMA_HOME/$VM/ssh.config" -o ControlPath="$LIMA_HOME/$VM/t.sock" -O exit "lima-$VM" >/dev/null 2>&1 || true
}
# vsh <script>: runs the script as root in the VM, with no standard input.
vsh() { ssh_vm -n "sudo bash -c $(printf '%q' "$1")"; }
# vin <command...>: runs one command as root in the VM, with this script's standard input.
vin() { ssh_vm "sudo $(printf '%q ' "$@")"; }

vm_stopped() { test "$(limactl list --format '{{.Status}}' "$VM")" = Stopped; }
boot_id() { vsh 'cat /proc/sys/kernel/random/boot_id' 2>/dev/null; }
# wait_boot <seconds>: until the VM answers and systemd has finished starting. Kasten's failed
# boot unlock (no Tang) leaves it "degraded".
wait_boot() {
  local t0=$SECONDS s
  while [ $((SECONDS - t0)) -lt "$1" ]; do
    s=$(vsh 'systemctl is-system-running' 2>/dev/null) || true
    case $s in running | degraded) return 0 ;; esac
    sleep 3
  done
  return 1
}
# restart_vm reboot|poweroff: a reboot from inside the VM, or a poweroff and a new start by Lima.
restart_vm() {
  local b0 t0=$SECONDS b
  b0=$(boot_id)
  vsh "systemctl $1" >/dev/null 2>&1 || true
  ssh_reset
  if [ "$1" = poweroff ]; then
    wait_for 180 vm_stopped || return 1
    limactl start --tty=false "$VM" >>"$OUT/limactl.log" 2>&1 || return 1
  fi
  while [ $((SECONDS - t0)) -lt 600 ]; do
    b=$(boot_id) || true
    if [ -n "$b" ] && [ "$b" != "$b0" ]; then break; fi
    sleep 3
  done
  [ -n "$b" ] && [ "$b" != "$b0" ] && wait_boot 300
}

dm_closed() { vsh '! cryptsetup status kasten >/dev/null 2>&1 && test -z "$(losetup -n -O NAME -j /var/lib/kasten.luks)" && ! mountpoint -q /var/lib/kasten'; }
no_containers() { vsh 'test -z "$(kasten-podman ps -aq)"'; }
mail_healthy() { vsh 'systemctl is-active -q kasten.service && test "$(kasten-podman inspect -f "{{.State.Health.Status}}" kasten-mail)" = healthy'; }
# unlock: the recovery passphrase, as on a host whose Tang host is down. After the first boot it
# also starts kasten.service, which waits for the mail server's health check.
unlock() { vsh "kasten-unlock-passphrase <$PASSPHRASE"; }
# lock: through systemd, as docs/operations.md says.
lock() { vsh 'systemctl stop kasten.service kasten-unlock.service'; }
# unlock_not_bound: this boot's kasten-unlock.service failed once, with exit status 6, because the
# volume has no Tang binding, and systemd did not try again.
unlock_not_bound() {
  vsh 's=$(systemctl show -p Result -p ExecMainStatus -p NRestarts kasten-unlock.service); grep -qx Result=exit-code <<<"$s" && grep -qx ExecMainStatus=6 <<<"$s" && grep -qx NRestarts=0 <<<"$s" && journalctl -b -t kasten-unlock -o cat --no-pager | grep -q "event=unlock result=failed method=tang reason=not-bound"'
}

# container_avcs <file>: the denials in the file that concern the containers, judged by the message
# alone: the journal's prefix holds the VM's host name.
container_avcs() { sed 's/^.*avc:  denied/avc:  denied/' "$1" | grep -E "$CONTAINER_AVC" | grep -vE "$KNOWN_AVC"; }
known_avcs() { grep -E "$KNOWN_AVC" "$1"; }
# avc_read: the SELinux denials logged since the last call. The first call of a boot starts at the
# mark (the stage's start, or the boot) and keeps the last entry's cursor; later calls start after
# that cursor, so no entry is read twice or missed. journalctl takes only one of the two. Only the
# audit records count: the kernel also prints each one, and sudo logs the test's own command lines.
# It fails if journalctl fails, so that an error never reads as zero denials.
avc_read() {
  vsh 'c=/root/kasten-test-avc.cursor
if [ -s "$c" ]; then
  journalctl _TRANSPORT=audit --after-cursor="$(cat "$c")" --show-cursor -o short-iso --no-pager >/run/kasten-test-avc.out || exit 3
else
  journalctl _TRANSPORT=audit --since "@$(cat /root/kasten-test-avc-mark)" --show-cursor -o short-iso --no-pager >/run/kasten-test-avc.out || exit 3
fi
n=$(sed -n "s/^-- cursor: //p" /run/kasten-test-avc.out)
if [ -n "$n" ]; then printf "%s\n" "$n" >"$c"; fi
grep -F "avc:  denied" /run/kasten-test-avc.out
rm -f /run/kasten-test-avc.out
date +%s >/root/kasten-test-avc-last'
}
# avc_collect <name>: saves the SELinux denials logged since the last call to $OUT/avc-<name>.txt
# and counts them. Read them promptly: the journal is 32 MiB in RAM and lost at every reboot.
avc_collect() {
  local f=$OUT/avc-$1.txt all ctr known
  # The journal in RAM rotates: its oldest entry must still be older than the last reading.
  check "the journal still reaches back to the last reading ($1)" vsh 'test "$(journalctl -q -o short-unix --no-pager | awk "NR == 1 {print int(\$1); exit}")" -le "$(cat /root/kasten-test-avc-last 2>/dev/null || cat /root/kasten-test-avc-mark)"'
  if ! avc_read >"$f"; then fail "could not read the journal ($1)"; fi
  all=$(grep -c . "$f")
  ctr=$(container_avcs "$f" | grep -c .)
  known=$(known_avcs "$f" | grep -c .)
  AVC_ALL=$((AVC_ALL + all))
  AVC_CONTAINER=$((AVC_CONTAINER + ctr))
  AVC_KNOWN=$((AVC_KNOWN + known))
  echo "      SELinux denials ($1): $all, container-related: $ctr, the known pasta one: $known"
  [ "$ctr" -eq 0 ] || container_avcs "$f" | head -n 5 | cut -c1-400 | sed 's/^/        | /'
  # A count of zero means something only if the kernel dropped no audit record meanwhile.
  check "no audit record lost ($1)" vsh 'n=$(auditctl -s | awk "/^lost / {print \$2}"); test -n "$n" && test "$n" = "$(cat /root/kasten-test-audit-lost)"'
}
audit_baseline() { vsh 'auditctl -s | awk "/^lost / {print \$2}" >/root/kasten-test-audit-lost'; }
# dontaudit_off <name>: an update of selinux-policy rebuilds the policy store and turns dontaudit
# rules back on. Denials that they hide were then not logged from that update until now; the note
# says so, and the test turns them off again.
dontaudit_off() {
  if vsh 'test -e /var/lib/selinux/targeted/active/disable_dontaudit'; then
    pass "dontaudit rules are still off after $1"
  else
    echo "NOTE  dontaudit rules came back on during $1 (a policy update); denials they hide were not logged from then until now. The test turns them off again."
    check "semodule -DB again" vsh 'semodule -DB && test -e /var/lib/selinux/targeted/active/disable_dontaudit'
  fi
}
# avc_after_boot: after a reboot, the denials of the boot so far: the old journal is gone.
avc_after_boot() {
  vsh 'rm -f /root/kasten-test-avc.cursor /root/kasten-test-avc-last; echo $(($(awk "/^btime/ {print \$2}" /proc/stat) - 1)) >/root/kasten-test-avc-mark'
  audit_baseline
}

stage_up() {
  say "the VM: $VM from $TEMPLATE (Lima checks the image's SHA-256 digest)"
  if ! limactl start --tty=false --name="$VM" "$LIMA_DIR/$TEMPLATE" >"$OUT/limactl.log" 2>&1; then
    fail "limactl start"
    tail -n 5 "$OUT/limactl.log"
    return 1
  fi
  grep -E 'digest|Downloaded|READY' "$OUT/limactl.log" | sed 's/^.*msg=/      /' | cut -c1-160
  vsh 'echo "      $(. /etc/os-release; echo "$PRETTY_NAME, support until $SUPPORT_END"), kernel $(uname -r), $(getenforce)"; echo "      memory $(free -m | awk "/^Mem:/ {print \$2}") MiB, swap $(swapon --show=NAME,SIZE --noheadings | tr -s " " | tr "\n" " "), / on $(findmnt -n -o FSTYPE /)"'
  check "SELinux enforces the targeted policy with MCS" vsh 'test "$(getenforce)" = Enforcing && test "$(cat /sys/fs/selinux/mls)" = 1 && sestatus | grep -Eq "^Loaded policy name:[[:space:]]+targeted$"'
  check "plain mode: Lima set no sysctl, no subordinate IDs, no linger and no user@ drop-in" vsh '! test -e /etc/sysctl.d/99-lima.conf && ! test -s /etc/subuid && ! test -s /etc/subgid && test -z "$(ls -A /var/lib/systemd/linger 2>/dev/null)" && ! test -e /etc/systemd/system/user@.service.d/lima.conf'
  check "1 GiB of memory" vsh 'm=$(awk "/^MemTotal:/ {print \$2}" /proc/meminfo); [ "$m" -gt 900000 ] && [ "$m" -le 1048576 ]'
  say "dontaudit rules off for the whole stage (semodule -DB), so that every denial is logged"
  vsh 'date +%s >/root/kasten-test-avc-mark'
  audit_baseline
  check "semodule -DB" vsh 'semodule -DB'
  check "the policy store records dontaudit as off" vsh 'test -e /var/lib/selinux/targeted/active/disable_dontaudit'
  check "synthetic recovery passphrase and canary, made in the VM" vsh "umask 077; head -c 30 /dev/urandom | base64 | tr -d '\n/+=' >$PASSPHRASE; printf 'kastenlima%s\n' \"\$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')\" >$CANARY"
}

copy_deploy() {
  COPYFILE_DISABLE=1 tar -C "$DEPLOY" --no-xattrs --no-mac-metadata -cf - host test |
    vin sh -c 'rm -rf /root/kasten-deploy && mkdir -m 0700 /root/kasten-deploy && tar -C /root/kasten-deploy --warning=no-unknown-keyword -xf -'
}

# journal_in_ram: journald keeps the journal in RAM. The Cloud image's journal files from before
# install.sh stay in /var/log/journal, closed: none is open for writing (ONLINE), and none changed
# since install.sh.
journal_in_ram() {
  vsh 'systemd-analyze cat-config systemd/journald.conf | grep -qx Storage=volatile && journalctl --header 2>/dev/null | awk "/^File path:/ {p = \$3} /^State:/ && \$2 == \"ONLINE\" && p !~ /^\/run\/log\/journal\// {bad = 1} END {exit bad}" && test -e /root/kasten-test-journal-mark && test -z "$(find /var/log/journal -type f -newer /root/kasten-test-journal-mark)"'
}
# verify_units: systemd-analyze verify of the eight Kasten units, and no ordering cycle at boot.
verify_units() {
  local v
  v=$(vsh 'cd /etc/systemd/system && systemd-analyze verify "$PWD"/kasten-unlock.service "$PWD"/kasten.service "$PWD"/kasten-backup.service "$PWD"/kasten-backup.timer "$PWD"/kasten-check.service "$PWD"/kasten-check.timer "$PWD"/kasten-probe.service "$PWD"/kasten-probe.timer 2>&1' | grep -v "Command 'man " || true)
  if [ -z "$v" ]; then pass "systemd-analyze verify: the eight Kasten units"; else fail "systemd-analyze verify: $v"; fi
  v=$(vsh 'systemd-analyze verify default.target 2>&1' || true)
  if grep -qi cycle <<<"$v"; then fail "ordering cycle: $v"; else pass "systemd-analyze verify default.target: no ordering cycle"; fi
}

stage_install() {
  copy_deploy
  say "install.sh under enforcing SELinux, without the test marker"
  check "no /etc/kasten/test-without-selinux" vsh '! test -e /etc/kasten/test-without-selinux'
  local out rc=0 t0=$SECONDS
  out=$(vsh "$(printf '%q ' "${INSTALL[@]}")" 2>&1) || rc=$?
  printf '%s\n' "$out" >"$OUT/install.log"
  printf '%s\n' "$out" | grep -E '^install:' | sed 's/^/      /'
  [ "$rc" -eq 0 ] || printf '%s\n' "$out" | grep -v '^install:' | tail -n 15
  if [ "$rc" -eq 0 ]; then pass "install.sh completes (exit 0, $((SECONDS - t0)) s)"; else fail "install.sh (exit $rc)"; fi
  refuse "install.sh printed no SELinux warning" grep -q 'WARNING' <<<"$out"

  say "what install.sh set up"
  vsh 'getent passwd kasten; grep "^kasten:" /etc/subuid /etc/subgid; grep "^KASTEN_MAIL_UID=" /etc/kasten/host.env' | sed 's/^/      /'
  check "user kasten: uid/gid 2600, home /home/kasten, nologin, password locked" vsh 'test "$(getent passwd kasten | cut -d: -f3,4,6,7)" = "2600:2600:/home/kasten:/usr/sbin/nologin" && getent shadow kasten | cut -d: -f2 | grep -q "^!"'
  check "subordinate IDs kasten:524288:65536 in both files; KASTEN_MAIL_UID = 526812" vsh 'grep -qx "kasten:524288:65536" /etc/subuid && grep -qx "kasten:524288:65536" /etc/subgid && grep -qx "KASTEN_MAIL_UID=526812" /etc/kasten/host.env'
  check "linger is on and user@2600 is active" vsh 'test -e /var/lib/systemd/linger/kasten && systemctl is-active -q user@2600.service'
  check "kasten-podman info: rootless, transient store, journald" vsh 'test "$(kasten-podman info --format "{{.Host.Security.Rootless}} {{.Store.TransientStore}} {{.Store.GraphRoot}} {{.Store.RunRoot}} {{.Host.LogDriver}}")" = "true true /home/kasten/.local/share/containers/storage /run/user/2600/containers journald"'
  vsh 'kasten-podman info --format "      podman {{.Version.Version}}, {{.Store.GraphDriverName}}, cgroups {{.Host.CgroupsVersion}} via {{.Host.CgroupManager}}, {{.Host.OCIRuntime.Name}}, SELinux {{.Host.Security.SELinuxEnabled}}"'
  check "Podman sees SELinux" vsh 'test "$(kasten-podman info --format "{{.Host.Security.SELinuxEnabled}}")" = true'
  check "sysctl ip_unprivileged_port_start = 25, from Kasten's file only" vsh 'test "$(sysctl -n net.ipv4.ip_unprivileged_port_start)" = 25 && test "$(grep -lrs ip_unprivileged_port_start /etc/sysctl.d /usr/lib/sysctl.d /run/sysctl.d /etc/sysctl.conf)" = /etc/sysctl.d/50-kasten.conf'
  check "masked: systemd-oomd (service and socket), auditd, dnf-makecache.timer" vsh 'for u in systemd-oomd.service systemd-oomd.socket auditd.service dnf-makecache.timer; do [ "$(systemctl is-enabled $u 2>/dev/null)" = masked ] && ! systemctl is-active -q $u || { echo $u; exit 1; }; done'
  check "dnf5-automatic.timer enabled and active; automatic.conf applies updates, never reboots" vsh 'systemctl is-enabled -q dnf5-automatic.timer && systemctl is-active -q dnf5-automatic.timer && grep -qx "apply_updates = yes" /etc/dnf/automatic.conf && grep -qx "reboot = never" /etc/dnf/automatic.conf'
  check "dnf5 uses the HTTPS-only metalinks; openh264 is disabled" vsh 'test "$(dnf5 -q repo info fedora updates 2>/dev/null | grep -i metalink | grep -c "protocol=https")" = 2 && ! dnf5 -q repo list --enabled 2>/dev/null | grep -q openh264'
  check "core dumps are not stored" vsh 'systemd-analyze cat-config systemd/coredump.conf | grep -qx Storage=none'
  vsh 'touch /root/kasten-test-journal-mark'
  check "the journal is in RAM only: journald writes only under /run/log/journal" journal_in_ram
  check "swap is zram only, half the memory, lz4" vsh 'test -z "$(swapon --show=NAME --noheadings | grep -v ^/dev/zram)" && grep -q "^/dev/zram0" /proc/swaps && test "$(cat /sys/block/zram0/comp_algorithm | grep -o "\[[a-z0-9]*\]")" = "[lz4]"'
  vsh 'echo "      swap: $(swapon --show=NAME,SIZE,PRIO --noheadings | tr -s " ")"'
  check "no syslog daemon; firewalld absent" vsh '! rpm -q --quiet rsyslog && ! rpm -q --quiet syslog-ng && ! systemctl is-active -q firewalld.service'
  check "nftables: drop-in active, Kasten's table loaded from /etc/sysconfig/nftables.conf" vsh 'nft list table inet kasten >/dev/null && systemctl cat nftables.service | grep -q "ExecReload=/sbin/nft -f /etc/sysconfig/nftables.conf" && grep -q "192.168.5.0/24" /etc/sysconfig/nftables.conf'
  check "units enabled: kasten-unlock, kasten, kasten-backup.timer, nftables, fstrim.timer" vsh 'systemctl is-enabled -q kasten-unlock.service kasten.service kasten-backup.timer nftables.service fstrim.timer'
  verify_units
  vsh 'ls -Zd /var/lib/kasten /var/lib/kasten/data /var/lib/kasten/cli /var/lib/kasten/secrets /home/kasten/.local/share/containers/storage /home/kasten/.config/containers/storage.conf 2>&1 | sed "s/^/      /"'
  check "volume dirs: data KASTEN_MAIL_UID 0700, cli and state kasten 0700, secrets root 0700" vsh 'test "$(stat -c %u:%g:%a /var/lib/kasten/data)" = 526812:526812:700 && test "$(stat -c %U:%G:%a /var/lib/kasten/cli)" = kasten:kasten:700 && test "$(stat -c %U:%G:%a /var/lib/kasten/cli/state)" = kasten:kasten:700 && test "$(stat -c %U:%G:%a /var/lib/kasten/secrets)" = root:root:700'
  check "the new file system is labelled (restorecon): nothing unlabeled_t" vsh 'test -z "$(find /var/lib/kasten -xdev -context "*unlabeled_t*")"'
  check "the volume file is NOCOW on btrfs, sparse, direct I/O" vsh 'lsattr /var/lib/kasten.luks | cut -d" " -f1 | grep -q C && test "$(losetup -n -O DIO -j /var/lib/kasten.luks | tr -d " ")" = 1 && test "$(du -k /var/lib/kasten.luks | cut -f1)" -lt 1048576'

  say "install.sh again: nothing changes, the volume stays"
  local before after
  before=$(vsh 'cryptsetup luksUUID /var/lib/kasten.luks')
  rc=0
  out=$(vsh '/root/kasten-deploy/host/install.sh' 2>&1) || rc=$?
  after=$(vsh 'cryptsetup luksUUID /var/lib/kasten.luks')
  if [ "$rc" -eq 0 ] && grep -q 'encrypted volume exists and is mounted' <<<"$out" && [ "$before" = "$after" ]; then pass "re-run keeps the same volume"; else fail "re-run (exit $rc): $(tail -n 5 <<<"$out")"; fi
}

stage_images() {
  say "images: docker save | kasten-podman load"
  if ! docker build -q -f "$ROOT/cli/Dockerfile" -t "$CLI_BUILD" "$ROOT" >/dev/null; then
    fail "docker build of the kasten-cli image from this checkout"
    return 1
  fi
  local t0=$SECONDS
  docker save "$SERVER_IMAGE" "$CLI_BUILD" | vin kasten-podman load | sed 's/^/      /'
  echo "      save and load took $((SECONDS - t0)) s"
  # The tag only; BuildKit keeps the layers in its cache.
  docker image rm "$CLI_BUILD" >/dev/null
  vsh "kasten-podman tag localhost/$SERVER_IMAGE localhost/kasten-server:$VERSION && kasten-podman tag localhost/$CLI_BUILD localhost/kasten-cli:$VERSION && kasten-podman untag localhost/kasten-server:$VERSION localhost/$SERVER_IMAGE && kasten-podman untag localhost/kasten-cli:$VERSION localhost/$CLI_BUILD && sed -i 's/^KASTEN_VERSION=.*/KASTEN_VERSION=$VERSION/' /opt/kasten/.env"
  vsh 'kasten-podman images --format "      {{.Repository}}:{{.Tag}} {{.Size}}"'
  check "both images loaded under KASTEN_VERSION=$VERSION" vsh "test \"\$(kasten-podman images --format '{{.Repository}}:{{.Tag}}' | sort | tr '\n' ' ')\" = 'localhost/kasten-cli:$VERSION localhost/kasten-server:$VERSION '"
  check "stalwart keeps its file capability after a rootless load" vsh "kasten-podman run --rm --network=none --entrypoint getcap localhost/kasten-server:$VERSION /usr/local/bin/stalwart | grep -q cap_net_bind_service"
}

NEWKEY_JS='const { generateMailKey } = await import("@kasten/core/crypto");
const { randomBytes } = await import("node:crypto");
const key = await generateMailKey(process.argv[1], process.argv[2], randomBytes(24).toString("hex"));
process.stdout.write(key.armoredPublicKey);'
# newkey <name> <email> <file>: a new public key, from @kasten/core in the CLI image, in cli/<file>.
newkey() {
  vsh "kasten-podman run --rm --network=none --read-only --entrypoint node -w /opt/kasten/cli localhost/kasten-cli:$VERSION --input-type=module -e $(printf '%q' "$NEWKEY_JS") $(printf '%q ' "$1" "$2") >/var/lib/kasten/cli/$3"
}
KEYFPR_JS='const { readPublicKeys } = await import("@kasten/core/crypto");
const { readFileSync } = await import("node:fs");
const [key] = await readPublicKeys(readFileSync(0, "utf8"));
process.stdout.write(key.getFingerprint().toUpperCase());'

stage_firstboot() {
  say "init, test config, first boot"
  refuse "before init, kasten.service does not start" vsh 'systemctl start kasten.service'
  vsh 'systemctl reset-failed kasten.service' || true
  local id out rc
  id=$(vsh 'kasten-mail-run init 2>/dev/null' | jq -r .volumeId)
  echo "      volume id: $id"
  vsh "sed -i 's/^KASTEN_VOLUME_ID=.*/KASTEN_VOLUME_ID=$id/' /opt/kasten/.env"
  vsh 'install -d /etc/systemd/resolved.conf.d && printf "[Resolve]\nDNSStubListenerExtra=127.0.0.11\n" >/etc/systemd/resolved.conf.d/kasten-test.conf && systemctl restart systemd-resolved.service'
  vsh 'grep -q "^KASTEN_DEV_DNS_FORWARD=" /opt/kasten/.env || echo "KASTEN_DEV_DNS_FORWARD=." >>/opt/kasten/.env'
  check "test DNS: 127.0.0.11 answers (systemd-resolved, for Unbound's forwarding)" vsh 'python3 -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(5); s.sendto(bytes.fromhex(\"123401000001000000000000076578616d706c6503636f6d0000010001\"), (\"127.0.0.11\", 53)); d = s.recv(512); assert d[3] & 15 == 0"'
  check "init wrote the marker, owned by KASTEN_MAIL_UID" vsh 'test "$(stat -c %u /var/lib/kasten/data/.kasten-volume)" = 526812'
  check "data/ has the mail level, s0:c525,c526" vsh 'test "$(stat -c %C /var/lib/kasten/data)" = system_u:object_r:container_file_t:s0:c525,c526'
  vin sh -c 'umask 077; cat >/var/lib/kasten/cli/kasten.json' <"$ROOT/deploy/test/kasten.json"
  vsh 'umask 077; cd /var/lib/kasten/cli && for f in you-password probe-password relay-password; do head -c 24 /dev/urandom | base64 | tr -d "\n/+=" >"$f"; done && printf "deploytest-ses-user\n" >relay-username && printf "http://127.0.0.1:7561/api/push/deploytest?status=up&msg=OK&ping=\n" >kuma-url'
  newkey "Kasten operator" operator@kasten.test operator.pub.asc
  newkey "Deploy Test" "$ACCOUNT" you.pub.asc
  rc=0
  out=$(vsh 'kasten-cli help' 2>&1) || rc=$?
  if [ "$rc" -eq 2 ] && grep -q 'chown -R kasten:kasten /var/lib/kasten/cli' <<<"$out"; then pass "kasten-cli refuses root-owned files and prints the chown"; else fail "kasten-cli did not refuse root-owned files (exit $rc)"; fi
  vsh 'chown -R kasten:kasten /var/lib/kasten/cli && chmod -R go= /var/lib/kasten/cli'
  vsh 'ls -Z /var/lib/kasten/cli/kasten.json /var/lib/kasten/cli/you-password | sed "s/^/      before kasten-cli: /"' || true
  check "kasten-cli help runs after the chown" vsh 'kasten-cli help'
  check "cli/ has the CLI level, s0:c600,c601" vsh 'test "$(stat -c %C /var/lib/kasten/cli)" = system_u:object_r:container_file_t:s0:c600,c601'
  # Files that root writes into cli/ get level s0, which every container may read. The ":Z" of the
  # next kasten-cli run must relabel them too, not only the directory.
  vsh 'ls -Z /var/lib/kasten/cli/kasten.json /var/lib/kasten/cli/you-password | sed "s/^/      after kasten-cli: /"' || true
  check "the files root wrote into cli/ have the CLI level after a kasten-cli run" \
    vsh 'for f in /var/lib/kasten/cli/kasten.json /var/lib/kasten/cli/you-password /var/lib/kasten/cli/operator.pub.asc; do test "$(stat -c %C "$f" | cut -d: -f3-)" = container_file_t:s0:c600,c601 || exit 1; done'
  # Now cli/ itself has the CLI level. An operator later adds a file, as for a new user, as kasten,
  # as docs/operations.md writes it: root itself would follow a link that kasten left there.
  vsh 'printf "later\n" | setpriv --reuid=kasten --regid=kasten --init-groups sh -c "umask 077 && cat >/var/lib/kasten/cli/later-password" && ls -Z /var/lib/kasten/cli/later-password | sed "s/^/      new file: /"' || true
  vsh 'kasten-cli help >/dev/null; ls -Z /var/lib/kasten/cli/later-password | sed "s/^/      after kasten-cli: /"' || true
  check "a file root adds to cli/ later also has the CLI level after the next kasten-cli run" \
    vsh 'test "$(stat -c %C /var/lib/kasten/cli/later-password | cut -d: -f3-)" = container_file_t:s0:c600,c601'
  vsh 'rm -f /var/lib/kasten/cli/later-password'
  # docs/aws-ses.md relies on this: a CLI command must never print a secret, because the journal
  # gets its output even when the host shell discards it.
  check "an attached kasten-cli run's output also reaches the journal, even when the shell discards it" \
    vsh 'since=$(date +%s); kasten-cli help >/dev/null 2>&1; sleep 1; journalctl --since "@$since" -o cat --no-pager _UID=2600 | grep -q "^usage: kasten <command> \[options\]"'

  say "lock, passphrase unlock, bootstrap"
  # install.sh mounted the volume without kasten-unlock.service (docs/operations.md).
  vsh 'systemctl stop kasten.service kasten-unlock.service; kasten-unlock stop' >/dev/null 2>&1 || true
  check "locked" dm_closed
  out=$(vsh 'kasten-bootstrap' 2>&1) || true
  check "kasten-bootstrap refuses the locked volume with the unlock hint" grep -q 'not mounted; run: kasten-unlock-passphrase' <<<"$out"
  out=$(unlock 2>&1) || true
  printf '%s\n' "$out" | sed 's/^/      /'
  check "kasten-unlock-passphrase names kasten-bootstrap next, and starts nothing" grep -q 'Next: kasten-bootstrap' <<<"$out"
  check "the unlock event says method=passphrase" vsh 'journalctl -t kasten-unlock -o cat --no-pager | grep -q "event=unlock result=ok method=passphrase"'
  local t0=$SECONDS
  rc=0
  out=$(vsh 'kasten-bootstrap' 2>&1) || rc=$?
  printf '%s\n' "$out" | grep -E 'changed|done|error' | tail -n 4 | sed 's/^/      /'
  if [ "$rc" -eq 0 ]; then pass "kasten-bootstrap (exit 0, $((SECONDS - t0)) s)"; else fail "kasten-bootstrap (exit $rc): $(tail -n 4 <<<"$out")"; fi
  check "bootstrap wrote admin-api-key 0600 kasten" vsh 'test "$(stat -c %a:%U /var/lib/kasten/cli/admin-api-key)" = 600:kasten'
  check "bootstrap removed its copy, the marker and the recovery container" vsh '! test -e /var/lib/kasten/cli/recovery-admin && ! test -e /var/lib/kasten/.kasten-bootstrap-incomplete && test -z "$(kasten-podman ps -aq)"'
  check "recovery mode ran, without network, and downloaded nothing" vsh 'journalctl -o cat CONTAINER_NAME=kasten-recovery | grep -q "server.recovery-mode" && ! journalctl -o cat CONTAINER_NAME=kasten-recovery | grep -qE "resource\.(download-external|application-updated|application-unpacked)|Downloaded"'
  check "the labels stayed: data/ at the mail level, cli/ at the CLI level" vsh 'test "$(stat -c %C /var/lib/kasten/data)" = system_u:object_r:container_file_t:s0:c525,c526 && test "$(stat -c %C /var/lib/kasten/cli)" = system_u:object_r:container_file_t:s0:c600,c601'

  say "first normal start"
  t0=$SECONDS
  check "kasten.service starts (healthy)" vsh 'systemctl start kasten.service'
  echo "      kasten.service start took $((SECONDS - t0)) s"
  check "kasten-unlock.service is active (pulled in by kasten.service), so a stop of it locks" vsh 'systemctl is-active -q kasten-unlock.service'
  out=$(vsh 'kasten-cli setup --config /etc/kasten/kasten.json' 2>&1) || true
  printf '%s\n' "$out" | grep -E 'changed|Restart' | sed 's/^/      /'
  if grep -q 'Restart Stalwart' <<<"$out"; then vsh 'systemctl restart kasten.service'; fi
  rc=0
  out=$(vsh 'kasten-cli setup --config /etc/kasten/kasten.json' 2>&1) || rc=$?
  if [ "$rc" -eq 0 ] && grep -q '^0 changed' <<<"$out"; then pass "kasten-cli setup again: 0 changed"; else fail "kasten-cli setup again (exit $rc): $(tail -n 5 <<<"$out")"; fi
  check "the mail server runs as container_t at the mail level" vsh 'ps -o label= -C stalwart | grep -qx "system_u:system_r:container_t:s0:c525,c526"'
}

# smtp <address> [canary file]: delivers one message to you@kasten.test on port 25, from the VM
# itself, with the canary in the body when a file is given.
SMTP_PY='import smtplib, sys, time, email.utils
host, canary = sys.argv[1], (open(sys.argv[2]).read().strip() if len(sys.argv) > 2 else "")
mid = email.utils.make_msgid(domain="sender.test")
msg = ("From: Lima Test <lima@sender.test>\r\nTo: you@kasten.test\r\nSubject: Kasten Lima test\r\n"
       "Message-ID: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\n"
       "A test message for kasten check. %s\r\n") % (mid, email.utils.formatdate(), canary)
s = smtplib.SMTP(host, 25, timeout=60)
s.ehlo("client.test")
s.sendmail("lima@sender.test", ["you@kasten.test"], msg)
s.quit()'
smtp() { vsh "python3 -c $(printf '%q' "$SMTP_PY") $*"; }
vm_ip() { vsh 'ip -4 -o addr show dev eth0 | awk "{print \$4}" | cut -d/ -f1'; }

stage_serve() {
  say "serve: SMTP on the VM's address and on ::1, two deliveries stored"
  vin install -m 0755 /dev/stdin /usr/local/bin/kasten-test-jmap <"$ROOT/deploy/test/jmap"
  local ip
  ip=$(vm_ip)
  check "the SMTP banner answers on $ip:25" vsh "exec 3<>/dev/tcp/$ip/25; IFS= read -r -t 10 l <&3; printf 'QUIT\r\n' >&3; echo \"\$l\"; case \$l in 220*) ;; *) exit 1 ;; esac"
  check "the SMTP banner answers on [::1]:25" vsh 'exec 3<>/dev/tcp/::1/25; IFS= read -r -t 10 l <&3; printf "QUIT\r\n" >&3; case $l in 220*) ;; *) exit 1 ;; esac'
  check "the admin API answers on 127.0.0.1:8080 only" vsh 'test -n "$(ss -ltnH "( sport = :8080 )" | grep "127.0.0.1:8080")" && test -z "$(ss -ltnH "( sport = :8080 )" | grep -v "127.0.0.1:8080")"'
  check "SMTP delivery 1 to $ip:25" smtp "$ip"
  check "SMTP delivery 2 to $ip:25, with the canary in the body" smtp "$ip" "$CANARY"
  check "both messages are stored" wait_for 60 vsh 'test "$(kasten-test-jmap count)" -ge 2'
}

stage_pins() {
  say "keys set, lock, reader create"
  local fpr
  fpr=$(vsh "kasten-podman run -i --rm --network=none --read-only --entrypoint node -w /opt/kasten/cli localhost/kasten-cli:$VERSION --input-type=module -e $(printf '%q' "$KEYFPR_JS") </var/lib/kasten/cli/you.pub.asc 2>/dev/null")
  check "kasten-cli keys set" vsh "kasten-cli keys set --account $ACCOUNT --key /etc/kasten/you.pub.asc --config /etc/kasten/kasten.json"
  check "kasten-cli lock" vsh "kasten-cli lock --account $ACCOUNT --no-mfa --user-fingerprint $fpr --config /etc/kasten/kasten.json"
  check "kasten-cli reader create" vsh "kasten-cli reader create --account $ACCOUNT --config /etc/kasten/kasten.json"
  check "the CLI's state files belong to kasten, mode 0600" vsh 'test -z "$(find /var/lib/kasten/cli/state -type f \( ! -user kasten -o -perm /077 \))" && test -s /var/lib/kasten/cli/state/lock.json'
}

stage_check() {
  say "kasten-cli check against the running server"
  local out rc=0
  out=$(vsh 'kasten-cli check --config /etc/kasten/kasten.json --no-push' 2>&1) || rc=$?
  printf '%s\n' "$out" | grep -E '^(scan|result)' | tail -n 2 | sed 's/^/      /'
  if [ "$rc" -eq 0 ] && grep -q '2 messages, 2 encrypted to exactly the key set, 0 exceptions, 0 findings' <<<"$out"; then pass "kasten-cli check: 2 messages, both encrypted to the key set, 0 findings"; else fail "kasten-cli check (exit $rc): $(tail -n 4 <<<"$out")"; fi
}

stage_backup() {
  say "backup through kasten-mail-exec, to a local restic repository on the volume"
  check "mail runs" mail_healthy
  # As docs/operations.md writes it: as the server's user, so that a link that a container's user
  # left in data/ leads nowhere that user could not write anyway. The file keeps the directory's
  # SELinux label, which the running mail container can read; install(1) would give it var_lib_t.
  vsh 'head -c 24 /dev/urandom | base64 | setpriv --reuid=526812 --regid=526812 --clear-groups sh -c "umask 077 && cat >/var/lib/kasten/data/secrets/restic-password"'
  check "the restic password file: the server's user's, mode 0600, the mail level" \
    vsh 'f=/var/lib/kasten/data/secrets/restic-password; test "$(stat -c %u:%g:%a "$f")" = 526812:526812:600 && test "$(stat -c %C "$f" | cut -d: -f3-)" = container_file_t:s0:c525,c526'
  # The two paths are the mail container's view of the volume.
  vsh 'umask 077; printf "%s=%s\n" RESTIC_REPOSITORY /var/lib/kasten/restic-test RESTIC_PASSWORD_FILE /var/lib/kasten/secrets/restic-password >/var/lib/kasten/secrets/backup.env'
  check "backup-init, as deploy/README.md shows it" vsh 'set -a; . /var/lib/kasten/secrets/backup.env; set +a; kasten-mail-exec backup-init'
  check "kasten-mail-exec backup" vsh 'set -a; . /var/lib/kasten/secrets/backup.env; set +a; kasten-mail-exec backup'
  check "kasten-backup.service" vsh 'systemctl start kasten-backup.service'
  check "the repository has two kasten-sqlite snapshots" vsh 'set -a; . /var/lib/kasten/secrets/backup.env; set +a; test "$(kasten-podman exec --env=RESTIC_REPOSITORY --env=RESTIC_PASSWORD_FILE kasten-mail restic snapshots --tag kasten-sqlite --json | jq length)" -ge 2'
  vsh 'systemctl stop kasten.service'
  # The upgrade rollback's route when mail does not run: kasten-backup.service needs kasten.service.
  check "kasten-mail-run backup, with mail stopped" vsh 'set -a; . /var/lib/kasten/secrets/backup.env; set +a; kasten-mail-run backup </dev/null 2>&1 | grep -Eq "^snapshot [0-9a-f]+ saved"'
  check "kasten-mail-run restore latest, with mail stopped" vsh 'set -a; . /var/lib/kasten/secrets/backup.env; set +a; kasten-mail-run restore latest </dev/null'
  check "kasten.service starts on the restored database" vsh 'systemctl start kasten.service'
  check "the messages are still there" wait_for 60 vsh 'test "$(kasten-test-jmap count)" -ge 2'
  local out rc=0
  out=$(vsh 'kasten-mail-run vacuum </dev/null' 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'already using this volume' <<<"$out"; then pass "kasten-mail-run vacuum while mail runs is refused by the server's lock"; else fail "vacuum while running (exit $rc): $(tail -n 2 <<<"$out")"; fi
  check "the labels stayed after the one-shot mail containers" vsh 'test "$(stat -c %C /var/lib/kasten/data)" = system_u:object_r:container_file_t:s0:c525,c526 && test "$(stat -c %C /var/lib/kasten/cli)" = system_u:object_r:container_file_t:s0:c600,c601'
  # root wrote the restic password into data/ after data/ had its level; two mail containers have
  # been created since (the restore and kasten.service).
  vsh 'ls -Z /var/lib/kasten/data/secrets/restic-password | sed "s/^/      /"' || true
  check "the file root wrote into data/ later has the mail level after the next mail containers" \
    vsh 'test "$(stat -c %C /var/lib/kasten/data/secrets/restic-password | cut -d: -f3-)" = container_file_t:s0:c525,c526'
  vsh 'rm -f /var/lib/kasten/data/stalwart/stalwart.sqlite.before-restore-*'
}

# The memory sampler (test only): five times a second, in KiB, the memory in use (MemTotal minus
# MemAvailable), MemAvailable, swap in use, the mail container's cgroup, every other container's
# (the CLI's), dnf5-automatic.service's, tailscaled.service's and the RAM that zram uses.
MEM_SH='#!/bin/bash
U=/sys/fs/cgroup/user.slice/user-2600.slice/user@2600.service/user.slice
# kib <file>: the number in a cgroup file in KiB, or 0. A container that ends removes its cgroup,
# even during the read.
kib() {
  local v
  v=$(cat "$1" 2>/dev/null) || v=0
  case $v in "" | *[!0-9]*) v=0 ;; esac
  echo $((v / 1024))
}
while :; do
  read -r total avail stotal sfree < <(awk "/^MemTotal:/ {t = \$2} /^MemAvailable:/ {a = \$2} /^SwapTotal:/ {st = \$2} /^SwapFree:/ {sf = \$2} END {print t, a, st, sf}" /proc/meminfo)
  mail=0 cli=0 dnf=0 c=
  if p=$(pgrep -xo stalwart) && c=/sys/fs/cgroup$(cut -d: -f3 /proc/$p/cgroup 2>/dev/null); then mail=$(kib $c/memory.current); fi
  for s in $U/libpod-*.scope/container; do
    [ "$s" != "$c" ] || continue
    cli=$((cli + $(kib $s/memory.current)))
  done
  dnf=$(kib /sys/fs/cgroup/system.slice/dnf5-automatic.service/memory.current)
  ts=$(kib /sys/fs/cgroup/system.slice/tailscaled.service/memory.current)
  z=$(awk "{print int(\$3 / 1024)}" /sys/block/zram0/mm_stat 2>/dev/null || echo 0)
  echo "$(date +%s) used=$((total - avail)) avail=$avail swap=$((stotal - sfree)) mail=$mail cli=$cli dnf=$dnf ts=$ts zram=$z"
  sleep 0.2
done'
mem_start() {
  vin install -D -m 0755 /dev/stdin /usr/local/libexec/kasten-test-mem <<<"$MEM_SH"
  vsh 'systemctl stop kasten-test-mem.service 2>/dev/null; awk "/^oom_kill / {print \$2}" /proc/vmstat >/run/kasten-test-oom; date +%s >/run/kasten-test-mem-start
systemd-run --unit=kasten-test-mem --collect --quiet -p StandardOutput=truncate:/run/kasten-test-mem.log /usr/local/libexec/kasten-test-mem'
}
# mem_stop <name> [overlap]: keeps the samples as $OUT/memory-<name>.log, prints the peaks, and
# checks that the kernel killed no process for want of memory since mem_start. With "overlap", some
# samples must show mail, a CLI container and dnf5-automatic all at once.
mem_stop() {
  local f=$OUT/memory-$1.log oom n both
  vsh 'systemctl stop kasten-test-mem.service 2>/dev/null; cat /run/kasten-test-mem.log' >"$f"
  awk '{ for (i = 2; i <= NF; i++) { split($i, a, "="); if (a[2] + 0 > m[a[1]]) m[a[1]] = a[2] + 0 } n++ }
    END { printf "      peaks over %d samples (MiB): in use %d, swap %d, mail %d, other containers %d, dnf5-automatic %d, tailscaled %d, zram RAM %d\n",
      n, m["used"] / 1024, m["swap"] / 1024, m["mail"] / 1024, m["cli"] / 1024, m["dnf"] / 1024, m["ts"] / 1024, m["zram"] / 1024 }' "$f"
  # The acceptance run on the real server passes only while MemAvailable stays at 150 MiB or more.
  awk '{ for (i = 2; i <= NF; i++) { split($i, a, "="); if (a[1] == "avail" && (low == "" || a[2] + 0 < low)) low = a[2] + 0 } }
    END { if (low != "") printf "      lowest MemAvailable: %d MiB\n", low / 1024 }' "$f"
  n=$(grep -c . "$f")
  if [ "$n" -ge 10 ]; then pass "the sampler ran ($n samples, $1)"; else fail "only $n memory samples ($1)"; fi
  if [ "${2:-}" = overlap ]; then
    both=$(awk '{ for (i = 2; i <= NF; i++) { split($i, a, "="); v[a[1]] = a[2] + 0 } if (v["mail"] > 0 && v["cli"] > 0 && v["dnf"] > 0) c++ } END { print c + 0 }' "$f")
    if [ "$both" -ge 1 ]; then pass "mail, a CLI container and dnf5-automatic ran at the same time ($both samples)"; else fail "no sample shows mail, the CLI and dnf5-automatic at once"; fi
    awk '{ for (i = 2; i <= NF; i++) { split($i, a, "="); v[a[1]] = a[2] + 0 } if (v["mail"] > 0 && v["cli"] > 0 && v["dnf"] > 0 && v["used"] > u) u = v["used"] } END { printf "      peak in use while all three ran: %d MiB\n", u / 1024 }' "$f"
  fi
  oom=$(vsh 'echo "$(($(awk "/^oom_kill / {print \$2}" /proc/vmstat) - $(cat /run/kasten-test-oom))) $(journalctl -k --since "@$(cat /run/kasten-test-mem-start)" -o cat --no-pager | grep -ciE "out of memory|oom-kill|invoked oom-killer")"')
  if [ "$oom" = "0 0" ]; then pass "no OOM kill ($1)"; else fail "OOM kills ($1): /proc/vmstat and kernel log: $oom"; fi
}

# The final count. Every denial file of this run is in $OUT.
stage_final() {
  say "SELinux: the denials of the whole stage, then dontaudit back on"
  avc_collect final
  echo "      all stages: $AVC_ALL denials, $AVC_CONTAINER container-related, $AVC_KNOWN the known pasta one (files: $OUT/avc-*.txt)"
  if [ "$AVC_CONTAINER" -eq 0 ]; then pass "zero container-related SELinux denials, with dontaudit off"; else fail "$AVC_CONTAINER container-related SELinux denials"; fi
  check "semodule -B: dontaudit rules on again" vsh 'semodule -B && ! test -e /var/lib/selinux/targeted/active/disable_dontaudit'
}

DOWN_DONE=0
stage_down() {
  say "cleanup"
  DOWN_DONE=1
  ssh_reset
  if limactl list -q 2>/dev/null | grep -qx "$VM"; then
    limactl delete --force "$VM" >>"$OUT/limactl.log" 2>&1 || true
  fi
  docker image rm "$CLI_BUILD" >/dev/null 2>&1 || true
  if limactl list -q 2>/dev/null | grep -qx "$VM"; then fail "the VM $VM is still there"; else pass "the VM $VM is deleted"; fi
}

# run <stage...>: each stage in turn, with its time. "all" runs ALL_STAGES, then deletes the VM,
# also when it stops early; with KASTEN_LIMA_KEEP=1 the VM stays for a look. A failed "up" ends the
# run, because every later stage needs the VM.
run() {
  local s t0 total=$SECONDS
  if [ "$*" = all ]; then
    set -- "${ALL_STAGES[@]}"
    if [ "${KASTEN_LIMA_KEEP:-}" != 1 ]; then
      set -- "$@" down
      trap '[ "$DOWN_DONE" = 1 ] || stage_down' EXIT
    fi
  fi
  for s in "$@"; do
    if ! declare -F "stage_$s" >/dev/null; then
      echo "unknown stage: $s" >&2
      exit 2
    fi
  done
  for s in "$@"; do
    t0=$SECONDS
    if ! "stage_$s" && [ "$s" = up ]; then break; fi
    printf '   (%s: %d s)\n' "$s" $((SECONDS - t0))
  done
  printf '\n%s failure(s), %d s\n' "$FAILS" $((SECONDS - total))
  [ "$FAILS" -eq 0 ]
}

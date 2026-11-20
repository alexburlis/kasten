#!/usr/bin/env bash
# The single-quoted strings are scripts for the VM's shell.
# shellcheck disable=SC2016
# Lima stage A6: the Fedora release upgrade (docs/operations.md), one release, rehearsed with
# Kasten installed.
#
#   LIMA_HOME=~/scratch/kasten/lima deploy/test/lima/upgrade.sh all          every stage, then delete the VM
#   LIMA_HOME=~/scratch/kasten/lima deploy/test/lima/upgrade.sh <stage>...   up install images firstboot pins
#                                         serve check backup bootlog step2 step3 step4 step5 step6 final down
#
# It installs Kasten on Fedora 44 in 1 GiB of memory, then runs the upgrade procedure of the design
# (§8, steps 2 to 6, with amendment A1) to Fedora 45, and asserts:
#   - the volume stays locked across both reboots of the upgrade, the offline one and the first
#     Fedora 45 boot: no unlock is attempted, and the ext4 mount count rises by exactly one, at
#     step 6;
#   - no kasten-mail container exists before step 6;
#   - after step 6: an unlock event, kasten-cli setup prints "0 changed", the SMTP banner answers,
#     both images are still loaded, and kasten-residue-check finds the canary of two messages, one
#     delivered on Fedora 44 and one on Fedora 45, on no disk file system;
#   - no container-related SELinux denial (dontaudit off).
# The procedure's own commands run as written, except where Lima lacks the thing they need: no
# provider snapshot (step 3), no observer (steps 2 and 6; kasten-cli check on the host stands in),
# no Tang (step 6 starts kasten-unlock.service, which fails for want of a binding, then
# kasten-unlock-passphrase unlocks). "-y" answers dnf5's prompts. The offline transaction's journal
# is lost at its own reboot, so a test unit writes Kasten's state at every boot's start and end to
# the disk. lib.sh lists where the VM differs from the VPS. It takes about 10 minutes (5 November
# 2026, on an Apple silicon Mac; the offline transaction alone about 4), plus the first downloads.
set -uo pipefail

VM=${KASTEN_LIMA_VM:-kasten-upgrade}
TEMPLATE=f44.yaml
# shellcheck source=deploy/test/lima/lib.sh
. "$(dirname "$0")/lib.sh"

BOOTLOG=/var/lib/kasten-test/boots.log
BOOTLOG_SH='#!/bin/sh
# Test only (deploy/test/lima/upgrade.sh): Kasten'"'"'s state at the start and the end of this boot.
. /etc/os-release
m=no
mountpoint -q /var/lib/kasten && m=yes
d=no
[ -e /dev/mapper/kasten ] && d=yes
c=n/a
if [ -S /run/user/2600/bus ]; then c=$(/usr/local/sbin/kasten-podman ps -a --format "{{.Names}}" 2>/dev/null | tr "\n" ","); fi
o=no
[ -L /system-update ] || [ -e /system-update ] && o=yes
echo "$(date -u +%FT%TZ) boot=$(cut -c1-8 /proc/sys/kernel/random/boot_id) $1 fedora=$VERSION_ID kernel=$(uname -r) offline-update=$o mounted=$m mapped=$d unlock=$(systemctl show -p ActiveState --value kasten-unlock.service)/$(systemctl show -p ExecMainStartTimestampMonotonic --value kasten-unlock.service) kasten=$(systemctl show -p ActiveState --value kasten.service)/$(systemctl show -p ExecMainStartTimestampMonotonic --value kasten.service) user2600=$(systemctl is-active user@2600.service) containers=${c:-none}" >>/var/lib/kasten-test/boots.log'
# After the Kasten units, so that at a shutdown it writes before they stop. Wanted by
# system-update.target too, so that it also runs in the boot of the offline transaction.
BOOTLOG_UNIT='[Unit]
Description=Test only: Kasten state at the start and the end of each boot
RequiresMountsFor=/var/lib/kasten-test
After=kasten-unlock.service kasten.service user@2600.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/libexec/kasten-test-bootlog start
ExecStop=/usr/local/libexec/kasten-test-bootlog stop

[Install]
WantedBy=multi-user.target system-update.target'

stage_bootlog() {
  say "a test unit that writes Kasten's state at each boot's start and end to the disk"
  vsh 'install -d -m 0700 /var/lib/kasten-test'
  vin install -m 0755 /dev/stdin /usr/local/libexec/kasten-test-bootlog <<<"$BOOTLOG_SH"
  vin install -m 0644 /dev/stdin /etc/systemd/system/kasten-test-bootlog.service <<<"$BOOTLOG_UNIT"
  check "kasten-test-bootlog.service enabled and started" vsh 'systemctl daemon-reload && systemctl enable --now kasten-test-bootlog.service'
  vsh "tail -n 1 $BOOTLOG" | sed 's/^/      /'
}

# mount_count: the ext4 superblock's mount count of the open volume. Every mount raises it.
mount_count() { vsh 'dumpe2fs -h /dev/mapper/kasten 2>/dev/null | sed -n "s/^Mount count: *//p"'; }
avail_kib() { vsh 'df -k --output=avail /var | tail -n 1 | tr -d " "'; }

stage_step2() {
  say "§8 step 2, pre-checks: a backup, the check, Fedora 44 up to date, a reboot, space, the download"
  check "mail runs" mail_healthy
  # The latest snapshot's id. The backup keeps one snapshot a day (restic forget --keep-daily), so
  # the count need not grow; a new latest snapshot shows the backup.
  local latest='set -a; . /var/lib/kasten/secrets/backup.env; set +a; kasten-podman exec --env=RESTIC_REPOSITORY --env=RESTIC_PASSWORD_FILE kasten-mail restic snapshots --tag kasten-sqlite --latest 1 --json | jq -r ".[-1].short_id"'
  local id0 id1
  id0=$(vsh "$latest")
  check "systemctl start kasten-backup.service" vsh 'systemctl start kasten-backup.service'
  id1=$(vsh "$latest")
  echo "      latest snapshot before: $id0, after: $id1"
  if [ -n "$id1" ] && [ "$id1" != null ] && [ "$id1" != "$id0" ]; then pass "the new snapshot is listed"; else fail "no new snapshot (before $id0, after $id1)"; fi
  echo "      observer check: no observer in Lima; kasten-cli check on the host stands in"
  stage_check
  local t0=$SECONDS
  mem_start
  SHOWN_LINES=3 shown "dnf5 -y upgrade --refresh" vsh 'timeout 3600 dnf5 -y upgrade --refresh >/root/kasten-test-dnf-upgrade.log 2>&1; rc=$?; grep -E "^(Transaction Summary|Complete|Nothing to do)" /root/kasten-test-dnf-upgrade.log; grep -cE "^ *(Upgrading|Installing) " /root/kasten-test-dnf-upgrade.log | sed "s/^/packages: /"; exit $rc'
  echo "      the update took $((SECONDS - t0)) s"
  mem_stop step2-upgrade
  dontaudit_off "the update"
  check "mail still runs, healthy, after the update" mail_healthy
  avc_collect step2-before-reboot
  say "§8 step 2: reboot onto the latest Fedora 44"
  t0=$SECONDS
  if restart_vm reboot; then pass "the VM is back ($((SECONDS - t0)) s)"; else fail "the VM did not come back"; return 1; fi
  avc_after_boot
  check "it runs the newest installed kernel" vsh 'test "$(rpm -q --last kernel-core | head -n 1 | cut -d" " -f1)" = "kernel-core-$(uname -r)"'
  vsh 'echo "      kernel $(uname -r)"'
  check "at boot kasten-unlock.service found no Tang binding (Lima): exit 6, no retry" unlock_not_bound
  check "kasten-unlock-passphrase stands in for Tang: unlock, then kasten.service" unlock
  check "mail runs" mail_healthy
  say "§8 step 2: space, then the download (mail keeps running)"
  local before after
  before=$(avail_kib)
  echo "      free on /var before the download: $((before / 1024)) MiB"
  mem_start
  t0=$SECONDS
  SHOWN_LINES=3 shown "dnf5 -y system-upgrade download --releasever=45" vsh 'timeout 3600 dnf5 -y system-upgrade download --releasever=45 >/root/kasten-test-dnf-download.log 2>&1; rc=$?; grep -iE "^(Transaction Summary|Total size|Complete|Download complete|The system-upgrade transaction is ready)" /root/kasten-test-dnf-download.log | tail -n 3; exit $rc'
  echo "      the download took $((SECONDS - t0)) s"
  mem_stop step2-download
  dontaudit_off "the download"
  after=$(avail_kib)
  echo "      the download used $(((before - after) / 1024)) MiB"
  if [ $((before - after)) -gt 0 ] && [ "$before" -ge $((3 * 1048576 + before - after)) ]; then pass "there was at least 3 GiB plus the download free ($((before / 1024)) MiB)"; else fail "free before $((before / 1024)) MiB, download $(((before - after) / 1024)) MiB"; fi
  check "mail kept running through the download, healthy" mail_healthy
  avc_collect step2
}

stage_step3() {
  say "§8 step 3, freeze (A1): lock, then disable both units"
  local mc
  mc=$(mount_count)
  vsh "echo $mc >/root/kasten-test-mount-count"
  echo "      ext4 mount count before the lock: $mc"
  check "systemctl stop kasten.service kasten-unlock.service (locked)" lock
  check "locked: dm closed, loop detached, unmounted" dm_closed
  check "no container" no_containers
  check "systemctl disable kasten.service kasten-unlock.service" vsh 'systemctl disable kasten.service kasten-unlock.service'
  check "both are disabled" vsh 'test "$(systemctl is-enabled kasten.service kasten-unlock.service | tr "\n" " ")" = "disabled disabled "'
  echo "      provider snapshot: none in Lima (the vz driver has no snapshots)"
  avc_collect step3
}

stage_step4() {
  say "§8 step 4: dnf5 system-upgrade reboot; the offline transaction, then Fedora 45"
  local b0 t0=$SECONDS n0 state last=
  b0=$(boot_id)
  n0=$(vsh "wc -l <$BOOTLOG")
  # Without -y, and without a terminal, it asks "Is this ok [y/N]", reads no answer, and exits 0
  # without a reboot.
  vsh 'dnf5 -y system-upgrade reboot' >/dev/null 2>&1 || true
  ssh_reset
  if wait_for 600 sh -c "b=\$(ssh -F '$LIMA_HOME/$VM/ssh.config' -o ControlPath=none -o ConnectTimeout=5 -o LogLevel=ERROR lima-$VM cat /proc/sys/kernel/random/boot_id 2>/dev/null); test -z \"\$b\" || test \"\$b\" != '$b0'"; then pass "dnf5 system-upgrade reboot restarted the VM"; else fail "dnf5 system-upgrade reboot did not restart the VM"; return 1; fi
  # Up to 90 minutes: the transaction runs with 1 GiB of memory.
  while [ $((SECONDS - t0)) -lt 5400 ]; do
    state=$(vsh '. /etc/os-release; echo "boot $(cut -c1-8 /proc/sys/kernel/random/boot_id): Fedora $VERSION_ID, system-update.target $(systemctl is-active system-update.target), $(systemctl is-system-running)"' 2>/dev/null) || state=
    if [ -n "$state" ] && [ "$state" != "$last" ]; then
      echo "      $((SECONDS - t0)) s: $state"
      last=$state
    fi
    case $state in *"Fedora 45, system-update.target inactive, "running* | *"Fedora 45, system-update.target inactive, "degraded*) break ;; esac
    sleep 15
  done
  if vsh '. /etc/os-release; test "$VERSION_ID" = 45'; then pass "Fedora 45 after $((SECONDS - t0)) s"; else fail "not Fedora 45 after $((SECONDS - t0)) s"; return 1; fi
  wait_boot 300
  avc_after_boot
  local log
  log=$(vsh "tail -n +$((n0 + 1)) $BOOTLOG")
  printf '%s\n' "$log" | sed 's/^/      /'
  printf '%s\n' "$log" >"$OUT/boots-step4.log"
  check "the boot log has the offline transaction's boot (/system-update present)" grep -q 'start fedora=44 .*offline-update=yes' <<<"$log"
  check "the boot log has the first Fedora 45 boot" grep -q 'start fedora=45 ' <<<"$log"
  check "in every line since step 3: not mounted, not mapped" awk '!/mounted=no mapped=no/ { bad = 1 } END { exit bad }' <<<"$log"
  # The boot of step 3 started both units before the freeze; every later boot must not.
  check "in both upgrade boots: no unlock and no kasten.service start was even attempted" awk -v b="${b0:0:8}" '$2 != "boot=" b && !/unlock=inactive\/0 kasten=inactive\/0/ { bad = 1 } END { exit bad }' <<<"$log"
  check "no kasten-mail container in any of these boots" awk '/containers=[^ ]*kasten-mail/ { bad = 1 } END { exit bad }' <<<"$log"
}

stage_step5() {
  say "§8 step 5, host checks before mail"
  check "VERSION_ID=45 and an fc45 kernel" vsh '. /etc/os-release; test "$VERSION_ID" = 45 && uname -r | grep -q "\.fc45\."'
  vsh 'echo "      $(. /etc/os-release; echo "$PRETTY_NAME, support until $SUPPORT_END"), kernel $(uname -r)"'
  check "getenforce: Enforcing (targeted, MCS)" vsh 'test "$(getenforce)" = Enforcing && test "$(cat /sys/fs/selinux/mls)" = 1'
  vsh 'kasten-podman info --format "      kasten-podman info: podman {{.Version.Version}}, rootless {{.Host.Security.Rootless}}, transient store {{.Store.TransientStore}}, SELinux {{.Host.Security.SELinuxEnabled}}"'
  check "kasten-podman info: rootless, transient store" vsh 'test "$(kasten-podman info --format "{{.Host.Security.Rootless}} {{.Store.TransientStore}}")" = "true true"'
  echo "      Quadlet dry-run: not applicable (amendment A2: no Quadlet unit)"
  verify_units
  check "nft list table inet kasten" vsh 'nft list table inet kasten >/dev/null'
  check "sysctl ip_unprivileged_port_start = 25" vsh 'test "$(sysctl -n net.ipv4.ip_unprivileged_port_start)" = 25'
  check "swap: zram only" vsh 'grep -q "^/dev/zram0" /proc/swaps && test -z "$(swapon --show=NAME --noheadings | grep -v ^/dev/zram)"'
  check "oomd and auditd masked and stopped (and dnf-makecache.timer)" vsh 'for u in systemd-oomd.service systemd-oomd.socket auditd.service dnf-makecache.timer; do [ "$(systemctl is-enabled $u 2>/dev/null)" = masked ] && ! systemctl is-active -q $u || { echo $u; exit 1; }; done'
  check "dnf5 repo info: the metalinks keep protocol=https" vsh 'test "$(dnf5 -q repo info fedora updates 2>/dev/null | grep -i metalink | grep -c "protocol=https")" = 2'
  check "the journal is still in RAM only" journal_in_ram
  check "the volume is still locked" dm_closed
  check "this boot attempted no unlock: kasten-unlock.service never started, and logged nothing" vsh 'test "$(systemctl show -p ExecMainStartTimestampMonotonic --value kasten-unlock.service)" = 0 && test "$(systemctl show -p ExecMainStartTimestampMonotonic --value kasten.service)" = 0 && test -z "$(journalctl -b -t kasten-unlock -o cat --no-pager)"'
  check "no kasten-mail container before step 6" no_containers
  check "kasten.service and kasten-unlock.service are still disabled" vsh 'test "$(systemctl is-enabled kasten.service kasten-unlock.service | tr "\n" " ")" = "disabled disabled "'
  vsh 'echo "      .rpmnew and .rpmsave files under /etc: $(find /etc \( -name "*.rpmnew" -o -name "*.rpmsave" \) | tr "\n" " ")"'
  if ! vsh 'test -e /var/lib/selinux/targeted/active/disable_dontaudit'; then
    echo "      the policy update turned dontaudit rules back on; the test turns them off again"
    vsh 'semodule -DB'
  fi
  check "dontaudit rules are off" vsh 'test -e /var/lib/selinux/targeted/active/disable_dontaudit'
  copy_deploy
  local out rc=0
  out=$(vsh '/root/kasten-deploy/host/install.sh --skip volume' 2>&1) || rc=$?
  printf '%s\n' "$out" >"$OUT/install-step5.log"
  printf '%s\n' "$out" | grep -E '^install:' | sed 's/^/      /'
  if [ "$rc" -eq 0 ]; then pass "install.sh --skip volume (exit 0)"; else fail "install.sh --skip volume (exit $rc): $(tail -n 5 <<<"$out")"; fi
  check "install.sh enabled both units again (A1: no reboot from here to step 6)" vsh 'systemctl is-enabled -q kasten.service && systemctl is-enabled -q kasten-unlock.service'
  check "still locked, still no container" vsh '! cryptsetup status kasten >/dev/null 2>&1 && ! mountpoint -q /var/lib/kasten && test -z "$(kasten-podman ps -aq)"'
  vsh 'cat /proc/sys/kernel/random/boot_id >/root/kasten-test-step5-boot'
  avc_collect step5
}

stage_step6() {
  say "§8 step 6, mail (A1): enable both units, then start the unlock"
  check "no reboot since step 5 (A1)" vsh 'test "$(cat /proc/sys/kernel/random/boot_id)" = "$(cat /root/kasten-test-step5-boot)"'
  check "systemctl enable kasten.service kasten-unlock.service" vsh 'systemctl enable kasten.service kasten-unlock.service'
  local out rc=0 t0
  out=$(vsh 'systemctl start kasten-unlock.service' 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] && unlock_not_bound; then pass "systemctl start kasten-unlock.service: no Tang binding in Lima (exit 6), as expected"; else fail "systemctl start kasten-unlock.service (exit $rc): $(tail -n 2 <<<"$out")"; fi
  t0=$SECONDS
  check "kasten-unlock-passphrase stands in for Tang: unlock, then kasten.service" unlock
  echo "      unlock and start took $((SECONDS - t0)) s"
  check "the unlock event (method=passphrase in Lima)" vsh 'journalctl -b -t kasten-unlock -o cat --no-pager | grep -q "event=unlock result=ok method=passphrase"'
  local mc0 mc
  mc0=$(vsh 'cat /root/kasten-test-mount-count')
  mc=$(mount_count)
  if [ -n "$mc" ] && [ "$mc" = $((mc0 + 1)) ]; then pass "the ext4 mount count rose by exactly one since step 3 ($mc0 to $mc): no mount in between"; else fail "the ext4 mount count went from $mc0 to $mc"; fi
  check "mail runs, and only kasten-mail exists" vsh 'systemctl is-active -q kasten.service && test "$(kasten-podman ps -a --format "{{.Names}}")" = kasten-mail && test "$(kasten-podman inspect -f "{{.State.Health.Status}}" kasten-mail)" = healthy'
  local ip
  ip=$(vm_ip)
  check "the SMTP banner answers on $ip:25" vsh "exec 3<>/dev/tcp/$ip/25; IFS= read -r -t 10 l <&3; printf 'QUIT\r\n' >&3; case \$l in 220*) ;; *) exit 1 ;; esac"
  rc=0
  out=$(vsh 'kasten-cli setup --config /etc/kasten/kasten.json' 2>&1) || rc=$?
  printf '%s\n' "$out" | grep -E 'changed' | sed 's/^/      /'
  if [ "$rc" -eq 0 ] && grep -q '^0 changed' <<<"$out"; then pass "kasten-cli setup prints 0 changed"; else fail "kasten-cli setup (exit $rc): $(tail -n 4 <<<"$out")"; fi
  echo "      observer check and probe: no observer or SES in Lima; kasten-cli check on the host stands in"
  stage_check
  check "kasten-podman images still lists both images" vsh "test \"\$(kasten-podman images --format '{{.Repository}}:{{.Tag}}' | sort | tr '\n' ' ')\" = 'localhost/kasten-cli:$VERSION localhost/kasten-server:$VERSION '"
  # As docs/operations.md, step 6: a second message with the marker, now to Fedora 45.
  check "a second message with the canary, delivered on Fedora 45" smtp "$ip" "$CANARY"
  check "it is stored" wait_for 60 vsh 'test "$(kasten-test-jmap count)" -ge 3'
  shown "kasten-residue-check: neither canary message (serve stage, Fedora 44; step 6, Fedora 45) is on a disk file system" vsh "timeout 1800 kasten-residue-check $CANARY"
  check "dnf5 system-upgrade clean" vsh 'dnf5 -q system-upgrade clean'
  avc_collect step6
}

ALL_STAGES=(up install images firstboot pins serve check backup bootlog step2 step3 step4 step5 step6 final)
run "$@"

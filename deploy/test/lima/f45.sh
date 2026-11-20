#!/usr/bin/env bash
# The single-quoted strings are scripts for the VM's shell.
# shellcheck disable=SC2016
# Lima stage on Fedora 45: Kasten on a real kernel with enforcing SELinux and 1 GiB of memory.
#
#   LIMA_HOME=~/scratch/kasten/lima deploy/test/lima/f45.sh all          every stage, then delete the VM
#   LIMA_HOME=~/scratch/kasten/lima deploy/test/lima/f45.sh <stage>...   up gate install images firstboot mcs
#                                                pins serve check backup lock a2 a3 a4 a8 reboot final down
#
# It covers what the container test cannot: install.sh under enforcing SELinux without the test
# marker, and its refusal (and kasten-podman's) in permissive mode; the MCS separation of the mail
# and CLI containers; the A2 to A4 proofs of the single container definition on a real kernel
# (memory limits, journald, health, restart, the lock while mail runs and during a start, a reboot
# and a poweroff); the A3 scan of every disk file system on Fedora's btrfs layout; and A8: the peak
# memory of mail, a dnf5-automatic run and kasten-cli check at the same time. lib.sh lists where
# the VM differs from the VPS. It takes about 10 minutes (5 November 2026, on an Apple silicon Mac),
# plus the first download of the image.
set -uo pipefail

VM=${KASTEN_LIMA_VM:-kasten-f45}
TEMPLATE=f45.yaml
# shellcheck source=deploy/test/lima/lib.sh
. "$(dirname "$0")/lib.sh"

stage_gate() {
  say "A5 on a real kernel: install.sh refuses unless SELinux enforces"
  copy_deploy
  local out rc=0
  vsh 'setenforce 0'
  out=$(vsh "$(printf '%q ' "${INSTALL[@]}")" 2>&1) || rc=$?
  vsh 'setenforce 1'
  printf '%s\n' "$out" | tail -n 1 | sed 's/^/      /'
  if [ "$rc" -ne 0 ] && grep -q 'SELinux is not enforcing (getenforce: Permissive)' <<<"$out"; then pass "install.sh refuses in permissive mode (exit $rc)"; else fail "install.sh did not refuse in permissive mode (exit $rc)"; fi
  check "the refused run changed nothing: no kasten user, no volume, no /etc/kasten" vsh '! id kasten >/dev/null 2>&1 && ! test -e /var/lib/kasten.luks && ! test -e /etc/kasten'
  check "Enforcing again" vsh 'test "$(getenforce)" = Enforcing'
}

stage_mcs() {
  say "A5 on a real kernel: kasten-podman refuses to create a container unless SELinux enforces"
  local out rc=0 images=0
  vsh 'setenforce 0'
  out=$(vsh "kasten-podman run --rm --network=none localhost/kasten-cli:$VERSION help" 2>&1) || rc=$?
  if vsh 'kasten-podman images -q >/dev/null'; then images=1; fi
  vsh 'setenforce 1'
  if [ "$rc" = 125 ] && grep -q 'SELinux is not enforcing' <<<"$out"; then pass "in permissive mode, kasten-podman run is refused (exit 125)"; else fail "kasten-podman run in permissive mode (exit $rc): $(tail -n 1 <<<"$out")"; fi
  if [ "$images" = 1 ]; then pass "kasten-podman images still works"; else fail "kasten-podman images in permissive mode"; fi
  check "Enforcing again; mail still runs" vsh 'test "$(getenforce)" = Enforcing && systemctl is-active -q kasten.service'

  say "MCS on a real kernel: root in a mail-level container cannot read the CLI's files"
  # Container root is the kasten user, the files' owner, so only SELinux stands in the way. The
  # mount has no :Z, so nothing is relabelled. wc prints a byte count, never the key.
  avc_collect before-mcs
  local out rc=0
  out=$(vsh ". /usr/local/lib/kasten/podman.sh; kasten-podman run --rm --network=none --user=0:0 --entrypoint=wc --security-opt=label=level:\$MAIL_LEVEL --volume=/var/lib/kasten/cli:/c:ro localhost/kasten-server:$VERSION -c /c/admin-api-key" 2>&1) || rc=$?
  printf '%s\n' "$out" | tail -n 1 | sed 's/^/      /'
  if [ "$rc" -ne 0 ] && grep -q 'Permission denied' <<<"$out"; then pass "at the mail level ($rc): Permission denied"; else fail "the mail level read the admin key (exit $rc)"; fi
  rc=0
  out=$(vsh ". /usr/local/lib/kasten/podman.sh; kasten-podman run --rm --network=none --user=0:0 --entrypoint=wc --security-opt=label=level:\$CLI_LEVEL --volume=/var/lib/kasten/cli:/c:ro localhost/kasten-cli:$VERSION -c /c/admin-api-key" 2>&1) || rc=$?
  printf '%s\n' "$out" | tail -n 1 | sed 's/^/      /'
  if [ "$rc" -eq 0 ]; then pass "positive control at the CLI level: readable"; else fail "the CLI level could not read the admin key (exit $rc)"; fi
  # The denial above is the expected one; it is kept apart from the stage's count. Any other
  # container-related denial in this window counts as usual.
  local f=$OUT/avc-mcs-expected.txt n other expected='scontext=system_u:system_r:container_t:s0:c525,c526 tcontext=system_u:object_r:container_file_t:s0:c600,c601 '
  if ! avc_read >"$f"; then fail "could not read the journal (mcs)"; fi
  n=$(grep -cE "$expected" "$f")
  grep -vE "$expected" "$f" >"$OUT/avc-mcs-other.txt"
  other=$(container_avcs "$OUT/avc-mcs-other.txt" | grep -c .)
  AVC_ALL=$((AVC_ALL + $(grep -c . "$OUT/avc-mcs-other.txt")))
  AVC_CONTAINER=$((AVC_CONTAINER + other))
  grep -E "$expected" "$f" | head -n 1 | grep -oE '\{ [a-z_ ]+ \} for .* comm="[^"]+" name="[^"]+"|scontext=[^ ]+ tcontext=[^ ]+ tclass=[a-z_]+' | sed 's/^/      /'
  if [ "$n" -ge 1 ]; then pass "the kernel logged the denial: $n, from c525,c526 to c600,c601"; else fail "no denial from c525,c526 to c600,c601 was logged ($f)"; fi
  if [ "$other" -eq 0 ]; then pass "no other container-related denial in that window"; else fail "$other other container-related denials in that window"; fi
}

# lock_into_start <seconds>: a passphrase unlock that starts kasten.service, and a lock that many
# seconds after kasten.service began to start, timed inside the VM.
lock_into_start() {
  vsh "d=$1; pass=$PASSPHRASE"'
systemctl stop kasten-test-unlock.service 2>/dev/null
systemd-run --unit=kasten-test-unlock --collect --quiet sh -c "exec kasten-unlock-passphrase <$pass"
i=0
until [ "$(systemctl show -p ActiveState --value kasten.service)" = activating ]; do
  i=$((i + 1))
  [ "$i" -lt 300 ] || { echo "kasten.service did not begin to start"; exit 1; }
  sleep 0.2
done
sleep "$d"
echo "      at the lock: kasten.service $(systemctl show -p SubState --value kasten.service), podman processes $(pgrep -c -x podman), containers $(kasten-podman ps -aq | wc -l)"
systemctl stop kasten.service kasten-unlock.service'
}

stage_lock() {
  say "A2: lock while mail runs, then the passphrase unlock"
  check "mail runs" mail_healthy
  local t0=$SECONDS d since
  since=$(vsh 'date +%s')
  check "systemctl stop kasten.service kasten-unlock.service" lock
  echo "      lock took $((SECONDS - t0)) s"
  check "lock while running: dm closed, loop detached, unmounted" dm_closed
  check "lock while running: no container" no_containers
  check "the empty mount point is immutable" vsh 'test -z "$(ls -A /var/lib/kasten)" && lsattr -d /var/lib/kasten | cut -d" " -f1 | grep -q i && ! touch /var/lib/kasten/probe 2>/dev/null'
  check "the stop logged the mail server's clean exit" vsh "journalctl --since @$since -o cat -u kasten.service --no-pager | grep 'kasten-mail stopped: exit status' | grep -q 'exit status 0'"
  check "the lock event" vsh "journalctl --since @$since -t kasten-unlock -o cat --no-pager | grep -q 'event=lock result=ok'"
  t0=$SECONDS
  check "kasten-unlock-passphrase unlocks and starts kasten.service" unlock
  echo "      unlock and start took $((SECONDS - t0)) s"
  check "mail runs" mail_healthy
  for d in 0 1 2 4 8 20; do
    say "A2: lock ${d} s into a start"
    lock >/dev/null 2>&1
    vsh 'systemctl reset-failed kasten.service kasten-unlock.service 2>/dev/null; true'
    shown "unlock, then lock ${d} s after kasten.service began to start" lock_into_start "$d"
    check "lock ${d} s into a start: dm closed" dm_closed
    check "lock ${d} s into a start: no container" no_containers
    vsh 'systemctl reset-failed 2>/dev/null; true'
  done
  check "unlock again" unlock
  check "mail runs" mail_healthy
  avc_collect lock
}

# The mail container's cgroup, from the stalwart process.
MAIL_CG='p=$(pgrep -xo stalwart); c=/sys/fs/cgroup$(cut -d: -f3 /proc/$p/cgroup)'
PORT_PY='import socket, sys
s = socket.socket(socket.AF_INET6 if ":" in sys.argv[1] else socket.AF_INET)
s.bind((sys.argv[1], int(sys.argv[2])))'
# bind_as_kasten <address> <port>: binds the port as the kasten user, as the mail container does.
bind_as_kasten() { vsh "setpriv --reuid=2600 --regid=2600 --init-groups python3 -c $(printf '%q' "$PORT_PY") $1 $2"; }

stage_a2() {
  say "A2: the single container definition under kasten.service, on a real kernel"
  check "mail runs" mail_healthy
  vsh "$MAIL_CG"'; echo "      stalwart: host uid $(ps -o uid= -p $p | tr -d " "), $(ps -o label= -p $p)"; echo "      cgroup ${c#/sys/fs/cgroup}: memory.max $(cat $c/memory.max), swap.max $(cat $c/memory.swap.max)"; for q in $(pgrep -x conmon); do echo "      conmon: $(cut -d: -f3 /proc/$q/cgroup)"; done'
  check "mail memory.max = 768 MiB" vsh "$MAIL_CG"'; test "$(cat $c/memory.max)" = 805306368'
  check "its cgroup is a libpod scope under user@2600.service" vsh "$MAIL_CG"'; case $c in /sys/fs/cgroup/user.slice/user-2600.slice/user@2600.service/*/libpod-*.scope/container) ;; *) exit 1 ;; esac'
  check "stalwart runs as host uid KASTEN_MAIL_UID (526812), container_t at the mail level" vsh 'p=$(pgrep -xo stalwart); test "$(ps -o uid= -p $p | tr -d " ")" = 526812 && test "$(ps -o label= -p $p)" = system_u:system_r:container_t:s0:c525,c526'
  check "logs reach journald under CONTAINER_NAME=kasten-mail, from uid 2600" vsh 'test "$(journalctl -o cat CONTAINER_NAME=kasten-mail | wc -l)" -gt 5 && test "$(journalctl -o json -n 1 CONTAINER_NAME=kasten-mail | jq -r ._UID)" = 2600'
  check "no container log file on the disk" vsh 'test -z "$(find /home/kasten -name "*.log" -size +0 -not -path "*/overlay/*/diff/*" 2>/dev/null)"'
  vsh 'echo "      logs in RAM: $(find /run/user/2600 -name "*.log" 2>/dev/null | tr "\n" " ")"'
  check "podman diff kasten-mail is only C /etc" vsh 'test "$(kasten-podman diff kasten-mail | tr "\n" " ")" = "C /etc "'
  check "container state in /run/user/2600 (transient store); on the disk only empty files and directories" vsh 'G=/home/kasten/.local/share/containers/storage; id=$(kasten-podman inspect -f "{{.Id}}" kasten-mail); u=$(kasten-podman inspect -f "{{.GraphDriver.Data.UpperDir}}" kasten-mail); test -s /run/user/2600/containers/overlay-containers/$id/userdata/config.json && test -s /run/user/2600/containers/db.sql && ! test -e $G/db.sql && test -z "$(find $G/overlay-containers/$id "$u" -type f -size +0)"'
  check "Stalwart listens on port 25" vsh 'ss -ltnpH "( sport = :25 )" | grep -q stalwart'
  local out
  out=$(bind_as_kasten 0.0.0.0 24 2>&1) || true
  if grep -q 'Permission denied' <<<"$out"; then pass "port 24 stays privileged for the kasten user (EACCES)"; else fail "port 24 for the kasten user: $(tail -n 1 <<<"$out")"; fi
  check "port 26 is unprivileged for the kasten user, IPv4" bind_as_kasten 0.0.0.0 26
  check "port 26 is unprivileged for the kasten user, IPv6" bind_as_kasten :: 26

  say "A2: Podman restarts the server after kill -9"
  local rc0 t0
  rc0=$(vsh 'kasten-podman inspect -f "{{.RestartCount}}" kasten-mail')
  vsh 'kill -9 "$(pgrep -xo stalwart)"'
  t0=$SECONDS
  if wait_for 150 vsh "test \"\$(kasten-podman inspect -f '{{.RestartCount}} {{.State.Status}} {{.State.Health.Status}}' kasten-mail)\" = '$((rc0 + 1)) running healthy'"; then
    pass "restarted and healthy again after kill -9 ($((SECONDS - t0)) s, restart count $((rc0 + 1)))"
  else
    fail "no healthy restart within 150 s: $(vsh 'kasten-podman inspect -f "{{.RestartCount}} {{.State.Status}} {{.State.Health.Status}}" kasten-mail')"
  fi
  check "kasten.service is still active" vsh 'systemctl is-active -q kasten.service'
  check "after the restart, memory.max = 768 MiB" vsh "$MAIL_CG"'; test "$(cat $c/memory.max)" = 805306368'
  avc_collect a2
}

HOLE_PY='import socket, sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1])))
s.listen(64)
held = []
while True:
    held.append(s.accept())'
# hole <port>: a listener on 127.0.0.1 that accepts and never answers, so that requests to it hang.
hole() { vsh "systemd-run --unit=kasten-test-hole-$1 --collect --quiet python3 -c $(printf '%q' "$HOLE_PY") $1"; }
unhole() { vsh "systemctl stop kasten-test-hole-$1.service 2>/dev/null; true"; }

stage_a3() {
  say "A3: canaries in an exec's environment and in a CLI argument, scanned while both run"
  local t0
  check "mail runs" mail_healthy
  vsh 'umask 077; printf "kastenlimaa3%s\n" "$(od -An -N12 -tx1 /dev/urandom | tr -d " \n")" >/run/kasten-test-a3-canary
printf "%s=%s\n" RESTIC_REPOSITORY "rest:http://127.0.0.1:9998/$(cat /run/kasten-test-a3-canary)" RESTIC_PASSWORD_FILE /var/lib/kasten/secrets/restic-password >/run/kasten-test-a3.env'
  hole 9998
  hole 9999
  # As kasten-backup.service runs it: the environment from a file.
  vsh 'systemd-run --unit=kasten-test-exec --collect --quiet -p EnvironmentFile=/run/kasten-test-a3.env /usr/local/sbin/kasten-mail-exec backup'
  vsh 'systemd-run --unit=kasten-test-cli --collect --quiet /usr/local/sbin/kasten-cli keys show --account "$(cat /run/kasten-test-a3-canary)@kasten.test" --config /etc/kasten/kasten.json --url http://127.0.0.1:9999'
  check "both run: restic in an exec session of kasten-mail, and a CLI container" wait_for 60 vsh 'test "$(kasten-podman ps -q | wc -l)" -ge 2 && pgrep -x restic >/dev/null'
  sleep 3
  check "positive control: the canary is in Podman's state in RAM" vsh 'grep -rlaF "$(cat /run/kasten-test-a3-canary)" /run/user/2600/containers | grep -q .'
  vsh 'echo "      RAM files with the canary: $(grep -rlaF "$(cat /run/kasten-test-a3-canary)" /run/user/2600/containers /run/user/2600/crun 2>/dev/null | sed "s|/run/user/2600/||" | cut -c1-90 | tr "\n" " ")"'
  vsh 'echo "      disk file systems scanned: $({ echo /; findmnt -rn -o TARGET -t ext4,xfs,btrfs,vfat; } | sort -u | tr "\n" " ")"'
  check "the scan covers /home (Podman's storage) and /var, which are separate btrfs mounts" vsh 'findmnt -rn -o TARGET -t btrfs | grep -qx /home && findmnt -rn -o TARGET -t btrfs | grep -qx /var'
  # Positive control: a second canary, planted on /, /home and /var, must be found three times.
  vsh 'umask 077; printf "kastenlimactl%s\n" "$(od -An -N12 -tx1 /dev/urandom | tr -d " \n")" >/run/kasten-test-control; for d in /root /home/kasten /var/tmp; do cp /run/kasten-test-control $d/kasten-test-control-copy; done'
  local out rc=0
  out=$(vsh 'timeout 1800 kasten-residue-check /run/kasten-test-control' 2>&1) || rc=$?
  vsh 'rm -f /root/kasten-test-control-copy /home/kasten/kasten-test-control-copy /var/tmp/kasten-test-control-copy /run/kasten-test-control'
  if [ "$rc" -eq 1 ] && grep -q 'unencrypted canary matches: 3' <<<"$out"; then pass "positive control: the scanner finds a canary planted on /, /home and /var (3 matches)"; else fail "positive control (exit $rc): $(tail -n 1 <<<"$out")"; fi
  t0=$SECONDS
  shown "kasten-residue-check while both run: no canary on any disk file system" vsh 'timeout 1800 kasten-residue-check /run/kasten-test-a3-canary'
  echo "      the scan took $((SECONDS - t0)) s"
  check "both still ran when the scan ended" vsh 'test "$(kasten-podman ps -q | wc -l)" -ge 2 && pgrep -x restic >/dev/null'
  unhole 9998
  unhole 9999
  # restic retries a failed backend for minutes; the test ends it.
  vsh 'pkill -x restic; true'
  check "both ended; no CLI container and no exec session left" wait_for 120 vsh 'test "$(kasten-podman ps -aq | wc -l)" = 1 && ! pgrep -x restic && test "$(kasten-podman inspect -f "{{len .ExecIDs}}" kasten-mail)" = 0'
  shown "kasten-residue-check after they ended" vsh 'timeout 1800 kasten-residue-check /run/kasten-test-a3-canary'
  vsh 'systemctl stop kasten-test-exec.service kasten-test-cli.service 2>/dev/null; rm -f /run/kasten-test-a3-canary /run/kasten-test-a3.env'
  avc_collect a3
}

stage_a4() {
  say "A4: lock while kasten-check.service runs kasten-cli check"
  check "mail runs" mail_healthy
  vsh 'install -d /etc/systemd/system/kasten-check.service.d && printf "[Service]\nExecStart=\nExecStart=/usr/local/sbin/kasten-check --url http://127.0.0.1:9999 --no-push\n" >/etc/systemd/system/kasten-check.service.d/zz-test.conf && systemctl daemon-reload'
  hole 9999
  vsh 'systemctl start --no-block kasten-check.service'
  check "the CLI container runs" wait_for 60 vsh 'kasten-podman ps --format "{{.Image}}" | grep -q kasten-cli'
  local pid t0
  pid=$(vsh 'kasten-podman inspect -f "{{.State.Pid}}" "$(kasten-podman ps --format "{{.ID}} {{.Image}}" | awk "/kasten-cli/ {print \$1}")"')
  check "CLI memory.max = 384 MiB, although a system unit started it" vsh "test \"\$(cat /sys/fs/cgroup\$(cut -d: -f3 /proc/$pid/cgroup)/memory.max)\" = 402653184"
  check "catatonit is the CLI container's PID 1" vsh "test \"\$(stat -L -c %d:%i /proc/$pid/exe)\" = \"\$(stat -L -c %d:%i /usr/libexec/podman/catatonit)\""
  check "the CLI runs as container_t at the CLI level" vsh "test \"\$(ps -o label= -p $pid)\" = system_u:system_r:container_t:s0:c600,c601"
  t0=$SECONDS
  check "lock" lock
  echo "      lock took $((SECONDS - t0)) s"
  check "dm closed (the open count reached 0)" dm_closed
  check "no CLI container left" no_containers
  vsh 'echo "      kasten-check.service: $(systemctl show -p ActiveState,Result --value kasten-check.service | tr "\n" " ")"'
  vsh 'rm -rf /etc/systemd/system/kasten-check.service.d && systemctl daemon-reload && systemctl reset-failed; true'
  unhole 9999
  check "unlock again" unlock
  check "mail runs" mail_healthy
  avc_collect a4
}

stage_a8() {
  say "A8: mail, a dnf5-automatic run and a full kasten-cli check at the same time, in 1 GiB, beside tailscaled"
  check "mail runs" mail_healthy
  # The VPS runs tailscaled too. Here it is not signed in, so it holds less than on the VPS.
  check "tailscaled runs (Fedora's package, not signed in)" vsh 'dnf5 -y -q --setopt=install_weak_deps=False install tailscale >/dev/null 2>&1 && systemctl start tailscaled.service && systemctl is-active -q tailscaled.service'
  vsh 'echo "      dnf5-automatic.service: MemoryHigh=$(systemctl show -p MemoryHigh --value dnf5-automatic.service), MemoryMax=$(systemctl show -p MemoryMax --value dnf5-automatic.service); vm.swappiness $(sysctl -n vm.swappiness), vm.min_free_kbytes $(sysctl -n vm.min_free_kbytes), vm.watermark_scale_factor $(sysctl -n vm.watermark_scale_factor)"'
  vsh 'rpm -qa --qf "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\n" | sort >/root/kasten-test-rpms.before'
  local rc0 start
  rc0=$(vsh 'kasten-podman inspect -f "{{.RestartCount}}" kasten-mail')
  vsh 'echo "      before: $(free -m | awk "/^Mem:/ {print \"used \" \$3 \" MiB, available \" \$7 \" MiB of \" \$2}"), swap used $(free -m | awk "/^Swap:/ {print \$3}") MiB"'
  # A daily run refreshes expired metadata, dnf5's largest memory use; this one starts from none.
  check "dnf5 clean all" vsh 'dnf5 -q clean all'
  start=$(vsh 'date +%s')
  mem_start
  check "dnf5-automatic.service starts" vsh 'systemctl start --no-block dnf5-automatic.service && sleep 1 && test "$(systemctl show -p ActiveState --value dnf5-automatic.service)" = activating'
  local runs=0 ok=0 t0=$SECONDS
  while [ "$(vsh 'systemctl show -p ActiveState --value dnf5-automatic.service')" = activating ] && [ $((SECONDS - t0)) -lt 3600 ]; do
    runs=$((runs + 1))
    # A failed check's output (counts, ids and errors, no mail) goes to the VM's notes.
    if vsh 'timeout 300 kasten-cli check --full --config /etc/kasten/kasten.json --no-push' >"$OUT/a8-check.txt" 2>&1; then
      ok=$((ok + 1))
    else
      mv "$OUT/a8-check.txt" "$OUT/a8-check-failed-$runs.txt"
    fi
  done
  check "dnf5-automatic finished" wait_for 3600 vsh '[ "$(systemctl show -p ActiveState --value dnf5-automatic.service)" != activating ]'
  echo "      dnf5-automatic ran $((SECONDS - t0)) s; kasten-cli check ran $runs times alongside it, $ok passed"
  mem_stop a8 overlap
  vsh 'echo "      dnf5-automatic: $(systemctl show -p Result,ExecMainStatus --value dnf5-automatic.service | tr "\n" " ")"'
  check "dnf5-automatic succeeded" vsh 'test "$(systemctl show -p Result --value dnf5-automatic.service)" = success'
  vsh "journalctl -u dnf5-automatic.service --since @$start -o cat --no-pager | grep -E 'memory peak' | tail -n 1 | sed 's/^/      systemd: /'"
  vsh 'rpm -qa --qf "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\n" | sort >/root/kasten-test-rpms.after; echo "      packages changed: $(comm -13 /root/kasten-test-rpms.before /root/kasten-test-rpms.after | wc -l): $(comm -13 /root/kasten-test-rpms.before /root/kasten-test-rpms.after | grep -E "^(kernel-core|podman|crun|conmon|systemd|selinux-policy|container-selinux|netavark|passt)-[0-9]" | tr "\n" " ")"'
  rm -f "$OUT/a8-check.txt"
  if [ "$runs" -ge 1 ] && [ "$ok" -eq "$runs" ]; then pass "kasten-cli check passed every time ($ok of $runs) during the dnf5 run"; else
    fail "kasten-cli check during the dnf5 run: $ok of $runs passed (outputs: $OUT/a8-check-failed-*.txt)"
    tail -q -n 3 "$OUT"/a8-check-failed-*.txt 2>/dev/null | sed 's/^/      /'
  fi
  check "mail stayed up: healthy, no restart, no OOM kill in its cgroup" vsh "$MAIL_CG"'; test "$(kasten-podman inspect -f "{{.RestartCount}} {{.State.Health.Status}}" kasten-mail)" = "'"$rc0"' healthy" && test "$(awk "/^oom_kill / {print \$2}" $c/memory.events)" = 0'
  vsh "$MAIL_CG"'; echo "      mail memory.peak since its last start: $(( $(cat $c/memory.peak) / 1048576 )) MiB"'
  vsh 'rc=0; dnf5 -q needs-restarting >/dev/null 2>&1 || rc=$?; echo "      dnf5 needs-restarting: exit $rc (1: reboot needed, or an error)"'
  vsh 'systemctl stop tailscaled.service'
  dontaudit_off "the dnf5-automatic run"
  avc_collect a8
}

SHUTDOWN_LOG=/var/lib/kasten-test/shutdown.log
# Test drop-ins that write the stop order to the VM's disk, which outlives the journal in RAM.
install_shutdown_log() {
  vsh 'install -d -m 0700 /var/lib/kasten-test
for u in kasten.service kasten-unlock.service user@2600.service; do install -d /etc/systemd/system/$u.d; done
cat >/etc/systemd/system/kasten.service.d/zz-test.conf <<EOF
[Unit]
RequiresMountsFor=/var/lib/kasten-test
[Service]
StandardError=append:/var/lib/kasten-test/shutdown.log
ExecStopPost=/bin/sh -c "n=\$\$(/usr/local/sbin/kasten-podman ps -aq) && c=\$\$(printf %%s \"\$\$n\" | wc -w) || c=podman-failed; echo \"kasten.service stop-post \$\$(date +%%s.%%N) result=\$\$SERVICE_RESULT containers=\$\$c user@2600=\$\$(systemctl is-active user@2600.service)\" >>/var/lib/kasten-test/shutdown.log"
EOF
cat >/etc/systemd/system/kasten-unlock.service.d/zz-test.conf <<EOF
[Unit]
RequiresMountsFor=/var/lib/kasten-test
[Service]
StandardError=append:/var/lib/kasten-test/shutdown.log
ExecStopPost=/bin/sh -c "echo \"kasten-unlock.service stop-post \$\$(date +%%s.%%N) result=\$\$SERVICE_RESULT exit=\$\$EXIT_STATUS mapped=\$\$(test -e /dev/mapper/kasten && echo yes || echo no)\" >>/var/lib/kasten-test/shutdown.log"
ExecStopPost=/bin/sh -c "test \"\$\$(systemctl is-system-running)\" = stopping || exit 0; journalctl _TRANSPORT=audit --after-cursor=\"\$\$(cat /root/kasten-test-avc.cursor)\" -o short-iso --no-pager >/var/lib/kasten-test/avc-shutdown.all || echo journal-read-failed >/var/lib/kasten-test/avc-shutdown.txt; grep -F \"avc:  denied\" /var/lib/kasten-test/avc-shutdown.all >>/var/lib/kasten-test/avc-shutdown.txt; rm -f /var/lib/kasten-test/avc-shutdown.all; true"
EOF
cat >/etc/systemd/system/user@2600.service.d/zz-test.conf <<EOF
[Unit]
RequiresMountsFor=/var/lib/kasten-test
[Service]
ExecStopPost=/bin/sh -c "echo \"user@2600.service stop-post \$\$(date +%%s.%%N)\" >>/var/lib/kasten-test/shutdown.log"
EOF
systemctl daemon-reload'
}

shutdown_ok() {
  # $1: the log of one shutdown. Mail stopped cleanly, then kasten.service ended with no
  # container while user@2600 still ran, then the lock succeeded with the mapping closed.
  awk '
    /kasten-mail stopped: exit status 0/ && !m { m = NR }
    /kasten.service stop-post .* result=success containers=0 user@2600=active/ && !k { k = NR }
    /kasten-unlock.service stop-post .* result=success exit=0 mapped=no/ && !u { u = NR }
    /busy/ { b = 1 }
    END { exit !(m && k && u && m < k && k < u && !b) }' <<<"$1"
}

stage_reboot() {
  install_shutdown_log
  local kind t0 log n
  for kind in reboot poweroff; do
    say "A2: $kind stops mail before the lock"
    mail_healthy >/dev/null 2>&1 || unlock >/dev/null 2>&1
    check "mail runs" mail_healthy
    vsh ": >$SHUTDOWN_LOG; : >/var/lib/kasten-test/avc-shutdown.txt"
    avc_collect "before-$kind"
    t0=$SECONDS
    if [ "$kind" = reboot ]; then echo "      systemctl reboot, inside the VM"; else echo "      systemctl poweroff, inside the VM; then limactl start"; fi
    if restart_vm "$kind"; then pass "$kind: the VM is back ($((SECONDS - t0)) s)"; else fail "$kind: the VM did not come back"; return 1; fi
    log=$(vsh "cat $SHUTDOWN_LOG")
    printf '%s\n' "$log" | sed 's/^/      /'
    if shutdown_ok "$log"; then pass "$kind: mail stopped (exit 0) before kasten.service ended, then the lock closed the mapping; no busy"; else fail "$kind: shutdown order or result"; fi
    vsh 'cat /var/lib/kasten-test/avc-shutdown.txt' >"$OUT/avc-shutdown-$kind.txt"
    refuse "$kind: the shutdown's journal was read" grep -q journal-read-failed "$OUT/avc-shutdown-$kind.txt"
    n=$(container_avcs "$OUT/avc-shutdown-$kind.txt" | grep -c .)
    AVC_ALL=$((AVC_ALL + $(grep -c . "$OUT/avc-shutdown-$kind.txt")))
    AVC_CONTAINER=$((AVC_CONTAINER + n))
    echo "      SELinux denials up to the lock in that shutdown: $(grep -c . "$OUT/avc-shutdown-$kind.txt"), container-related: $n"
    avc_after_boot
    check "$kind: at boot kasten-unlock.service found no Tang binding: exit 6, no retry" unlock_not_bound
    check "$kind: the volume stayed locked, mail did not start, no container" vsh '! cryptsetup status kasten >/dev/null 2>&1 && ! mountpoint -q /var/lib/kasten && ! systemctl is-active -q kasten.service && test -z "$(kasten-podman ps -aq)"'
    check "$kind: both images are still loaded" vsh "test \"\$(kasten-podman images --format '{{.Repository}}:{{.Tag}}' | sort | tr '\n' ' ')\" = 'localhost/kasten-cli:$VERSION localhost/kasten-server:$VERSION '"
    check "$kind: Enforcing, dontaudit still off, sysctl 25, zram swap, journal in RAM, oomd and auditd masked" vsh 'test "$(getenforce)" = Enforcing && test -e /var/lib/selinux/targeted/active/disable_dontaudit && test "$(sysctl -n net.ipv4.ip_unprivileged_port_start)" = 25 && grep -q "^/dev/zram0" /proc/swaps && test -z "$(swapon --show=NAME --noheadings | grep -v ^/dev/zram)" && ! systemctl is-active -q systemd-oomd.service auditd.service && nft list table inet kasten >/dev/null'
    check "$kind: the journal is still in RAM only" journal_in_ram
    vsh 'echo "      kernel $(uname -r)"'
    t0=$SECONDS
    check "$kind: kasten-unlock-passphrase unlocks and starts kasten.service" unlock
    echo "      unlock and start took $((SECONDS - t0)) s"
    check "$kind: mail runs, and only kasten-mail exists" vsh 'systemctl is-active -q kasten.service && test "$(kasten-podman ps -a --format "{{.Names}}")" = kasten-mail && test "$(kasten-podman inspect -f "{{.State.Health.Status}}" kasten-mail)" = healthy'
    check "$kind: kasten-cli setup prints 0 changed" vsh 'kasten-cli setup --config /etc/kasten/kasten.json 2>&1 | grep -q "^0 changed"'
    avc_collect "after-$kind"
  done
  vsh 'rm -rf /etc/systemd/system/kasten.service.d /etc/systemd/system/kasten-unlock.service.d /etc/systemd/system/user@2600.service.d && systemctl daemon-reload'
}

ALL_STAGES=(up gate install images firstboot mcs pins serve check backup lock a2 a3 a4 a8 reboot final)
run "$@"

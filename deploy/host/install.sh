#!/bin/sh
# install.sh: set up a fresh Fedora VPS as the Kasten mail host. Safe to run again.
#
# Run it as root from a copy of the repository's deploy/ directory:
#   deploy/host/install.sh [options]
#
# Options:
#   --admin-ips "ADDR ..."   also allow SSH from these IPv4 or IPv6 addresses or networks
#   --data-size SIZE         size of the encrypted volume file, for example 24G (default: auto)
#   --mail-api-host NAME     the mail API host, kasten.json's mailApiHostname, for example
#                            mail.example.com. Sets STALWART_PUBLIC_URL=https://NAME
#   --passphrase-file FILE   read the new recovery passphrase from the first line of FILE. Keep
#                            FILE under /run, in RAM: a deleted file's blocks stay on the disk
#   --skip STEP              skip a step; repeat for more. The steps, in order:
#                            packages journald swap fstrim user volume units firewall
#
# Only the volume step needs the recovery passphrase, and only when it creates the volume. On a
# terminal install.sh asks for it twice; otherwise it reads the first line of standard input.
# It never takes the passphrase as an argument. Options are kept in /etc/kasten/host.env, and
# the mail API URL in /opt/kasten/.env. Without --mail-api-host, install.sh keeps the URL that
# is there, or asks for the host name on a terminal.
#
# It runs only on the Fedora releases in SUPPORTED, and only while SELinux enforces the targeted
# policy with MCS: the containers' MCS levels keep the mail server away from the CLI's credentials.
set -eu

HOST_DIR=$(cd "$(dirname "$0")" && pwd)
HOST_ENV=/etc/kasten/host.env
ENV_FILE=/opt/kasten/.env
LUKS_FILE=/var/lib/kasten.luks
MNT=/var/lib/kasten
# The host user of every container (rootless Podman), with a fixed uid and gid. The units and
# kasten-podman name it by number: user@2600.service, /run/user/2600.
KASTEN_USER=kasten
KASTEN_UID=2600
# The kasten user and group of the kasten-server image (server/Dockerfile).
SERVER_UID=2525
# A release joins this list only after the local tests (deploy/test) pass on it.
SUPPORTED="44 45"
# setpriv is in util-linux and cmp in diffutils, which minimal images may lack. dnf5-plugins holds
# "dnf5 needs-restarting", which tells the operator when an update needs a reboot.
PACKAGES="podman crun conmon passt nftables cryptsetup clevis clevis-luks dnf5-plugin-automatic dnf5-plugins zram-generator sqlite e2fsprogs jq curl policycoreutils util-linux diffutils"
STEPS="packages journald swap fstrim user volume units firewall"
# Only deploy/test/run.sh creates this file: its container cannot enforce SELinux.
NO_SELINUX_MARKER=/etc/kasten/test-without-selinux

log() { printf 'install: %s\n' "$*" >&2; }
die() {
  printf 'install: error: %s\n' "$*" >&2
  exit 1
}

usage() { sed -n '2,24s/^# \{0,1\}//p' "$0"; }

admin_set=false
admin_opt=
size_opt=
host_opt=
pass_file=
skip=" "
while [ "$#" -gt 0 ]; do
  case $1 in
    --admin-ips | --data-size | --mail-api-host | --passphrase-file | --skip)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      case $1 in
        --admin-ips)
          admin_set=true
          admin_opt=$2
          ;;
        --data-size) size_opt=$2 ;;
        --mail-api-host) host_opt=$2 ;;
        --passphrase-file) pass_file=$2 ;;
        --skip)
          case " $STEPS " in
            *" $2 "*) skip="$skip$2 " ;;
            *) die "unknown step: $2 (steps: $STEPS)" ;;
          esac
          ;;
      esac
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

want() {
  case $skip in
    *" $1 "*) return 1 ;;
  esac
}

# put <source> <target> <mode>: install a file if its content differs. Sets CHANGED.
put() {
  CHANGED=false
  if [ -f "$2" ] && cmp -s "$1" "$2"; then
    chmod "$3" "$2"
    return 0
  fi
  install -D -m "$3" "$1" "$2.kasten-new"
  mv -f "$2.kasten-new" "$2"
  CHANGED=true
}

# as_kasten <script>: runs a shell script as the kasten user, with a clean environment. Root never
# writes into a directory that kasten owns (its home, the volume's cli/): it would follow a link
# that kasten left there, and then write, chown or chmod any file. As kasten, a link leads only to
# what kasten could change anyway.
as_kasten() {
  (cd / && exec env -i PATH=/usr/sbin:/usr/bin HOME=/home/kasten \
    setpriv --reuid="$KASTEN_UID" --regid="$KASTEN_UID" --init-groups sh -c "$1")
}

# mask_now <unit...>: keep units from ever starting, even as a dependency, and stop them.
mask_now() {
  systemctl mask -q "$@"
  for u do
    systemctl is-active -q "$u" || continue
    # auditd.service refuses a stop by hand (RefuseManualStop=yes); a signal ends it.
    systemctl stop "$u" 2>/dev/null || systemctl kill "$u"
  done
}

# The containers' MCS levels (podman.sh) are what keeps the mail server from reading the CLI's
# credentials, so SELinux must enforce the targeted policy, with MCS.
selinux_gate() {
  if [ -e "$NO_SELINUX_MARKER" ]; then
    log "WARNING: $NO_SELINUX_MARKER exists, so SELinux is not checked, and the mail server could read the CLI's credentials. Only the local container test creates this file. Never create it on a real host."
    logger -t kasten-install -p daemon.warning -- "event=selinux-check result=skipped marker=$NO_SELINUX_MARKER" 2>/dev/null || true
    return 0
  fi
  mode=$(getenforce 2>/dev/null || true)
  [ "$mode" = Enforcing ] || die "SELinux is not enforcing (getenforce: ${mode:-not found}). Set SELINUX=enforcing in /etc/selinux/config, reboot, then run install.sh again."
  [ "$(cat /sys/fs/selinux/mls 2>/dev/null)" = 1 ] || die "the loaded SELinux policy has no MCS (/sys/fs/selinux/mls is not 1)"
  sestatus | grep -Eq '^Loaded policy name:[[:space:]]+targeted$' || die "the loaded SELinux policy is not the targeted policy"
}

load_settings() {
  KASTEN_ADMIN_IPS=""
  KASTEN_DATA_SIZE=auto
  KASTEN_UNLOCK_TIMEOUT=300
  KASTEN_DM_NAME=kasten
  KASTEN_MAIL_UID=
  KASTEN_UNLOCK_PUSH_URL_FILE=
  KASTEN_EVENT_PUSH_STATUS=down
  if [ -r "$HOST_ENV" ]; then
    # shellcheck source=deploy/host/host.env
    . "$HOST_ENV"
  fi
  if $admin_set; then KASTEN_ADMIN_IPS=$admin_opt; fi
  [ -z "$size_opt" ] || KASTEN_DATA_SIZE=$size_opt

  for a in $KASTEN_ADMIN_IPS; do
    case $a in
      *[!0-9A-Fa-f:./]* | '') die "not an IP address or network: $a" ;;
    esac
  done
  case $KASTEN_DATA_SIZE in
    auto) ;;
    [1-9]*[MGT]) case ${KASTEN_DATA_SIZE%?} in *[!0-9]*) die "--data-size must look like 24G" ;; esac ;;
    *) die "--data-size must look like 24G" ;;
  esac
  case $KASTEN_UNLOCK_TIMEOUT in
    '' | *[!0-9]*) die "KASTEN_UNLOCK_TIMEOUT must be a number of seconds" ;;
  esac
  case $KASTEN_DM_NAME in
    '' | *[!a-z0-9_-]*) die "KASTEN_DM_NAME may contain only a-z, 0-9, _ and -" ;;
  esac
  case $KASTEN_MAIL_UID in
    *[!0-9]*) die "KASTEN_MAIL_UID must be a number" ;;
  esac
  case $KASTEN_UNLOCK_PUSH_URL_FILE in
    '') ;;
    /*) case $KASTEN_UNLOCK_PUSH_URL_FILE in *[!A-Za-z0-9_./-]*) die "KASTEN_UNLOCK_PUSH_URL_FILE must be an absolute path without spaces" ;; esac ;;
    *) die "KASTEN_UNLOCK_PUSH_URL_FILE must be an absolute path" ;;
  esac
  case $KASTEN_EVENT_PUSH_STATUS in up | down) ;; *) die "KASTEN_EVENT_PUSH_STATUS must be up or down" ;; esac
}

write_settings() {
  install -d -m 0755 /etc/kasten
  sed -e "s|^KASTEN_ADMIN_IPS=.*|KASTEN_ADMIN_IPS=\"$KASTEN_ADMIN_IPS\"|" \
    -e "s|^KASTEN_DATA_SIZE=.*|KASTEN_DATA_SIZE=\"$KASTEN_DATA_SIZE\"|" \
    -e "s|^KASTEN_UNLOCK_TIMEOUT=.*|KASTEN_UNLOCK_TIMEOUT=$KASTEN_UNLOCK_TIMEOUT|" \
    -e "s|^KASTEN_DM_NAME=.*|KASTEN_DM_NAME=$KASTEN_DM_NAME|" \
    -e "s|^KASTEN_MAIL_UID=.*|KASTEN_MAIL_UID=$KASTEN_MAIL_UID|" \
    -e "s|^KASTEN_UNLOCK_PUSH_URL_FILE=.*|KASTEN_UNLOCK_PUSH_URL_FILE=$KASTEN_UNLOCK_PUSH_URL_FILE|" \
    -e "s|^KASTEN_EVENT_PUSH_STATUS=.*|KASTEN_EVENT_PUSH_STATUS=$KASTEN_EVENT_PUSH_STATUS|" \
    "$HOST_DIR/host.env" >"$HOST_ENV.kasten-new"
  chmod 0644 "$HOST_ENV.kasten-new"
  mv -f "$HOST_ENV.kasten-new" "$HOST_ENV"
}

# The last value of NAME in /opt/kasten/.env, or nothing.
env_value() {
  [ -r "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

valid_host() {
  case $1 in
    '' | *[!a-z0-9.-]* | .* | *. | *..* | -* | *- | *.-* | *-.*) return 1 ;;
    *.*) return 0 ;;
    *) return 1 ;;
  esac
}

# Sets PUBLIC_URL, the mail API's URL. Stalwart uses it as the OAuth issuer and as the base of
# every JMAP session URL, so it must be https://<mailApiHostname>.
public_url() {
  host=$host_opt
  if [ -z "$host" ]; then
    PUBLIC_URL=$(env_value STALWART_PUBLIC_URL)
    [ -z "$PUBLIC_URL" ] || return 0
    [ -t 0 ] || die "pass --mail-api-host with the mail API host name from kasten.json, for example mail.example.com"
    printf 'Mail API host name, as mailApiHostname in kasten.json (for example mail.example.com): ' >&2
    IFS= read -r host || true
  fi
  host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
  valid_host "$host" || die "not a host name: $host"
  PUBLIC_URL=https://$host
}

# Creates /opt/kasten/.env, or sets STALWART_PUBLIC_URL in it and keeps every other line.
write_env() {
  if [ ! -e "$ENV_FILE" ]; then
    install -d -m 0755 "${ENV_FILE%/*}"
    {
      printf '# Kasten container settings. Not secret. Every line reaches the mail containers.\n'
      printf 'KASTEN_VERSION=\nKASTEN_VOLUME_ID=\nSTALWART_PUBLIC_URL=%s\n' "$PUBLIC_URL"
    } >"$ENV_FILE.kasten-new"
    chmod 0644 "$ENV_FILE.kasten-new"
    mv -f "$ENV_FILE.kasten-new" "$ENV_FILE"
    return 0
  fi
  if grep -q '^STALWART_PUBLIC_URL=' "$ENV_FILE"; then
    sed -i "s|^STALWART_PUBLIC_URL=.*|STALWART_PUBLIC_URL=$PUBLIC_URL|" "$ENV_FILE"
  else
    printf 'STALWART_PUBLIC_URL=%s\n' "$PUBLIC_URL" >>"$ENV_FILE"
  fi
}

read_passphrase() {
  if [ -n "$pass_file" ]; then
    [ -r "$pass_file" ] || die "cannot read $pass_file"
    IFS= read -r PASSPHRASE <"$pass_file" || [ -n "${PASSPHRASE:-}" ] || die "$pass_file is empty"
  elif [ -t 0 ]; then
    trap 'stty echo' INT TERM
    stty -echo
    printf 'New recovery passphrase for the mail volume: ' >&2
    IFS= read -r PASSPHRASE || true
    printf '\nRepeat it: ' >&2
    IFS= read -r again || true
    stty echo
    trap - INT TERM
    printf '\n' >&2
    [ "$PASSPHRASE" = "$again" ] || die "the two passphrases differ"
    unset again
  else
    IFS= read -r PASSPHRASE || [ -n "${PASSPHRASE:-}" ] || die "no passphrase on standard input"
  fi
  [ "${#PASSPHRASE}" -ge 20 ] || die "the recovery passphrase must have at least 20 characters"
}

step_packages() {
  # Before the first download: HTTPS mirrors only, because the firewall closes outgoing port 80.
  put "$HOST_DIR/conf/repos-https.repo" /etc/dnf/repos.override.d/50-kasten-https.repo 0644
  # shellcheck disable=SC2086 # word splitting is intended
  dnf5 -y -q --setopt=install_weak_deps=False install $PACKAGES </dev/null
  put "$HOST_DIR/conf/automatic.conf" /etc/dnf/automatic.conf 0644
  systemctl enable --now dnf5-automatic.timer
  # dnf-makecache.timer would refresh the same metadata every three hours, and dnf5's solver is
  # the largest memory user on a 1 GB host. dnf5-automatic refreshes it once a day.
  mask_now dnf-makecache.timer
}

# A syslog daemon would write the logs, with Stalwart's envelope addresses, to /var/log on the
# unencrypted disk. journald.conf stops forwarding to one, but a daemon can also read the journal
# itself, so install.sh refuses to run beside one. auditd would write the audit log there, and
# systemd-coredump the memory of a crashed process: auditd is masked (the kernel's audit messages
# still reach the journal in RAM), and core dumps are not stored.
step_journald() {
  put "$HOST_DIR/conf/journald.conf" /etc/systemd/journald.conf.d/kasten.conf 0644
  if $CHANGED; then systemctl restart systemd-journald.service; fi
  syslogd=
  for pkg in rsyslog syslog-ng; do
    if rpm -q --quiet "$pkg"; then syslogd="$syslogd $pkg"; fi
  done
  [ -z "$syslogd" ] || die "a syslog daemon is installed:$syslogd. It would write the logs to the unencrypted disk. Remove it with dnf5 -y remove$syslogd, delete its files in /var/log, then run install.sh again."
  mask_now auditd.service
  put "$HOST_DIR/conf/coredump.conf" /etc/systemd/coredump.conf.d/kasten.conf 0644
}

# Succeeds if /etc/fstab has a disk swap row that is not commented out.
fstab_swap() {
  awk '$1 !~ /^#/ && $3 == "swap" { found = 1 } END { exit !found }' /etc/fstab
}

# Disk swap would write memory, which holds decrypted mail and credentials, to the unencrypted
# disk. zram compresses swap in RAM instead.
step_swap() {
  tail -n +2 /proc/swaps | while read -r name _; do
    case $name in
      /dev/zram*) ;;
      *)
        log "turning off disk swap $name"
        swapoff "$name"
        ;;
    esac
  done
  if fstab_swap; then
    # fstab(5) lets a row end after its type, so nothing needs to follow "swap".
    sed -i -E 's|^([[:space:]]*[^#[:space:]][^[:space:]]*[[:space:]]+[^[:space:]]+[[:space:]]+swap([[:space:]].*)?)$|# kasten: disk swap off, zram instead: \1|' /etc/fstab
    systemctl daemon-reload
    if fstab_swap; then
      die "/etc/fstab still has an active swap entry, which the next boot would turn on. Comment it out, then run install.sh again."
    fi
    log "commented out the swap entries in /etc/fstab"
  fi
  # systemd also turns on swap that fstab does not list, such as a GPT swap partition that it
  # discovers. A masked swap unit stays off.
  # The zram device has more swap units than dev-zram0.swap, one for each of its other names, such
  # as dev-disk-by\x2dlabel-zram0.swap, so look at the device each unit names.
  systemctl list-units --type=swap --all --plain --no-legend | while read -r unit _; do
    case $(readlink -f "$(systemctl show -p What --value "$unit")") in
      /dev/zram*) ;;
      *)
        log "masking the disk swap unit $unit"
        systemctl mask -q "$unit"
        ;;
    esac
  done
  put "$HOST_DIR/conf/zram-generator.conf" /etc/systemd/zram-generator.conf 0644
  if $CHANGED || ! grep -q '^/dev/zram' /proc/swaps; then
    systemctl daemon-reload
    # Not "systemctl restart systemd-zram-setup@zram0": its stop resets the device right after the
    # swapoff, while udev still probes it, and then fails with "Device or resource busy", which
    # leaves no swap. Reset the device once udev is done, then start the swap with the new settings.
    systemctl stop systemd-zram-setup@zram0.service 2>/dev/null || true
    tries=0
    while [ "$(cat /sys/block/zram0/disksize 2>/dev/null || echo 0)" != 0 ]; do
      tries=$((tries + 1))
      [ "$tries" -le 10 ] || die "/dev/zram0 stays busy. Reboot, then run install.sh again."
      udevadm settle
      echo 1 >/sys/block/zram0/reset 2>/dev/null || sleep 1
    done
    systemctl reset-failed systemd-zram-setup@zram0.service dev-zram0.swap 2>/dev/null || true
    systemctl start dev-zram0.swap
  fi
  grep -q '^/dev/zram' /proc/swaps || die "zram swap is not active. Does this kernel have the zram module?"
}

step_fstrim() {
  systemctl enable --now fstrim.timer
}

# The kasten user runs every container: rootless Podman. useradd gives it a range of subordinate
# IDs, which become the containers' users on the host: container root is kasten itself, and
# container uid N is the Nth subordinate ID. The mail server's uid 2525 therefore owns its files
# on the host as KASTEN_MAIL_UID, the first subordinate ID plus 2524.
step_user() {
  if ! getent passwd "$KASTEN_USER" >/dev/null; then
    if getent passwd "$KASTEN_UID" >/dev/null || getent group "$KASTEN_UID" >/dev/null; then
      die "uid or gid $KASTEN_UID belongs to another user or group; the $KASTEN_USER user needs both"
    fi
    getent group "$KASTEN_USER" >/dev/null || groupadd -g "$KASTEN_UID" "$KASTEN_USER"
    useradd -u "$KASTEN_UID" -g "$KASTEN_USER" -d /home/kasten -m -s /usr/sbin/nologin \
      -c "Kasten containers" "$KASTEN_USER"
    log "created the user $KASTEN_USER (uid $KASTEN_UID)"
  fi
  [ "$(id -u "$KASTEN_USER"):$(id -g "$KASTEN_USER")" = "$KASTEN_UID:$KASTEN_UID" ] ||
    die "the user $KASTEN_USER exists, but its uid and gid are not $KASTEN_UID"
  [ "$(getent passwd "$KASTEN_USER" | cut -d: -f6,7)" = /home/kasten:/usr/sbin/nologin ] ||
    die "the user $KASTEN_USER must have the home /home/kasten and the shell /usr/sbin/nologin"
  # Nobody logs in as kasten: no password, no shell. root reaches it through kasten-podman.
  case $(getent shadow "$KASTEN_USER" | cut -d: -f2) in
    '!'*) ;;
    *) usermod -L "$KASTEN_USER" ;;
  esac

  subuid=$(awk -F: -v u="$KASTEN_USER" '$1 == u { print $2 ":" $3 }' /etc/subuid)
  subgid=$(awk -F: -v u="$KASTEN_USER" '$1 == u { print $2 ":" $3 }' /etc/subgid)
  case $subuid in
    '' | *[!0-9:]*) die "/etc/subuid needs exactly one range for $KASTEN_USER (useradd adds one)" ;;
  esac
  [ "$subuid" = "$subgid" ] || die "/etc/subuid and /etc/subgid give $KASTEN_USER different ranges ($subuid, $subgid); Kasten needs the same range in both"
  [ "${subuid#*:}" -ge 65536 ] || die "the subordinate range of $KASTEN_USER ($subuid) has fewer than 65536 IDs"
  mail_uid=$((${subuid%%:*} + SERVER_UID - 1))
  if [ -n "$KASTEN_MAIL_UID" ] && [ "$KASTEN_MAIL_UID" != "$mail_uid" ]; then
    die "the subordinate range of $KASTEN_USER changed: the mail files belong to uid $KASTEN_MAIL_UID, the range now maps the server to $mail_uid"
  fi
  KASTEN_MAIL_UID=$mail_uid
  write_settings

  # The user's own manager starts at boot and holds the containers' cgroups (memory limits) and
  # Podman's session bus.
  loginctl enable-linger "$KASTEN_USER"
  systemctl start "user@$KASTEN_UID.service"
  # systemd-oomd kills every process of a cgroup under memory pressure, including the user slice
  # that holds the mail container. The containers' memory limits and the kernel's OOM killer stay.
  mask_now systemd-oomd.service systemd-oomd.socket

  put "$HOST_DIR/conf/sysctl.conf" /etc/sysctl.d/50-kasten.conf 0644
  sysctl -q -p /etc/sysctl.d/50-kasten.conf
  # Another file could set the same key and win at the next boot.
  others=$(grep -lsE '^[[:space:]]*-?net[./]ipv4[./]ip_unprivileged_port_start' /etc/sysctl.conf \
    /etc/sysctl.d/*.conf /run/sysctl.d/*.conf /usr/local/lib/sysctl.d/*.conf /usr/lib/sysctl.d/*.conf |
    grep -vx /etc/sysctl.d/50-kasten.conf || true)
  [ -z "$others" ] || die "these files also set net.ipv4.ip_unprivileged_port_start: $others. Remove the setting from them, then run install.sh again."

  put "$HOST_DIR/conf/containers.conf" /etc/containers/containers.conf.d/50-kasten.conf 0644
  # kasten writes its own storage.conf, from standard input: install.sh's copy may be in a
  # directory that kasten cannot read, such as /root.
  # shellcheck disable=SC2016 # kasten's shell expands $d
  as_kasten 'umask 077 && d=/home/kasten/.config/containers && mkdir -p "$d" && cat >"$d/storage.conf.kasten-new" &&
    if cmp -s "$d/storage.conf.kasten-new" "$d/storage.conf"; then rm -f "$d/storage.conf.kasten-new"; else mv -f "$d/storage.conf.kasten-new" "$d/storage.conf"; fi' \
    <"$HOST_DIR/conf/storage.conf" || die "the $KASTEN_USER user could not write /home/kasten/.config/containers/storage.conf"
  podman_mode=$("$HOST_DIR/kasten-podman" info --format '{{.Host.Security.Rootless}} {{.Store.TransientStore}}')
  [ "$podman_mode" = "true true" ] || die "Podman for $KASTEN_USER must be rootless with a transient store; podman info says: $podman_mode"
  log "user $KASTEN_USER: uid $KASTEN_UID, subordinate IDs $subuid, mail files owned by uid $KASTEN_MAIL_UID"
}

volume_size() {
  if [ "$KASTEN_DATA_SIZE" != auto ]; then
    printf '%s\n' "$KASTEN_DATA_SIZE"
    return 0
  fi
  # The sparse file grows into the free space as mail arrives. Six GiB of it stay free for the
  # images and the OS updates.
  free_kib=$(df -k --output=avail /var/lib | tail -n 1 | tr -d ' ')
  gib=$((free_kib / 1048576 - 6))
  [ "$gib" -ge 4 ] || die "the root file system has too little free space to size the volume automatically; pass --data-size"
  printf '%sG\n' "$gib"
}

# data/ belongs to the mail server's user, cli/ to kasten (container root of the CLI), and
# secrets/ to root alone: no container mounts it. The volume's root belongs to root, so root may
# create and set these three. cli/state/ is inside cli/, which kasten owns, so kasten creates it.
volume_dirs() {
  [ -n "$KASTEN_MAIL_UID" ] || die "KASTEN_MAIL_UID is not set in $HOST_ENV; run install.sh without --skip user"
  install -d -m 0700 -o "$KASTEN_MAIL_UID" -g "$KASTEN_MAIL_UID" "$MNT/data"
  install -d -m 0700 -o "$KASTEN_USER" -g "$KASTEN_USER" "$MNT/cli"
  as_kasten "mkdir -p -m 0700 $MNT/cli/state && chmod 0700 $MNT/cli/state" ||
    die "the $KASTEN_USER user could not create $MNT/cli/state"
  install -d -m 0700 -o root -g root "$MNT/secrets"
}

abort_volume() {
  log "volume creation failed; removing the incomplete $LUKS_FILE.new"
  if mountpoint -q "$MNT"; then umount "$MNT"; fi
  if cryptsetup status "$KASTEN_DM_NAME" >/dev/null 2>&1; then cryptsetup close "$KASTEN_DM_NAME"; fi
  for l in $(losetup -n -O NAME -j "$LUKS_FILE.new"); do losetup -d "$l"; done
  rm -f "$LUKS_FILE.new"
}

create_volume() {
  if cryptsetup status "$KASTEN_DM_NAME" >/dev/null 2>&1; then
    die "/dev/mapper/$KASTEN_DM_NAME already exists, but $LUKS_FILE does not"
  fi
  size=$(volume_size)
  log "creating the encrypted volume $LUKS_FILE ($size, sparse)"
  trap abort_volume EXIT
  # Not every shell runs the EXIT trap when a signal ends it (dash does not).
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  (
    umask 077
    : >"$LUKS_FILE.new"
    # On btrfs, as for any disk image: no copy-on-write, which would fragment the file with every
    # write. chattr +C takes effect only on an empty file.
    if [ "$(stat -f -c %T "${LUKS_FILE%/*}" 2>/dev/null)" = btrfs ]; then chattr +C "$LUKS_FILE.new"; fi
    truncate -s "$size" "$LUKS_FILE.new"
  )
  dev=$(losetup --find --show --direct-io=on "$LUKS_FILE.new")
  [ "$(losetup -n -O DIO "$dev" | tr -d ' ')" = 1 ] || die "the loop device $dev does not use direct I/O"
  # argon2id with a fixed 256 MiB, so that unlocking also works with 1 GB of RAM. A fixed pass
  # count skips cryptsetup's benchmark, which lowers the memory on a slow or busy host.
  # --force-password: the length rule above applies, not Fedora's dictionary check, which fails
  # outright when the optional dictionary package (cracklib-dicts) is not installed.
  printf '%s\n' "$PASSPHRASE" | cryptsetup luksFormat --batch-mode --force-password --type luks2 \
    --pbkdf argon2id --pbkdf-memory 262144 --pbkdf-parallel 1 --pbkdf-force-iterations 4 \
    --label kasten "$dev"
  # --persistent stores allow-discards in the header, so every later unlock passes discards on.
  printf '%s\n' "$PASSPHRASE" | cryptsetup open --allow-discards --persistent "$dev" "$KASTEN_DM_NAME"
  mkfs.ext4 -q -L kasten-data -m 0 "/dev/mapper/$KASTEN_DM_NAME"
  mount -t ext4 -o noatime,nodiscard "/dev/mapper/$KASTEN_DM_NAME" "$MNT"
  volume_dirs
  # A new file system has no SELinux labels. This labels it once; the containers' ":Z" mounts then
  # give data/ and cli/ their own levels. A later relabel would undo those, so it runs only here.
  if selinuxenabled 2>/dev/null; then restorecon -RF "$MNT"; fi
  mv "$LUKS_FILE.new" "$LUKS_FILE"
  trap - EXIT HUP INT TERM
  logger -t kasten-unlock -p daemon.notice -- "event=create result=ok device=$dev size=$size" || true
  log "the volume is unlocked and mounted at $MNT"
}

step_volume() {
  [ -d "$MNT" ] || mkdir -m 0755 "$MNT"
  if ! mountpoint -q "$MNT"; then
    [ -z "$(ls -A "$MNT")" ] || die "$MNT holds files although the volume is not mounted there. Move them away, then run install.sh again."
    # Nothing can write to the root file system under the mount point, even when it is unmounted.
    chattr +i "$MNT"
  fi
  if [ -e "$LUKS_FILE.new" ]; then
    die "a previous run stopped while it created the volume. Check that nothing uses $LUKS_FILE.new, delete it, then run install.sh again."
  fi
  if [ -e "$LUKS_FILE" ]; then
    cryptsetup isLuks "$LUKS_FILE" || die "$LUKS_FILE exists but is not a LUKS volume. install.sh never overwrites it."
    if mountpoint -q "$MNT"; then
      volume_dirs
      log "the encrypted volume exists and is mounted"
    else
      log "the encrypted volume exists and is locked"
    fi
    return 0
  fi
  create_volume
}

step_units() {
  for f in kasten-unlock kasten-unlock-passphrase kasten-unlock-event kasten-push kasten-bootstrap kasten-check kasten-residue-check kasten-podman kasten-mail-service kasten-mail-run kasten-mail-exec kasten-cli; do
    put "$HOST_DIR/$f" "/usr/local/sbin/$f" 0755
  done
  put "$HOST_DIR/bind-tang.sh" /usr/local/sbin/kasten-bind-tang 0755
  put "$HOST_DIR/podman.sh" /usr/local/lib/kasten/podman.sh 0644
  for u in "$HOST_DIR"/units/*; do
    put "$u" "/etc/systemd/system/${u##*/}" 0644
  done
  write_env
  systemctl daemon-reload
  # Both, also after the Fedora release upgrade, which disables them while the volume stays locked.
  systemctl enable kasten-unlock.service kasten.service
  # Personal deployment: check from the Mac, probe from apps (deploy/observer). Existing generic
  # check/probe timers are preserved, but a new mailbox install never enables them itself.
  systemctl enable --now kasten-backup.timer
}

render_nft() {
  v4=
  v6=
  for a in $KASTEN_ADMIN_IPS; do
    case $a in
      *:*) v6="${v6:+$v6, }$a" ;;
      *) v4="${v4:+$v4, }$a" ;;
    esac
  done
  e4=
  e6=
  [ -z "$v4" ] || e4="elements = { $v4 }"
  [ -z "$v6" ] || e6="elements = { $v6 }"
  sed -e "s|# kasten:admin_v4|$e4|" -e "s|# kasten:admin_v6|$e6|" "$HOST_DIR/nftables.conf"
}

# Refuse to load a firewall that would block the SSH session this script runs in.
ssh_guard() {
  [ -n "${SSH_CONNECTION:-}" ] || return 0
  ip=${SSH_CONNECTION%% *}
  ip=${ip#::ffff:}
  case $ip in
    *:*) set=v6 ;;
    *) set=v4 ;;
  esac
  v4="100.64.0.0/10${v4:+, $v4}"
  v6="fd7a:115c:a1e0::/48${v6:+, $v6}"
  nft -f - <<EOF
destroy table inet kasten_probe
table inet kasten_probe {
	set v4 { type ipv4_addr; flags interval; elements = { $v4 } }
	set v6 { type ipv6_addr; flags interval; elements = { $v6 } }
}
EOF
  allowed=false
  if nft get element inet kasten_probe "$set" "{ $ip }" >/dev/null 2>&1; then allowed=true; fi
  nft delete table inet kasten_probe
  $allowed || die "this SSH session comes from $ip, which the new firewall would block. Connect over Tailscale, or add $ip with --admin-ips."
}

step_firewall() {
  if [ -z "$KASTEN_ADMIN_IPS" ] && [ ! -e /sys/class/net/tailscale0 ]; then
    die "the firewall would leave no way to reach SSH. Join Tailscale first, or pass --admin-ips with the address you connect from. The earlier steps are done; run install.sh again."
  fi
  render_nft >/etc/sysconfig/nftables.conf.kasten-new
  nft -c -f /etc/sysconfig/nftables.conf.kasten-new || die "the rendered firewall does not load; check --admin-ips"
  ssh_guard
  chmod 0644 /etc/sysconfig/nftables.conf.kasten-new
  mv -f /etc/sysconfig/nftables.conf.kasten-new /etc/sysconfig/nftables.conf
  put "$HOST_DIR/conf/nftables-service.conf" /etc/systemd/system/nftables.service.d/kasten.conf 0644
  # firewalld (Fedora Server; not on the Cloud image) would load its own rules in place of these.
  if rpm -q --quiet firewalld; then
    systemctl disable --now firewalld.service
    systemctl mask -q firewalld.service
  fi
  systemctl daemon-reload
  systemctl enable nftables.service
  # A reload, not a restart: the drop-in's reload loads the file, which replaces only Kasten's
  # table, and systemd counts restarts against the unit's start limit (five in 10 s), so quick
  # runs of install.sh would fail here. An inactive unit is started.
  systemctl reload-or-restart nftables.service
  nft list table inet kasten >/dev/null
  log "firewall active: inbound TCP 25 and 443, Tailscale, and SSH from tailscale0${KASTEN_ADMIN_IPS:+ and $KASTEN_ADMIN_IPS}"
}

main() {
  [ "$(id -u)" -eq 0 ] || die "run install.sh as root"
  # shellcheck source=/dev/null
  . /etc/os-release
  [ "${ID:-}" = fedora ] || die "install.sh supports Fedora only"
  case " $SUPPORTED " in
    *" ${VERSION_ID:-} "*) ;;
    *) die "install.sh supports Fedora $SUPPORTED, not ${VERSION_ID:-this release}" ;;
  esac
  [ -d /run/systemd/system ] || die "systemd is not running"
  selinux_gate
  load_settings
  if want units; then public_url; fi
  if want volume && [ ! -e "$LUKS_FILE" ]; then read_passphrase; fi
  write_settings
  for s in $STEPS; do
    if want "$s"; then
      log "step $s"
      "step_$s"
    else
      log "step $s skipped"
    fi
  done
  unset PASSPHRASE
  log "done. Next steps: deploy/README.md"
}

main

# podman.sh: the one definition of Kasten's containers, as Podman arguments. install.sh installs
# it as /usr/local/lib/kasten/podman.sh. kasten-mail-service (for kasten.service), kasten-mail-run,
# kasten-cli and kasten-bootstrap source it, and run the containers through kasten-podman, which
# is rootless Podman as the kasten user.
#
# Nothing is written to the unencrypted root disk. Every container has a read-only root file
# system and is removed when it stops. The mail containers write only to /var/lib/kasten/data on
# the encrypted volume and to tmpfs in RAM; the CLI writes only to /var/lib/kasten/cli/state. Their
# logs go to journald, which keeps them in RAM (conf/journald.conf), and Podman keeps the
# containers' state in RAM too (conf/storage.conf).
#
# Rootless Podman maps container root to the kasten user, which owns the CLI's credentials.
# SELinux keeps the mail containers away from them: each class of container has a fixed MCS level,
# and ":Z" labels its directory with that level. With Podman's random levels, every one-shot
# container would relabel the directory for itself and cut the running server off its own data.
# kasten-podman refuses to create a container unless SELinux is enforcing.
# shellcheck shell=sh disable=SC2034 # the scripts that source this file use its variables

KASTEN_ENV_FILE=/opt/kasten/.env
MAIL_LEVEL=s0:c525,c526
CLI_LEVEL=s0:c600,c601

# The kasten-server image: the mail server, its recovery mode and its maintenance commands.
# - Stalwart's binary carries the file capability cap_net_bind_service, and exec fails unless that
#   capability stays in the bounding set. On the host network it grants nothing; conf/sysctl.conf
#   lets the kasten user bind ports from 25 up. no-new-privileges blocks every other gain.
# - The memory limit leaves about 200 MiB of a 1 GB host for the kernel, systemd, journald and
#   tailscaled. The 1 GB simulation peaked at about 540 MiB (a restore with Stalwart stopped).
# - --read-only-tmpfs=false: no writable /tmp, /var/tmp or /run beyond the mounts listed here.
# - /run/kasten, owned by the server's user (U), is its home: Unbound's working directory and its
#   generated include file.
# - The data directory on the encrypted volume. If the volume is not mounted, the directory does
#   not exist and Podman refuses to start the container.
MAIL_ARGS="--pull=never --read-only --read-only-tmpfs=false --cap-drop=all --cap-add=net_bind_service
  --security-opt=no-new-privileges --memory=768m --tmpfs=/run/kasten:rw,mode=0700,size=4m,U,notmpcopyup
  --security-opt=label=level:$MAIL_LEVEL --log-driver=journald
  --volume=/var/lib/kasten/data:/var/lib/kasten:Z"

# The kasten-cli image. Container root, without capabilities, is the kasten user on the host, the
# owner of the CLI's files. --init: as PID 1 the CLI's node process ignores SIGTERM, so a stopped
# unit or a lock would leave its container running and the volume busy.
CLI_ARGS="--pull=never --init --user=0:0 --read-only --read-only-tmpfs=false --cap-drop=all
  --security-opt=no-new-privileges --memory=384m --tmpfs=/tmp:rw,mode=1777,size=16m
  --security-opt=label=level:$CLI_LEVEL --log-driver=journald"

# The backup settings that kasten-mail-exec and kasten-mail-run pass into the mail container, by
# name only: Podman takes each value from its own environment, and skips a name that is not set.
# kasten-podman lets exactly these three through.
RESTIC_ENV="--env=RESTIC_REPOSITORY --env=RESTIC_PASSWORD_FILE --env=KASTEN_BACKUP_ENV_FILE"

# kasten_images: sets SERVER_IMAGE and CLI_IMAGE from KASTEN_VERSION in /opt/kasten/.env. The images
# are loaded locally (kasten-podman load), so Podman names them localhost/...; --pull=never keeps
# it from ever fetching an image with the same name from a registry.
kasten_images() {
  version=$(sed -n 's/^KASTEN_VERSION=//p' "$KASTEN_ENV_FILE" 2>/dev/null | tail -n 1)
  case $version in
    '' | *[!A-Za-z0-9_.-]*)
      printf '%s: set KASTEN_VERSION in %s to the tag of the loaded images\n' "${0##*/}" "$KASTEN_ENV_FILE" >&2
      return 1
      ;;
  esac
  SERVER_IMAGE=localhost/kasten-server:$version
  CLI_IMAGE=localhost/kasten-cli:$version
}

# tty_arg: sets TTY to -t when both standard input and standard output are terminals, so that pipes
# and units get plain output.
tty_arg() {
  TTY=
  if [ -t 0 ] && [ -t 1 ]; then TTY=-t; fi
}

# wait_healthy <container> <seconds>: succeeds once the container's health check passes. An exit or
# a failed health check ends the wait early. Podman runs the first check 30 s after the start: it
# ignores the image's shorter start interval.
wait_healthy() {
  timeout "$2" kasten-podman wait --condition=healthy --condition=unhealthy --condition=exited "$1" >/dev/null || true
  [ "$(kasten-podman inspect --format '{{.State.Health.Status}}' "$1")" = healthy ]
}

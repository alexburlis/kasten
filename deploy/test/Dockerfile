# Test image for deploy/test/run.sh: Debian 13 with systemd as PID 1, for the Tang host and the
# client (the VPS is Dockerfile.fedora). The changes below exist only because this is a container,
# not a VM; run.sh lists them.
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
ARG EXTRA=""
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv iproute2 procps e2fsprogs netcat-openbsd $EXTRA \
 && rm -rf /var/lib/apt/lists/*
# A container shares the VM's kernel: its own udev must not run, so device-mapper creates its
# device nodes itself (DM_DISABLE_UDEV), and loop nodes are created at boot (no devtmpfs).
# binfmt_misc is not namespaced either: in a privileged container, systemd-binfmt would clear
# the VM's handlers (Rosetta, for example) when it starts and stops, for every user of the VM.
RUN systemctl mask systemd-udevd.service systemd-udevd-control.socket systemd-udevd-kernel.socket \
      systemd-udev-trigger.service systemd-udev-settle.service console-getty.service getty.target \
      systemd-binfmt.service proc-sys-fs-binfmt_misc.automount proc-sys-fs-binfmt_misc.mount \
 && mkdir -p /etc/systemd/system.conf.d \
 && printf '[Manager]\nDefaultEnvironment=DM_DISABLE_UDEV=1\n' >/etc/systemd/system.conf.d/kasten-deploytest.conf
COPY standin/ /usr/local/lib/kasten-deploytest/
RUN install -m 0644 /usr/local/lib/kasten-deploytest/kasten-deploytest-devnodes.service /etc/systemd/system/ \
 && install -m 0644 /usr/local/lib/kasten-deploytest/tailscaled.service /etc/systemd/system/ \
 && systemctl enable kasten-deploytest-devnodes.service tailscaled.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

# kasten-server: unmodified Stalwart release with SQLite, a local Unbound resolver, restic and
# Kasten's sign-in page (signin/), which Stalwart serves under /signin/.
# Downloads and their SHA-256 pins are listed in PINS. The base image digest below must match
# the "debian" line in PINS.
# Build for one architecture: docker build --platform linux/amd64 (VPS) or linux/arm64 (Mac).

FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS fetch
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bzip2 zip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /fetch
COPY PINS ./
RUN <<'EOF'
set -eu
case "$TARGETARCH" in
  amd64 | arm64) ;;
  *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;;
esac
# fetch <name> <file>: download the PINS entry for this architecture and check its SHA-256.
fetch() {
  pin=$(awk -v n="$1" -v a="$TARGETARCH" \
    '$1 == n && ($3 == a || $3 == "all") { print $4, $5; c++ } END { exit c != 1 }' PINS)
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "${pin#* }"
  printf '%s  %s\n' "${pin%% *}" "$2" | sha256sum -c -
}
fetch stalwart stalwart.tar.gz
fetch restic restic.bz2
fetch spam-rules spam-filter-rules.json.gz
mkdir out unpacked
tar -xzf stalwart.tar.gz -C unpacked
test "$(find unpacked -type f -name stalwart | wc -l)" -eq 1
install -m 0755 "$(find unpacked -type f -name stalwart)" out/stalwart
bunzip2 -c restic.bz2 > out/restic
chmod 0755 out/restic
install -m 0644 spam-filter-rules.json.gz out/
EOF
COPY signin/ ./signin/
RUN sh signin/build.sh out/kasten-signin.zip

FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
# openssl arrives as a dependency of ca-certificates. libpython3.13 arrives as a hard dependency
# of Debian's unbound package; no Python interpreter is installed. The kasten user's home is
# /run/kasten, so nothing that writes to $HOME (such as an emulator's cache) touches the volume.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates sqlite3 unbound dns-root-data tini libcap2-bin \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 2525 kasten \
 && useradd --system --uid 2525 --gid kasten --home-dir /run/kasten --no-create-home \
      --shell /usr/sbin/nologin kasten
# Stalwart runs as kasten; its file capability is its only privilege (ports 25 and 443).
# Installing and setting the capability in one step keeps a single copy of the binary in the image.
RUN --mount=type=bind,from=fetch,source=/fetch/out,target=/mnt/fetch \
    install -m 0755 /mnt/fetch/stalwart /mnt/fetch/restic /usr/local/bin/ \
 && setcap cap_net_bind_service=+ep /usr/local/bin/stalwart \
 && install -D -m 0644 /mnt/fetch/spam-filter-rules.json.gz /opt/kasten/spam-filter-rules.json.gz \
 && install -m 0644 /mnt/fetch/kasten-signin.zip /opt/kasten/kasten-signin.zip \
 && install -d -o kasten -g kasten -m 0700 /var/lib/kasten /run/kasten \
 && install -o kasten -g kasten -m 0600 /dev/null /run/kasten/unbound-dev.conf
COPY PINS /opt/kasten/PINS
COPY etc/unbound.conf /etc/kasten/unbound.conf
COPY bin/kasten-server /usr/local/bin/kasten-server
RUN unbound-checkconf /etc/kasten/unbound.conf

USER kasten:kasten
WORKDIR /
RUN /usr/local/bin/kasten-server version
EXPOSE 25 143 443 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=5s --retries=3 \
  CMD ["/usr/local/bin/kasten-server", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kasten-server"]
CMD ["serve"]

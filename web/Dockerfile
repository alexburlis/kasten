# kasten-web: the web app as static files behind an unprivileged nginx.
# Build from the repository root:  docker build -f web/Dockerfile -t kasten-web .
# At start, kasten-web-start writes the response headers (CSP and others) and, unless a
# config.json is mounted, /config.json from the environment. See web/README.md.

# node:24-slim (Debian bookworm), multi-architecture index digest, read 3 November 2026.
FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build

ENV CI=true

WORKDIR /src

# pnpm comes from corepack, pinned by the packageManager field of package.json.
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY cli/package.json cli/package.json
COPY web/package.json web/package.json

RUN pnpm install --frozen-lockfile --filter "@kasten/web..."

COPY packages/core/src packages/core/src
COPY web/index.html web/vite.config.ts web/tsconfig.json web/
COPY web/public web/public
COPY web/scripts web/scripts
COPY web/src web/src

RUN pnpm --filter @kasten/web build

# nginx-unprivileged 1.30.6 (stable), alpine-slim, multi-architecture index digest, read 3 November 2026.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine-slim@sha256:5d8bb9437d74a600ec5dbf90c035451c724dc33eac8d3a71078f6f8612c345f6

# Alpine fixes that the pinned base does not have yet, read 8 November 2026: musl 1.2.6-r3
# (CVE-2026-107891) and zlib 1.3.2-r1 (CVE-2026-85091), both HIGH. Remove this when a newer base
# digest includes them.
USER root
RUN apk add --no-cache --upgrade 'musl>=1.2.6-r3' 'musl-utils>=1.2.6-r3' 'zlib>=1.3.2-r1'

COPY --from=build --chown=root:root /src/web/dist /usr/share/kasten-web
COPY --chown=root:root web/docker/nginx.conf /etc/nginx/nginx.conf
COPY --chown=root:root --chmod=0755 web/docker/kasten-web-start /usr/local/bin/kasten-web-start

# The image's unprivileged nginx user. The root filesystem can be read-only: everything nginx
# writes goes to /tmp, which must be writable (a tmpfs).
USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1

ENTRYPOINT ["/usr/local/bin/kasten-web-start"]

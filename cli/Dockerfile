# kasten-cli: the kasten command in a container.
# Build from the repository root:  docker build -f cli/Dockerfile -t kasten-cli .
# Run:  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/config:/config" kasten-cli setup --config /config/kasten.json
# Run it as your own user, as above, so the 0600 secret files in the mounted directory stay readable.

# node:24-slim (Debian bookworm), multi-architecture index digest, read 3 November 2026.
FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS deps

# The CLI runs @kasten/core, the app's own decrypt, MIME, JMAP and safety code. Its npm
# dependencies come from pnpm-lock.yaml with --frozen-lockfile, so every version is the pinned
# one. Corepack fetches the pnpm version that package.json names.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /opt/kasten
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY cli/package.json cli/package.json
RUN corepack enable pnpm \
  && pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@kasten/cli..." \
  && rm -rf /root/.cache /root/.local/share/pnpm

FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

ENV NODE_ENV=production

WORKDIR /opt/kasten

# The CLI runs TypeScript directly with Node's type stripping, so there is no build step.
COPY --from=deps --chown=root:root /opt/kasten/node_modules node_modules
COPY --from=deps --chown=root:root /opt/kasten/packages/core/node_modules packages/core/node_modules
COPY --from=deps --chown=root:root /opt/kasten/cli/node_modules cli/node_modules
COPY --chown=root:root packages/core/package.json packages/core/package.json
COPY --chown=root:root packages/core/src packages/core/src
COPY --chown=root:root cli/package.json cli/package.json
COPY --chown=root:root cli/bin cli/bin
COPY --chown=root:root cli/src cli/src

RUN chmod 0755 cli/bin/kasten \
  && ln -s /opt/kasten/cli/bin/kasten /usr/local/bin/kasten \
  && kasten version \
  && cd cli && node --input-type=module -e 'const m = await import("@kasten/core/safety"); if (!m.classifyStored) process.exit(1);'

# The image's built-in unprivileged user. Override it with --user to match your files' owner.
USER node
WORKDIR /work

ENTRYPOINT ["kasten"]
CMD ["help"]

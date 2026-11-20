# kasten-dev-gpg: GnuPG for the local dev stack and the integration tests. Development only.
# It makes the dev operator key and the tests' throwaway keys, lists the recipients of an
# encrypted message, and encrypts and decrypts. Files go in and out through a directory at /io.
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
RUN apt-get update \
 && apt-get install -y --no-install-recommends gpg gpg-agent \
 && rm -rf /var/lib/apt/lists/*
COPY kasten-dev-gpg /usr/local/bin/kasten-dev-gpg
ENV HOME=/tmp
WORKDIR /io
ENTRYPOINT ["/usr/local/bin/kasten-dev-gpg"]
CMD ["help"]

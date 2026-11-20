# kasten-clitest-imap-source: a pinned Dovecot IMAP server, the source mailbox for the
# import-imap integration test. Test only; nothing in the dev stack or production uses it.
# It listens on 143 (plain, with STARTTLS) and 993 (implicit TLS) with a self-signed certificate
# that the entrypoint makes on first start. The test writes the user list and the maildir.
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      dovecot-core=1:2.4.1+dfsg1-6+deb13u7 \
      dovecot-imapd=1:2.4.1+dfsg1-6+deb13u7 \
      openssl \
 && rm -rf /var/lib/apt/lists/* /etc/dovecot/conf.d /etc/dovecot/private \
 && useradd --system --uid 5000 --user-group --home-dir /srv/mail --no-create-home vmail \
 && install -d -o vmail -g vmail -m 0700 /srv/mail \
 && install -d -m 0700 /etc/dovecot/tls
COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
EXPOSE 143 993
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

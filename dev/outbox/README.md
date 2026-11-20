# Outbox: the local stand-in for Amazon SES

In the local stack, Stalwart sends all outgoing mail to the `outbox` service instead of SES. The outbox is [Mailpit](https://mailpit.axllent.org) v1.33.0, pinned by digest in [`compose.yaml`](../../compose.yaml). It keeps every message and shows it at <http://localhost:7482>. It sends on only the probe account's mail: `dev/stack/compose.dev.yaml` makes it relay every message for `probe@kasten.test` back to Stalwart's inbound SMTP on `mail:25`, as SES and the public MX would ([the outbox relay](../README.md#the-outbox-relay)). Nothing leaves the stack.

The outbox enforces what SES enforces on port 587:

| Rule                        | How                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| STARTTLS is required        | Mailpit answers `530 5.7.0 Must issue a STARTTLS command first` to mail sent without it  |
| SMTP AUTH is required       | Mailpit answers `530 5.7.0 Authentication required` to mail sent without a login         |
| The certificate is real     | The certificate for the host name `outbox` is signed by a local development CA           |
| Only the stack can reach it | Port 587 is open only on the compose network; only the web UI is published, on 127.0.0.1 |

The `mail` container trusts the development CA through `KASTEN_EXTRA_CA_FILE` only. Stalwart's relay route keeps full certificate checks; it never uses `allowInvalidCerts`.

## Creating the CA, the certificate and the login

```sh
dev/outbox/make-dev-ca.sh
```

The script needs only Docker: openssl runs in a pinned Alpine container. It writes these files to `.kasten-dev/outbox/` (or `$KASTEN_DEV_DIR/outbox/`):

| File             | Mode | Contents                                                                                          |
| ---------------- | ---- | ------------------------------------------------------------------------------------------------- |
| `ca.crt`         | 0644 | The development CA certificate (public)                                                           |
| `outbox.crt`     | 0644 | The outbox certificate for `DNS:outbox`, valid for 825 days                                       |
| `outbox.key`     | 0600 | Its private key                                                                                   |
| `smtp-login`     | 0600 | `kasten-dev:<password>`, the login that Stalwart's relay route uses                               |
| `smtp-auth`      | 0600 | The same login for Mailpit, with the password as a SHA-512 crypt hash                             |
| `outbox.expires` | 0644 | One hour before the certificate expires, in seconds since 1970. The 30-day renewal check reads it |

`./kasten dev up` also writes `relay.yaml` into the same directory: Mailpit's relay settings for the probe's mail.

The script is idempotent. It does nothing while every file exists and the certificate has more than 30 days left. Otherwise it creates a new CA and certificate and keeps an existing login. The CA's private key never leaves the container, so nobody can sign another certificate with it.

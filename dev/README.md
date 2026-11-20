# The local dev stack

`./kasten dev up` runs Kasten on your machine with Docker Compose: the real `kasten-server` image (Stalwart, Unbound), the web app, a local stand-in for Amazon SES, and the `kasten` CLI. Every port binds `127.0.0.1` only. Nothing in the stack sends mail to the internet.

You need Docker with Compose v2. If `docker compose version` fails, install Compose (for example `brew install docker-compose`), or set `KASTEN_COMPOSE` to the path of a Compose v2 binary. `DOCKER_CONTEXT` chooses the Docker engine, as usual. `KASTEN_DEV_DIR` moves `.kasten-dev/` to another directory.

## Commands

| Command                    | Does                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./kasten dev up`          | Builds the images and starts the stack. On the first run it also sets the server up (below) and prints the dev login once. Later runs start the stack and set it up again                                                                                                                                                                                                                                                   |
| `./kasten dev serve`       | `dev up`, then follows the logs of `web` and `mail` in the foreground. Ctrl-C or SIGTERM runs `dev down`, which keeps the data, and exits 0. Preview managers use it to start and stop the stack. It needs Node.js 24: the web container publishes on port 17480 instead (`dev/stack/compose.serve.yaml`), and `dev/serve/forward.ts` forwards port 7480 to it, so the process that started `dev serve` owns the app's port |
| `./kasten dev down`        | Stops and removes the containers. The mailbox volume and `.kasten-dev/` stay                                                                                                                                                                                                                                                                                                                                                |
| `./kasten dev reset`       | Deletes the mailbox volume and `.kasten-dev/`, after you type `reset`. `--yes` skips the question. Images stay                                                                                                                                                                                                                                                                                                              |
| `./kasten dev status`      | Shows the containers, their health, whether setup is done, and the local addresses. Exits 0 only when `mail` is healthy                                                                                                                                                                                                                                                                                                     |
| `./kasten dev logs [args]` | `docker compose logs` for the stack, for example `./kasten dev logs -f mail`                                                                                                                                                                                                                                                                                                                                                |
| `./kasten dev mail`        | Delivers six test messages to `you@kasten.test` over SMTP, then checks over JMAP that each one is in the Inbox                                                                                                                                                                                                                                                                                                              |
| `./kasten <command>`       | Runs the `kasten` CLI image against the stack, for example `./kasten setup`, `./kasten dns` or `./kasten help`                                                                                                                                                                                                                                                                                                              |

For these CLI commands, the wrapper adds `--config /kasten-dev/kasten.json` unless you give one: `setup`, `config`, `dns`, `user`, `domain`, `keys`, `lock`, `reader`, `app-password`, `check`, `security-check`, `read`, `probe` and `import-imap`.

The CLI container sees `.kasten-dev/` read-only at `/kasten-dev`, which is also its working directory, so relative file names refer to files there. Only `/kasten-dev/state` and `/kasten-dev/out` are writable: write output files to `/kasten-dev/out`, for example `--out /kasten-dev/out/import-app-password`. The container runs as your user, so it can read the 0600 files. `./kasten security-check` runs from a container on the stack's default network instead, as the internet would reach the server, and adds `--url http://mail:8080` unless you give one.

## Addresses

| Address                 | Service                                                        |
| ----------------------- | -------------------------------------------------------------- |
| <http://localhost:7480> | `web`: the app                                                 |
| <http://localhost:7481> | `mail`: JMAP, OAuth sign-in and the admin API, over plain HTTP |
| `localhost:7425`        | `mail`: inbound SMTP, as port 25 would be                      |
| `localhost:7414`        | `mail`: IMAP, for `import-imap` only                           |
| <http://localhost:7482> | `outbox`: the SES stand-in's web UI and API (`/api/v1`)        |

Stalwart's public URL is `http://localhost:7481` (`STALWART_PUBLIC_URL`): the OAuth issuer and every URL in the JMAP session start with it.

## What `dev up` does on the first run

1. `dev/outbox/make-dev-ca.sh` creates the dev CA, the outbox certificate and the outbox SMTP login. The wrapper copies the login into `outbox-smtp-username` and `outbox-smtp-password`, and writes `outbox/relay.yaml` ([the outbox relay](#the-outbox-relay)).
2. It builds four images: `kasten-server:dev`, `kasten-cli:dev`, `kasten-dev-gpg:dev` and `kasten-web:dev`.
3. It creates random passwords for `you@kasten.test`, `sam@kasten.test` and the probe account `probe@kasten.test`.
4. It creates the dev operator key with GnuPG in the `gpg` container: OpenPGP v4, an Ed25519 primary key and a Cv25519 encryption subkey, no expiry, protected by a random passphrase.
5. It writes `.kasten-dev/kasten.json` and the web app's runtime config.
6. `kasten-server init` creates the mailbox volume; its id goes into `.kasten-dev/mail.env`.
7. The first boot runs offline. Stalwart starts in recovery mode in a container without a network (`docker run --network none`). The CLI joins that container's network namespace and runs `kasten setup --bootstrap` against `127.0.0.1:8080`. Setup creates the domain `kasten.test`, the three accounts, the OAuth client `kasten-web` and the IP-restricted admin API key. It stores the web admin UI, ASN/GeoIP and the spam rules' four remote lists as disabled. Then the wrapper stops recovery mode and saves its log as `first-boot-recovery.log`.
8. It starts the stack normally and runs `kasten setup` with the admin key. If setup asks for a restart, it restarts Stalwart and runs setup once more. Setup keeps a due restart in `state/setup-restart.json`, so a failed run cannot lose it.
9. It runs `dev/stack/dev-settings.ts`, which makes mail from the tools network skip the spam filter. Compose applies the other [development-only settings](#development-only-settings) when it starts the containers.
10. It writes `.kasten-dev/state.json` and prints the login for `you@kasten.test`.

Without a network in step 7, Stalwart's very first start cannot fetch its web admin UI, and with those settings stored as disabled, the first normal start downloads nothing either ([Stalwart notes, section 13](../docs/stalwart-v1.0.1.md#13-first-boot-without-downloads)).

Later runs repeat steps 1, 2 and 5, check that the volume matches `mail.env`, skip the first boot, and then repeat steps 8 to 10. In step 10 they print only the path of `you-password`, not the password. On an unchanged stack, setup reports `0 changed`.

## Networks and the admin API key

| Network                       | Subnet          | Who is on it                                                                                             |
| ----------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `kasten-dev_default`          | `10.74.80.0/24` | `mail`, `outbox`, `web`, the published ports, and the container of `./kasten security-check`             |
| `kasten-dev_admin` (internal) | `10.74.81.0/28` | `mail` and the `cli` containers that `./kasten` runs: CLI commands, `dev mail` and the dev-only settings |

The admin API key allows `10.74.81.0/28` and `10.74.80.1`. Requests to `127.0.0.1:7481` from your machine arrive from `10.74.80.1`, the default network's gateway; in dev, that path plays the part of the production SSH tunnel. A container on the default network has neither address, so Stalwart refuses the key there (HTTP 403). The subnets are fixed because the key's allowed addresses are. If they clash with a network on your machine, change the subnets in `compose.yaml`, and `TOOLS_NETWORK` and `HOST_GATEWAY` in `kasten` to match. To change only the second octet, change both `74`s in `kasten`: the default of `NET` and the isolated-stack check. Then run `./kasten dev reset`.

## Development-only settings

Production uses none of these.

| Setting                                                 | Set by                       | Why                                                                                                                                                      |
| ------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KASTEN_EXTRA_CA_FILE`                                  | `compose.yaml`               | The mail server trusts the dev CA, so the relay to `outbox` passes strict certificate checks                                                             |
| `KASTEN_DEV_DNS_FORWARD`                                | `compose.yaml`               | Unbound forwards `outbox` and every other name to Docker's DNS without DNSSEC, because many networks block direct DNS                                    |
| `x:MtaStageData.enableSpamFilter` skips `10.74.81.0/28` | `dev/stack/dev-settings.ts`  | `dev mail` sends from `.test` addresses that have no DNS, so the spam filter would put every message in Junk. Mail to `localhost:7425` is still filtered |
| The outbox relays the probe's mail to `mail:25`         | `dev/stack/compose.dev.yaml` | `kasten probe` can follow its message out through the SES stand-in and back in, as through SES and the public MX ([below](#the-outbox-relay))            |

Certificate checks are never weakened: the relay route keeps `allowInvalidCerts: false` and requires STARTTLS.

The log output is not a dev setting. `kasten setup` configures Stalwart's stdout tracer at `info` in dev and in production, so `./kasten dev logs mail` shows Stalwart's log ([Stalwart notes, section 14](../docs/stalwart-v1.0.1.md#14-logging)).

## The outbox relay

The outbox is Mailpit ([its README](outbox/README.md)). `./kasten` always runs Compose with `compose.yaml` plus `dev/stack/compose.dev.yaml`. That overlay makes Mailpit relay every message for exactly `probe@kasten.test` to Stalwart's inbound SMTP on `mail:25`, with the settings in `.kasten-dev/outbox/relay.yaml`. Every other message stays in the outbox.

- **The host name.** Mailpit greets with its host name, and Stalwart refuses an EHLO that is not a domain name, such as a container id. So the overlay gives the outbox the host name `outbox.example.test`.
- **The relay host.** Stalwart's relay route names the outbox by its single-label service name, `outbox`, which Unbound forwards to Docker's DNS. A `.test` name would not work as the relay host: Unbound's built-in `test.` zone answers every `.test` name with NXDOMAIN, even when it forwards every other name.
- **What reaches Stalwart.** The relayed copy arrives unauthenticated from the outbox's address, so the spam filter scores it, and it has no SPF or DKIM. Mail other than the probe's never comes back.

## `./kasten dev mail`

It sends from the internal tools network to `mail:25`, waits 250 ms between messages (Kasten accepts at most five connections per second from one address), and checks placement as `you@kasten.test`. Every run uses new Message-IDs.

| Message                                                                        | Tests                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------ |
| A three-message thread with `In-Reply-To`/`References`                         | Threads and conversation view                    |
| A PNG and a UTF-8 text file as attachments                                     | Attachments and downloads                        |
| A non-ASCII subject and sender name (RFC 2047)                                 | Header decoding: German, Japanese, an emoji      |
| An HTML newsletter with remote images and a tracking pixel at `*.example.test` | Remote content blocking. The names never resolve |

It waits and tries again in two cases:

- **SMTP.** A temporary refusal before the message data, such as the limit of five connections per second, gets up to six tries, 1, 2, 3, 4 and 5 seconds apart.
- **JMAP.** Stalwart limits each account's request rate, and the web app signed in as `you@kasten.test` shares that budget. When a JMAP request of the Inbox check gets HTTP 429, `dev mail` prints `waiting` and tries again after 1, 2, 4, 8, 16, 32 and 32 seconds.

The Inbox check looks once a second, for up to 30 seconds. Kasten's sender-to-recipient throttle allows 100 messages an hour from one address and sender domain to one recipient, so many runs within an hour get `452 4.4.5 Rate limit exceeded`. Wait for the hour to pass.

Create your key in the app before you run it: mail that arrives before the key is set stays unencrypted on the server. If you have enrolled MFA, the Inbox check is skipped, because the dev password alone no longer signs in.

## `.kasten-dev/`

`./kasten dev up` writes this directory (mode 0700, git-ignored). `./kasten dev reset` deletes it, and refuses to delete a directory without the `.kasten-dev` marker file. Secrets are in files with mode 0600 and never in `state.json`.

| Path                                           | Mode | Contents                                                                                                                                                                                    |
| ---------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.kasten-dev`                                  | 0600 | Marker: this directory belongs to the dev stack                                                                                                                                             |
| `state.json`                                   | 0644 | Machine-readable state for tests and other tools (below)                                                                                                                                    |
| `kasten.json`                                  | 0600 | The CLI config for the dev stack. Its relative paths point into this directory                                                                                                              |
| `mail.env`                                     | 0600 | `KASTEN_VOLUME_ID=<volume id>`, read by Compose for the `mail` service                                                                                                                      |
| `.bootstrapped`                                | 0600 | Empty; present once `kasten setup --bootstrap` succeeded                                                                                                                                    |
| `first-boot-recovery.log`                      | 0600 | The log of the offline recovery run of the first boot                                                                                                                                       |
| `admin-api-key`                                | 0600 | The admin API key, `API_...`                                                                                                                                                                |
| `you-password`, `sam-password`                 | 0600 | The dev accounts' passwords                                                                                                                                                                 |
| `probe-password`                               | 0600 | The password of the probe account `probe@kasten.test` (`probe` in `kasten.json`)                                                                                                            |
| `outbox-smtp-username`, `outbox-smtp-password` | 0600 | The relay login, split from `outbox/smtp-login` for `kasten.json`                                                                                                                           |
| `operator/pub.asc`                             | 0644 | The dev operator public key (armored)                                                                                                                                                       |
| `operator/sec.asc`                             | 0600 | The dev operator secret key (armored, protected by the passphrase)                                                                                                                          |
| `operator/passphrase`                          | 0600 | Its passphrase                                                                                                                                                                              |
| `operator/uid`                                 | 0600 | The key's user id, `Kasten dev operator <operator@kasten.test>`                                                                                                                             |
| `operator/key.info`                            | 0644 | `key <fingerprint> version 4 algo 22 expires never` and `encsub <key id> ...`                                                                                                               |
| `web/config.json`                              | 0644 | The web app's `/config.json`: `apiUrl`, `oauthClientId`, `operatorKeys`, `appName`                                                                                                          |
| `outbox/`                                      |      | From `dev/outbox/make-dev-ca.sh`; see [its README](outbox/README.md)                                                                                                                        |
| `outbox/relay.yaml`                            | 0644 | Mailpit's relay settings for the probe's mail: `mail`, port 25, no TLS, no login, Message-IDs kept                                                                                          |
| `state/`                                       | 0700 | The CLI's state directory (`stateDir`): lock pins, reader credentials, check and probe state, and setup's due restart (`setup-restart.json`) and due lock (`setup-lock-due.json`). Writable |
| `out/`                                         | 0700 | Output of CLI commands, such as attachments from `read get --out /kasten-dev/out`. Writable                                                                                                 |
| `tmp/`                                         | 0700 | Short-lived files of the integration tests; each test removes its own                                                                                                                       |

### `state.json`

Paths are absolute. Values that are not paths or addresses are not secret.

| Field                                   | What it holds                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                               | `1`                                                                                                                                                                             |
| `repoDir`, `devDir`                     | The repository and its `.kasten-dev` directory                                                                                                                                  |
| `composeProject`                        | `kasten-dev`                                                                                                                                                                    |
| `apiUrl`                                | `http://localhost:7481`                                                                                                                                                         |
| `webOrigin`                             | `http://localhost:7480`                                                                                                                                                         |
| `domain`                                | `kasten.test`                                                                                                                                                                   |
| `oauth`                                 | `issuer`, `clientId`, `redirectUri` and `scope` of the dev OAuth client                                                                                                         |
| `users.you`, `users.sam`, `users.probe` | `email`, `aliases`, and `passwordFile`: the path of `you-password`, `sam-password` or `probe-password` in the dev directory                                                     |
| `stateDir`                              | `state/` in the dev directory: lock pins, reader credentials, check state and setup's due restart (`setup-restart.json`) and due lock (`setup-lock-due.json`)                   |
| `admin`                                 | `account`, `apiKeyFile` (the path of `admin-api-key`), `hostUrl`, `cliUrl` (the URL the CLI container uses) and `allowedIps` (the tools network and the host gateway)           |
| `operatorKey`                           | `publicKeyFile`, `privateKeyFile` and `passphraseFile` (the paths of `operator/pub.asc`, `operator/sec.asc` and `operator/passphrase`), `fingerprint` and `encryptionSubkeyIds` |
| `smtp`, `imap`                          | `127.0.0.1` with ports 7425 and 7414                                                                                                                                            |
| `outbox`                                | `url` (`http://localhost:7482`), `apiUrl` (its `/api/v1`) and `smtpLoginFile` (the path of `outbox/smtp-login`)                                                                 |
| `kastenConfigFile`, `webConfigFile`     | The paths of `kasten.json` and `web/config.json` in the dev directory                                                                                                           |
| `webConfig`                             | The web app's runtime config: `apiUrl`, `oauthClientId`, `operatorKeys` and `appName`                                                                                           |
| `docker`                                | `context`, `mailContainer`, `volume`, `volumeId`, `networks` and `images` (the `mail`, `cli` and `gpg` images)                                                                  |

The file holds paths of credential files, never the secrets themselves.

## A second, isolated stack

Tests that must not touch the shared stack start a second one. They set all four of these variables. The wrapper refuses a partial set of the first three, but it does not check `KASTEN_DEV_DIR`: without it, the second stack uses the shared `.kasten-dev/` and overwrites its `kasten.json` and `web/config.json`.

| Variable               | Meaning                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| `KASTEN_DEV_PROJECT`   | Another Compose project name, which is also the stack's image tag               |
| `KASTEN_DEV_PORT_BASE` | The first of five ports: web, mail API, SMTP, IMAP and the outbox UI            |
| `KASTEN_DEV_NET`       | The second octet of its subnets (`10.<n>.80.0/24` and `10.<n>.81.0/28`), not 74 |
| `KASTEN_DEV_DIR`       | Its own dev directory                                                           |

The wrapper then adds `dev/stack/compose.isolated.yaml`. An isolated stack has no web app. `tests/integration/cli-probe.test.ts` uses one, `kasten-clitest` on ports 7600 to 7604, and deletes it again.

## The `gpg` tool image

`dev/gpg/` builds `kasten-dev-gpg:dev`: GnuPG from Debian 13, with no network. Its commands read and write files in a directory mounted at `/io`; `kasten-dev-gpg help` lists them. `dev up` uses it for the operator key, and the integration tests use it to make throwaway keys, list a message's recipients (PKESK key ids), and encrypt and decrypt.

## Tests

`pnpm test:integration` runs [`tests/integration/`](../tests/integration/README.md) against the running stack. It fails, with the reason, when the stack is not up.

`pnpm test:walkthrough` follows the README's "Try it locally" in a real browser ([`tests/walkthrough/`](../tests/walkthrough/README.md)). It starts with `./kasten dev reset --yes`, so it deletes the dev stack's data.

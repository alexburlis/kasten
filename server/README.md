# kasten-server image

The `kasten-server` image runs Kasten's mail server: an unmodified Stalwart release with SQLite, a local Unbound resolver, restic for backups, and Kasten's sign-in page ([`signin/`](signin/README.md)), which Stalwart serves at `/signin/`. One entrypoint, `kasten-server`, starts the server and runs the maintenance commands.

## What is inside

| Component           | Version                       | Source and pin                                                                                              |
| ------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Stalwart            | 1.0.1                         | Official release tarball per architecture, SHA-256 in [`PINS`](PINS)                                        |
| Stalwart spam rules | 3.0.3                         | Release file `spam-filter-rules.json.gz`, SHA-256 in `PINS`                                                 |
| restic              | 0.19.1                        | Official release binary per architecture, SHA-256 in `PINS`                                                 |
| Base image          | Debian 13 (`trixie-slim`)     | Pinned by digest in the `Dockerfile` and `PINS`                                                             |
| Debian packages     | From the pinned base's mirror | `ca-certificates` (brings `openssl`), `sqlite3`, `unbound`, `dns-root-data`, `tini`, `libcap2-bin`          |
| Kasten sign-in page | This repository               | `signin/`, packed by `signin/build.sh` into `/opt/kasten/kasten-signin.zip`; the build stage installs `zip` |

- The `Dockerfile` reads every download URL and SHA-256 from `PINS`. A pin changes only there; the base image digest also appears in the two `FROM` lines.
- No compiler and no Python interpreter is installed. Debian's `unbound` package depends on the `libpython3.13` library, so that library is present.
- One image tag builds for one architecture. Use `--platform linux/amd64` for the VPS and `--platform linux/arm64` for an Apple-silicon Mac. On an Apple-silicon Mac, build the amd64 image with Docker's Rosetta emulation: under QEMU emulation the Stalwart binary crashed, and the build runs it once (`kasten-server version`). That crash was observed on 3 November 2026.

```sh
docker build --platform linux/amd64 -t kasten-server server/
docker run --rm kasten-server version
```

### Checking the upstream signatures

Do this for every new pin. On 3 November 2026, both checks below passed for the pins in `PINS`.

**Stalwart** publishes a Sigstore bundle next to each tarball. Verify it with cosign. Cosign also runs from its official container image.

```sh
v=1.0.1; t=x86_64-unknown-linux-gnu   # or aarch64-unknown-linux-gnu
base=https://github.com/stalwartlabs/stalwart/releases/download/v$v
curl -fLO "$base/stalwart-$t.tar.gz" -fLO "$base/stalwart-$t.tar.gz.sigstore.json"
cosign verify-blob --bundle "stalwart-$t.tar.gz.sigstore.json" \
  --certificate-identity "https://github.com/stalwartlabs/stalwart/.github/workflows/ci.yml@refs/tags/v$v" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com "stalwart-$t.tar.gz"
sha256sum "stalwart-$t.tar.gz"   # must equal the PINS entry
```

Expected output: `Verified OK`. The check on 3 November 2026 used cosign v3.1.4 (`ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d`). The same bundle with a different tag in the identity failed, as it should.

**restic** publishes no Sigstore material. It signs `SHA256SUMS` with the PGP key `CF8F 18F2 8445 7597 3F79 D4E1 91A6 868B D3F7 A907` (Alexander Neumann), as its installation guide states.

```sh
base=https://github.com/restic/restic/releases/download/v0.19.1
curl -fLO "$base/SHA256SUMS" -fLO "$base/SHA256SUMS.asc"
curl -fsSL https://restic.net/gpg-key-alex.asc | gpg --import
gpg --verify SHA256SUMS.asc SHA256SUMS   # must name the fingerprint above
grep linux_ SHA256SUMS                    # must contain the PINS entries
```

The spam rules release has no signature. Its pin is the SHA-256 of the reviewed file.

## The data volume

Mount one volume at `/var/lib/kasten`. In production it is a directory on the LUKS-encrypted disk. The server runs as the image's user and group `kasten`, ID **2525**, so inside the container that directory must belong to 2525:2525. On the VPS, rootless Podman maps the image's uid 2525 to the host uid `KASTEN_MAIL_UID` in `/etc/kasten/host.env`, which `install.sh` sets. So on the host, `/var/lib/kasten/data` and every file in it belong to `KASTEN_MAIL_UID`. Add a file there as that uid, which gives it that owner and keeps the directory's SELinux label: `. /etc/kasten/host.env; setpriv --reuid="$KASTEN_MAIL_UID" --regid="$KASTEN_MAIL_UID" --clear-groups sh -c 'umask 077 && cat >/var/lib/kasten/data/<file>'`, with the content on standard input. Root itself would follow a link that the server left there ([operations](../docs/operations.md#how-to-run-the-commands-on-this-page)). That uid is not the host user `kasten` (uid 2600), which runs Podman.

| Path                                        | Written by        | Contents                                                                                       |
| ------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `.kasten-volume`                            | `init`            | Marker: `volume-id=<32 hex digits>` and the creation time                                      |
| `.kasten-lock`, `.kasten-backup-lock`       | `init`            | Lock files (see [Locks](#locks))                                                               |
| `stalwart/config.json`                      | `init`            | `{"@type":"Sqlite","path":"/var/lib/kasten/stalwart/stalwart.sqlite","poolMaxConnections":4}`  |
| `stalwart/stalwart.sqlite`                  | Stalwart          | All mail, settings and accounts                                                                |
| `stalwart/stalwart.sqlite.before-restore-*` | `restore`         | The database from before a restore, with its `-wal` and `-shm` files (see [Restore](#restore)) |
| `stalwart/spam-filter-rules.json.gz`        | `init`            | The pinned spam rules, loaded from `file:///var/lib/kasten/stalwart/spam-filter-rules.json.gz` |
| `stalwart/spam-filter-rules.json.gz.sha256` | `init`            | Their SHA-256, in `sha256sum -c` format                                                        |
| `secrets/` (mode 0700)                      | `init`, operators | `recovery-admin` (`admin:<password>`, mode 0600); other secret files you add                   |
| `restic-cache/`, `tmp/`                     | `init`            | restic's cache and every command's temporary files, so they stay on the encrypted disk         |

Every file is created with mode 0600 and every directory with mode 0700.

## Commands

`docker run kasten-server <command>` on a dev machine. On the VPS, `kasten-mail-run <command>` runs it in a new, temporary mail container, and `kasten-mail-exec <command>` runs it in the running mail container, `kasten-mail`. The image's default command is `serve`.

| Command                | Does                                                                                                                                                                                                                                      | Needs Stalwart stopped |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `init`                 | Prepares the volume. Idempotent. Prints one JSON line (below).                                                                                                                                                                            | No                     |
| `recovery`             | Runs Stalwart in recovery mode on `KASTEN_RECOVERY_PORT` (default 8080), with the recovery admin from `secrets/recovery-admin`. Only for first-boot configuration by `kasten setup --bootstrap`.                                          | Yes (takes the lock)   |
| `serve`                | Starts Unbound, then Stalwart. If either process exits, the container exits.                                                                                                                                                              | Takes the lock         |
| `backup-init`          | Creates the restic repository if it does not exist yet                                                                                                                                                                                    | No                     |
| `backup`               | Dumps the database into restic, then keeps 30 daily snapshots and prunes                                                                                                                                                                  | No                     |
| `restore <id\|latest>` | Rebuilds the database from a snapshot, checks it, and swaps it in                                                                                                                                                                         | Yes                    |
| `vacuum`               | Checkpoints the WAL, runs `VACUUM`, and checkpoints again                                                                                                                                                                                 | Yes                    |
| `health`               | Exits 0 if `GET /healthz/live` on `127.0.0.1:$KASTEN_HEALTH_PORT` (default 8080) answers 200. The image's `HEALTHCHECK` runs it.                                                                                                          | No                     |
| `version`              | Prints the versions of Stalwart, restic, SQLite and Unbound, and the pins. The spam rules appear only among the pins: Stalwart imports rules only at a new volume's first start, so the pin does not show the rules a running server uses | No                     |
| `help`                 | Lists the commands                                                                                                                                                                                                                        | No                     |

`init` prints:

```json
{
  "volumeId": "7ce1838d7c37bee9defb3d6aa1281947",
  "created": true,
  "config": "/var/lib/kasten/stalwart/config.json",
  "recoveryAdminFile": "/var/lib/kasten/secrets/recovery-admin",
  "spamRules": {
    "version": "3.0.3",
    "sha256": "43124c2e…",
    "url": "file:///var/lib/kasten/stalwart/spam-filter-rules.json.gz"
  }
}
```

Running `init` on an existing volume keeps its id, its `config.json` and its recovery admin. It replaces the spam rules only if the image pins a different file. Stalwart does not import a replaced file: it imports rules only at a new volume's first start.

### Exit codes

| Code | Meaning                                                                                   |
| ---- | ----------------------------------------------------------------------------------------- |
| 0    | Success                                                                                   |
| 1    | The command failed (for example: restic failed, or a restored database failed its checks) |
| 2    | Usage or configuration error (unknown command, missing `RESTIC_REPOSITORY`, run as root)  |
| 3    | Refused: the volume is missing, not initialised, or not the expected one (see below)      |
| 4    | Busy: Stalwart or another maintenance command holds a lock (see [Locks](#locks))          |
| 5    | `backup` only: the snapshot was saved, but applying retention failed                      |

When `serve` stops because Stalwart or Unbound exited, it exits with that process's status (1 if the status was 0).

### Locks

- `serve`, `recovery`, `restore` and `vacuum` hold `.kasten-lock`, so only one of them uses a volume at a time. Stalwart inherits the lock from `serve` and `recovery`.
- `backup`, `restore` and `vacuum` hold `.kasten-backup-lock`, so a backup never overlaps another backup, a restore or a vacuum.
- `backup` does not take `.kasten-lock`, so it runs while Stalwart runs. `backup-init` takes neither lock.
- A command that finds a lock held exits with code 4 at once.

## Fail-closed start

Stalwart creates an empty mailbox database when it finds no configuration. If the encrypted disk were not mounted, a server would then accept mail into an unencrypted, empty mailbox. `kasten-server` prevents this:

- `init` writes a random volume id into `.kasten-volume` and prints it. Put that id into the deployment as `KASTEN_VOLUME_ID`.
- Every command except `init`, `health` and `version` checks, before it touches anything, that the marker exists and its id equals `KASTEN_VOLUME_ID`. If not, it exits with code 3 and writes nothing.
- `init` refuses to create a new volume while `KASTEN_VOLUME_ID` is set, because a set id means an existing volume is expected. It also refuses a non-empty directory without a marker (`lost+found` is allowed).
- `serve` refuses to start if any `STALWART_RECOVERY_*` variable is set.

## Protected complete-store upgrade evidence

`kasten-server store-export <label>` uses Stalwart's native export while holding the exclusive volume lock. Stop Stalwart first. It refuses an existing label or traversal, runs for at most 1,800 seconds, and writes `/var/lib/kasten/upgrade/<label>/data`, `export.log` and a completed `manifest.sha256` inside the encrypted volume. Output directories use 0700; files use 0600. The native snapshot includes **all configuration plus mailbox data and metadata**; it is not a config-only export. Reserve space for two full copies.

Take `before-upgrade`, perform the reviewed upgrade, stop mail again and take `after-upgrade`. `kasten-server store-diff before-upgrade after-upgrade` prints filenames/hashes only. Exit 0 is identical;1 means changed files requiring private review; other nonzero results are errors/refusals. Mail changes can make comparison noisy; it never automatically approves configuration changes. This compares stored bytes, mail included, so it cannot show a changed built-in default of a setting that is not stored. The configuration comparison is `kasten config export` ([operations](../docs/operations.md#complete-configuration-and-residue-evidence)). No native subspace is omitted or hand-decoded. Keep raw data/logs private inside LUKS, retain the small protected review evidence, and remove only the exact task-created exports after consumers finish.

The host tool `kasten-residue-check <synthetic-canary-file>` checks for that marker outside LUKS after a synthetic receive/send/delete workload. It requires the actual encrypted mount and no disk swap before excluding encrypted storage. Plaintext residue inside LUKS is an acknowledged limit; encrypted-Sent and recipient-key checks are separate. See [operations](../docs/operations.md#complete-configuration-and-residue-evidence) and the [local native-export test](test/store-export.sh).

## Runtime environment

| Variable                 | Used by                                 | Meaning                                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KASTEN_VOLUME_ID`       | all commands but `health` and `version` | Required by all of them except `init`: the id that `init` printed for this volume. `init` refuses to create a new volume while it is set, and refuses a volume with a different id.                                                                                      |
| `STALWART_PUBLIC_URL`    | Stalwart, in `serve`                    | The mail API's URL: `https://<mailApiHostname>` in production, `http://localhost:7481` in the local stack. Stalwart uses it as the OAuth issuer and as the base of every JMAP session URL. Without it, Stalwart uses `https://` and its host name, which is the MX name. |
| `KASTEN_RECOVERY_PORT`   | `recovery`                              | HTTP port of the recovery listener (default 8080). Stalwart binds `[::]` on it.                                                                                                                                                                                          |
| `KASTEN_HEALTH_PORT`     | `health`                                | Plain-HTTP port on 127.0.0.1 inside the container (default 8080). The configuration must keep such a listener.                                                                                                                                                           |
| `RESTIC_REPOSITORY`      | backup commands                         | Any restic repository URL                                                                                                                                                                                                                                                |
| `RESTIC_PASSWORD_FILE`   | backup commands                         | Path of a file holding the repository password. `RESTIC_PASSWORD` is refused, so the password never sits in the container's environment.                                                                                                                                 |
| `KASTEN_BACKUP_ENV_FILE` | backup commands                         | Optional path of a file with backend credentials as `NAME=value` lines, for example `B2_ACCOUNT_ID` and `B2_ACCOUNT_KEY`. Only names starting with `B2_`, `AWS_`, `AZURE_`, `GOOGLE_`, `OS_`, `ST_` or `RCLONE_` are accepted. They are exported to restic only.         |
| `KASTEN_EXTRA_CA_FILE`   | `serve`                                 | **Development only.** See below.                                                                                                                                                                                                                                         |
| `KASTEN_DEV_DNS_FORWARD` | `serve`                                 | **Development only.** See below.                                                                                                                                                                                                                                         |

Other `STALWART_*` variables, such as `STALWART_HOSTNAME`, pass through to Stalwart.

## Privileges

- Every process runs as `kasten` (2525). The image refuses to run its commands as root.
- The Stalwart binary carries one file capability, `cap_net_bind_service`, so it can bind ports 25 and 443. No other process has a capability.
- Run the container with `--cap-drop ALL --cap-add NET_BIND_SERVICE`. Do not set `no-new-privileges`: it makes the kernel ignore the file capability. `server/test/verify.sh` shows both: with the kernel's default port rule, Stalwart binds port 443 with `NET_BIND_SERVICE` alone; without it, the binary cannot start (`Operation not permitted`); under `no-new-privileges`, the bind fails and Stalwart keeps running without that listener, so the health check fails.
- On the VPS, rootless Podman runs it differently. There the capability grants nothing on the host network, so `install.sh` lets unprivileged processes bind ports from 25 up (`/etc/sysctl.d/50-kasten.conf`), and the container also gets `no-new-privileges`. `NET_BIND_SERVICE` stays in the container's capabilities even so, because without it the binary cannot start.
- The `kasten` user's home is `/run/kasten`, outside the data volume, so nothing that writes to `$HOME` adds files to the volume.

## DNS: the local Unbound resolver

`serve` starts Unbound on `127.0.0.1:5335` before Stalwart. It resolves recursively from the root servers, validates DNSSEC with the root key from Debian's `dns-root-data`, and keeps small caches. The configuration is [`etc/unbound.conf`](etc/unbound.conf).

- Stalwart must use it. `kasten setup` sets `x:DnsResolver` to `Custom` with the server `127.0.0.1` port `5335` over UDP, and turns on `tcpOnError`, so Stalwart retries a failed UDP query over TCP.
- DNSBL answers in `127.255.255.0/24` are refusals, not listings (Spamhaus answers `127.255.255.254` to public resolvers and `127.255.255.255` over its query limit). Unbound drops them (`private-address: 127.255.255.0/24` in `etc/unbound.conf`), so Stalwart sees no listing; several pinned spam rules would otherwise count any answer as a listing. A refused list then never tags mail, so check the server's DNS path if spam scores drop.
- The server needs outgoing UDP and TCP port 53 to any address. Some networks block it; then every public lookup fails. On the network where Kasten was developed, on 3 November 2026, neither the computer nor its Docker VM could reach a root server on port 53, and one inbound test message took 136 seconds while Stalwart's lookups timed out. That is why the local stack forwards all names (see below).

## Backups

`backup` streams `sqlite3 .dump` into `restic backup --stdin-from-command`. restic saves no snapshot if the dump fails. Snapshots have host `kasten`, tag `kasten-sqlite` and the single file `/stalwart.sql`. Retention keeps 30 daily snapshots of that host and tag and prunes the rest.

The dump is plain SQL with two additions, both read in the same transaction as the data:

1. A first line, `PRAGMA page_size = <size>;`, so the restored database keeps Stalwart's page size.
2. A trailer that recreates each table's row count in a `TEMP` table with a `CHECK` constraint. Restoring the dump with any `sqlite3` therefore fails if a table's restored row count differs from the backed-up one. The trailer creates nothing in the restored database file.

`backup` can run while Stalwart runs. SQLite's WAL mode gives the dump a consistent snapshot.

### Restore

1. Stop Stalwart: `systemctl stop kasten.service` on the VPS, or `docker compose stop mail` in the local dev stack.
2. Run `kasten-server restore latest`, or give a snapshot id (8 to 64 hexadecimal characters).

On the VPS, use the commands in [the deploy guide's Backups section](../deploy/README.md#backups).

`restore` takes the volume lock, so it refuses while Stalwart runs against the same volume. It then:

1. pipes `restic dump` into `sqlite3 --safe` to build a new database file next to the live one;
2. requires every row-count check from the trailer to pass, one check per table, and `PRAGMA integrity_check` to answer `ok`;
3. keeps the old database as `stalwart.sqlite.before-restore-<UTC time>`, with its `-wal` and `-shm` files;
4. renames the new file to `stalwart.sqlite` in one atomic step;
5. prints each table's row count.

If any step fails, the live database is unchanged. A restore needs free space for one more copy of the database.

The kept old database stays until you delete it. Delete it once the restored server works. Its files are `stalwart/stalwart.sqlite.before-restore-*` in the data volume. On the VPS, delete them with `rm /var/lib/kasten/data/stalwart/stalwart.sqlite.before-restore-*`.

## Development-only settings

Production sets neither of these. `serve` logs a `DEVELOPMENT ONLY` line for each one that is set.

- **`KASTEN_EXTRA_CA_FILE`** names a PEM CA certificate. `serve` appends it to a copy of the system CA bundle in `/run/kasten/ca-certificates.crt` and points `SSL_CERT_FILE` at that copy. The container runs without root, so it cannot change the system trust store itself; Stalwart's TLS client and OpenSSL both read `SSL_CERT_FILE`. The local stack uses this to trust the dev CA of the outbox. Certificate checks stay on: the relay route never sets `allowInvalidCerts`.
- **`KASTEN_DEV_DNS_FORWARD`** lists names, separated by spaces or commas, that Unbound forwards to Docker's DNS (`127.0.0.11`) without DNSSEC validation. `.` means every name. The local stack sets `outbox .`: `outbox` is the relay's compose service name, and `.` keeps the stack fast on networks that block direct DNS. In this mode, the local stack does not exercise recursion or DNSSEC. `server/test/verify.sh` starts the production configuration and tests recursion with DNSSEC only where port 53 to a root server is open; on a network that blocks it, it prints `SKIP` for that check.

## Local stack

The repository's [`compose.yaml`](../compose.yaml) runs this image as the service `mail`, next to the outbox (see [`dev/outbox/README.md`](../dev/outbox/README.md)). The container has 963 MiB of memory and no swap, like the 1 GB VPS without its zram swap. In five runs of the test below, an idle `serve` container used 52 to 104 MiB (`docker stats`, about 20 seconds after the test traffic).

`./kasten dev up` starts the local stack in this order (see [`dev/README.md`](../dev/README.md)). It runs Compose with `compose.yaml` plus `dev/stack/compose.dev.yaml`.

1. `dev/outbox/make-dev-ca.sh` writes the dev CA and the outbox login.
2. Compose builds the images.
3. `kasten-server init` creates the volume. The wrapper writes the volume id into `.kasten-dev/mail.env` as `KASTEN_VOLUME_ID`.
4. `kasten-server recovery` runs in a container without a network, and `kasten setup --bootstrap` runs in that container's network namespace. The wrapper then stops recovery mode.
5. `docker compose up -d --wait` starts the stack, with `serve` in the `mail` container.
6. `kasten setup` runs. If it prints `Restart Stalwart to apply`, the wrapper restarts `mail` and runs setup again.

## Tests

`server/test/verify.sh` checks the image, the outbox and `compose.yaml` end to end, on ports 7501–7507 with the compose project `kasten-infra-server`. It needs Docker, Compose v2, `curl` and `jq`. Without `docker compose`, set `COMPOSE` to the path of a Compose v2 binary. `server/test/provision-test.sh` holds the minimal test-only Stalwart configuration it uses; it is not the real configuration.

```sh
KASTEN_TEST_DIR=/path/to/scratch server/test/verify.sh
```

Among its checks, `verify.sh` runs the shipped `etc/unbound.conf` in front of a stub DNSBL zone. It requires that the refusal code `127.255.255.254` gets an empty answer and that the listing `127.0.0.2` passes unchanged. That case passed on 4 November 2026, in Docker on a local VM.

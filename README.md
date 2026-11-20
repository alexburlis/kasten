# Kasten

Self-hosted email for your own domain, with an encrypted mailbox archive and search that runs on your device.

Kasten pairs Stalwart Community with an installable web app. The app decrypts messages locally and supports threads, aliases, attachments, encrypted drafts, an outbox, and offline reading and search. Stalwart receives mail directly. Amazon SES relays outgoing mail.

**Technical preview for experienced operators.** Kasten has run as a single-operator pilot on Fedora 45 with rootless Podman and SELinux enforcing. For a networked pilot, expect to manage DNS, a Fedora VPS, an SMTP relay, and off-host backups. Start with throwaway mail on the local stack or a test domain. The [operations guide](docs/operations.md#acceptance-on-the-real-server) sets out what to validate before moving primary mail.

```text
                 SMTP 25                         JMAP over HTTPS 443
 senders ───────────────▶ ┌───────────────────────┐ ◀──────────────── web app (static PWA)
                          │ VPS: kasten-server    │                   decrypts on your device
                          │ Stalwart + Unbound    │                   (OpenPGP.js in a worker)
                          │ SQLite on a LUKS disk │
 recipients ◀── Amazon SES ◀── 587, strict TLS ───┤
                          │ restic, encrypted ────┼──▶ backup bucket (B2, S3, …)
                          └───────────────────────┘
```

## Try it locally (no accounts)

You need a POSIX shell and Docker with Compose v2 or later (tested with Compose 5.7.0). If `docker compose` is missing, `./kasten` uses a `docker-compose` v2 binary from your `PATH`, or the binary that `KASTEN_COMPOSE` names. Plan for about 3 GB of disk and 2 GB of memory for Docker (estimates; on a Mac, the memory of Docker's VM). The mail container is capped at 963 MiB, like the 1 GB VPS. The first run downloads base images and pinned releases, so it needs internet access.

The local stack has been tested on Apple silicon macOS with Docker in Colima. Download or clone the source and run this command from its root:

```sh
./kasten dev up
```

`dev up` builds the images, starts the stack on `127.0.0.1` only, and creates the test account `you@kasten.test`. At the end it prints the local addresses, the path of the dev state (`.kasten-dev/state.json`) and, on the first run only, the account's password. The password is also in `.kasten-dev/you-password`. Then:

1. Open <http://localhost:7480> and sign in as `you@kasten.test` with that password.
2. Create your mail key. Kasten makes its recovery code: save it in your password manager, print or save the recovery sheet, and add a passkey for faster unlock, or choose **Not now** to use the recovery code. Stalwart uses your key and the operator key for eligible new mail. See the [encryption exceptions](docs/security.md#messages-the-server-stores-as-they-are).
3. Send yourself test mail: `./kasten dev mail` delivers six messages over SMTP: a thread of three, one with attachments, one with a non-ASCII subject and one in HTML with remote images.
4. Read, reply and search in the app. Outgoing mail goes to a local catcher in place of SES, at <http://localhost:7482>.
5. Lock the account, then run the safety check:

   ```sh
   ./kasten lock --account you@kasten.test --no-mfa --user-fingerprint "<the fingerprint on your recovery sheet>"
   ./kasten reader create --account you@kasten.test
   ./kasten check --account you@kasten.test
   ```

   `lock` pins your key set and takes away the app's right to change keys. It refuses unless the server's user key matches the fingerprint on your recovery sheet. On the dev stack, `--no-mfa` skips its check for sign-in codes; a real server needs codes first. `lock` also ends the app's sign-in, so sign in again afterwards. `reader create` makes the read-only login that the check uses. `check` confirms that every stored message is encrypted to exactly your key set or is a listed exception, such as mail that the server stores as it arrives, and that no readable Sent copy or old readable draft is left. It exits with 0 when clean, 1 on findings and 2 on an error, such as an unreadable `kasten.json`. On the dev stack, `./kasten lock --undo --account you@kasten.test` reverses the lock.

`./kasten dev down` stops the stack and keeps its data. `./kasten dev reset` deletes the dev mailbox volume and `.kasten-dev/`, after asking.

| Local address           | What it is                                                      |
| ----------------------- | --------------------------------------------------------------- |
| <http://localhost:7480> | The web app                                                     |
| <http://localhost:7481> | The mail API (JMAP and sign-in), as `mail.example.com` would be |
| `localhost:7425`        | Incoming SMTP, as port 25 would be                              |
| `localhost:7414`        | IMAP for `import-imap` only                                     |
| <http://localhost:7482> | The outbox catcher, standing in for SES                         |

## Run it for real: what you need

- **Mail host:** A Fedora 45 VPS with SELinux enforcing and rootless Podman. The documented real-host rehearsal used an amd64 system with 3.8 GiB RAM. Tests at 1 GiB used local arm64 VMs or simulations. Use at least the real rehearsal's memory for an initial pilot and measure your own workload. Allow at least 20 GB of disk, plus room to grow.
- **Domain and networking:** Editable DNS, public IPv4 and inbound TCP 25. Check port 25 with the provider before buying. The host firewall blocks outbound TCP 25.
- **Relay:** Amazon SES production access for your sending domain over TCP 587 with verified TLS. Verify SPF, DKIM and DMARC and test actual inbox placement.
- **Web app:** A separate HTTPS host for the static app. Protect its deployment credentials and DNS as carefully as the mail keys.
- **Recovery and access:** An off-host restic backend and SSH over Tailscale or from a fixed admin IP. The disk needs an operator to unlock it after reboot unless you configure a separate Tang server.

Follow the [VPS install guide](docs/install-vps.md) and the [security model](docs/security.md) before connecting a real domain.

## What setup needs access to

| When                 | Access                                                        | Why                                                                                              | Afterwards                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordering             | Your provider account                                         | Payment, the Fedora install when you create the server, removing any port-25 block               | Turn on TOTP for the provider login; no server snapshots, except the optional one in [the Fedora release upgrade](docs/operations.md#the-fedora-release-upgrade) after you approve its exact cost                 |
| First boot           | Root SSH with a key, and your Tailscale account               | Join Tailscale first, then install packages, the firewall, the encrypted disk, Podman and Kasten | `install.sh` closes public SSH; SSH stays open only over Tailscale or from the `--admin-ips` addresses                                                                                                            |
| Server configuration | Stalwart's admin API on `127.0.0.1:8080`, from the VPS itself | Domains, accounts, limits, sending route, sign-in rules                                          | The admin key works only from `127.0.0.1` and `::1`. Management calls also reach Stalwart on the public HTTPS listener: there the admin key gets HTTP 403, and mail credentials get `forbidden` on server objects |
| DNS                  | Your DNS provider                                             | MX, A/AAAA, SES DKIM, SPF, DMARC                                                                 | Unchanged, except when you add a domain                                                                                                                                                                           |
| AWS                  | Signed-in AWS console, or a setup IAM key                     | SES identities, SMTP credentials, production access                                              | Delete the setup key; only the SMTP credential stays on the server. A read-only key for the weekly checks stays on your computer                                                                                  |
| Backups              | A bucket and an application key                               | Nightly encrypted restic backups                                                                 | Use a key without delete rights where possible                                                                                                                                                                    |

The mail server never holds your private key, a DNS token, an AWS admin key or access to wherever the web app is deployed.

The kasten CLI runs on the VPS as root, from any directory, through `kasten-cli`. In this README, `cli <command>` means `kasten-cli <command>` there. The commands that read `kasten.json` also take `--config /etc/kasten/kasten.json`. Piped standard input works as it is. The repository's `./kasten` wrapper drives only the local dev stack.

## AWS: exactly what goes in the account

Use a separate AWS account for Kasten. Its SES quotas, reputation and automatic enforcement then stay apart from other mail you send through AWS. After severe abuse, for example spam through a stolen SMTP login, AWS can still act on accounts it considers related, so separation is not a guarantee.

1. **Account.** Use an email address that no other AWS account uses; a plus-address of your existing mailbox works. Turn on root MFA and save the root login in your password manager. Choose the paid account plan, so the account is not time-limited. Free-tier credits are fine but don't budget on them.
2. **Budget alert.** A free $5/month email alert. It warns you; it does not stop spending.
3. **SES, one region** (for example `eu-central-1`):
   - one domain identity per sending domain, with Easy DKIM (three CNAME records);
   - the SES pricing plan set to **à la carte**, not Essentials, and no dedicated IPs, Mail Manager or other paid add-ons;
   - a production access request. Describe the real use honestly: personal one-to-one mail from your own domain, no lists, bounces handled by SES. If AWS refuses, you can't send, so ask on day one.
4. **One SMTP user per domain.** Each is an IAM user whose only permission is `ses:SendRawEmail` on that one identity. Its access key ID is the SMTP username. On the VPS, `cli aws smtp-password` turns its secret access key into the SMTP password; [the AWS guide](docs/aws-ses.md) has the exact command.
5. **Agent setup only:** a temporary `kasten-setup` IAM user with the SES and IAM permissions in [the AWS guide](docs/aws-ses.md#setup-permissions). Delete it when setup is done.
6. **Weekly checks, optional:** a read-only `kasten-ops` IAM user that can read the SES account and the budget, for an agent's weekly checks ([the AWS guide](docs/aws-ses.md#read-only-user-for-the-weekly-checks)). Its key stays off the mail server.

Nothing else: no S3, Lambda, SES receiving, SNS topics or Cost Explorer. Exact policies, request text and console clicks are in [docs/aws-ses.md](docs/aws-ses.md).

## Two ways to set it up

**With an agent** (for example Claude Code), you do only what needs a human: payments, sign-ins, MFA, saving secrets and approving each external change. **By hand**, you follow the same steps yourself.

| Step          | With an agent: you do                                                                                                                                                        | With an agent: the agent does                                                                                                                                                                                                                                         | By hand                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1. Go         | Approve the exact list of purchases and changes                                                                                                                              | Prepares that list, with costs                                                                                                                                                                                                                                        | Read [the install guide](docs/install-vps.md)                      |
| 2. VPS        | Pay; create the server with Fedora, as in [the install guide](docs/install-vps.md#3-install-fedora-45); turn on provider TOTP; sign in to Tailscale; approve sign-in prompts | Picks the plan, removes the port-25 block, joins the VPS to Tailscale, runs `deploy/host/install.sh`, then builds the images and loads them onto the VPS                                                                                                              | Same, in the provider panel and over SSH                           |
| 3. AWS        | Card, phone check, root MFA, save the root login                                                                                                                             | Sets the budget alert, SES identities, SMTP users and the production request                                                                                                                                                                                          | Follow [docs/aws-ses.md](docs/aws-ses.md)                          |
| 4. DNS        | Approve the record list                                                                                                                                                      | Prints it with `kasten dns`, writes it and checks it                                                                                                                                                                                                                  | Copy the printed records into your DNS panel                       |
| 5. Server     | Nothing                                                                                                                                                                      | Runs `kasten-bootstrap` and `cli setup`, then the security and acceptance checks                                                                                                                                                                                      | Same commands                                                      |
| 6. App        | Add it to your Home Screen; create your key; print the recovery sheet; enrol sign-in MFA; read the agent the fingerprint on the sheet                                        | Hosts the app; after your key is in place, runs `cli lock` and `cli reader create`, and starts the daily check                                                                                                                                                        | Same, plus hosting the app yourself                                |
| 7. Backups    | Create or approve the bucket key                                                                                                                                             | Sets up nightly backups and a test restore                                                                                                                                                                                                                            | Follow [docs/operations.md](docs/operations.md#backups)            |
| 8. Move mail  | Approve the MX switch                                                                                                                                                        | Creates an import app password, imports old mail with `kasten import-imap` from your computer before the pilot week, proves the pilot-domain probe during the pilot, reconciles the import, switches MX and the probe to the production domain, watches the first day | The same import and pilot, then switch MX                          |
| **Your time** | **About 70–75 minutes**, plus normal use during a pilot week (estimate)                                                                                                      |                                                                                                                                                                                                                                                                       | **About 4–6 hours**, if Linux, DNS and AWS are familiar (estimate) |

The CLI commands run on the VPS as `cli <command>`, as described [above](#what-setup-needs-access-to). Three commands run on your computer instead, from a checkout of this repository:

- `kasten security-check`, because it must test from an address that the admin key does not allow ([install guide](docs/install-vps.md#12-run-the-security-check)).
- `kasten import-imap`, because the VPS firewall blocks outgoing IMAP. It reaches Kasten's IMAP import listener through an SSH tunnel ([install guide](docs/install-vps.md#15-move-your-mail-in)).
- `kasten read`, so that the operator's secret key never reaches the VPS ([agent setup](docs/agent-setup.md#reading-mail)).

`kasten dns` needs only `kasten.json`, so it runs in either place. To run the CLI from a checkout, you need Node 24. Run `pnpm install` once, then `node cli/src/main.ts <command>`.

What an agent needs from you, and what it must never be given, is in [docs/agent-setup.md](docs/agent-setup.md).

## Daily use

- **Reading:** the app downloads encrypted mail, decrypts it in a worker on your device, and keeps an encrypted local copy for offline reading and search.
- **Sending:** the app submits the message, deletes the server's temporary readable copy straight away, and stores its own encrypted copy in Sent.
- **New devices:** sign in, then use a passkey (Face ID, Touch ID, your password manager or a security key) or type the recovery code. The server keeps your key encrypted with the code, and the code encrypted to each passkey ([the key on the server](docs/security.md#the-key-on-the-server)); the recovery sheet, which holds the code, is the way in when that copy is missing.
- **Notifications:** a new-mail notification shows the sender and subject. To show only "New mail" on that device, turn off **Show sender and subject in notifications** in Settings. The app renews a device's notifications only while the app is unlocked on that device, so unlock the app there at least once in about 7 days. Otherwise that device's notifications stop, 6.5 days after the last unlock at the earliest, and resume at the next unlock. If you lose a device, press **Stop notifications on other devices** in Settings on another device.
- **Server upkeep:** Monitor backups, check the stored key sets, and run a delivery probe from an independent host. See [operations](docs/operations.md#daily-check-and-monitoring).

## Limits

- **Mailbox encryption.** Kasten encrypts eligible stored mail and creates an encrypted Sent copy. An operator key is required and can decrypt mail encrypted to it. Ordinary SMTP reaches the mail server and the outbound relay in readable form. Headers, temporary copies and [encryption exceptions](docs/security.md#messages-the-server-stores-as-they-are) also need protection.
- **Browser trust.** A compromise of the app origin, its DNS or its release pipeline can replace the code that handles your keys. Secure the app origin independently of the mail host. Review device-unlock and notification settings before use on shared devices.
- **Pilot evidence.** The Fedora 45 pilot delivered to and received from Gmail and Proton Mail. Inbox placement varied. Fresh third-party installations, physical iPhone and Android acceptance, and recovery to a replacement host still need qualification. See [acceptance checks](docs/operations.md#acceptance-on-the-real-server).
- **Updates.** The preview pins Stalwart 1.0.1. Rehearse upgrades on a restored copy. Stalwart 1.0.2 changes encryption settings and disables existing per-account encryption until you restore it. Verify encryption and permissions before allowing production mail after any upgrade. See [upgrades](docs/operations.md#upgrades).

Report security issues through the [security policy](SECURITY.md).

## Repository

| Path                  | What it is                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server/`             | The `kasten-server` image: pinned, checksum-verified Stalwart release, Unbound, SQLite tools, restic                                                                                 |
| `web/`                | The web app and the `kasten-web` image (static files only)                                                                                                                           |
| `packages/core/`      | Shared TypeScript: JMAP, OpenPGP, MIME, the send flow and the safety checks, used by the app and the CLI                                                                             |
| `cli/`                | The `kasten` CLI and the `kasten-cli` image: setup, DNS records, keys and lock, checks, the agent reader, import                                                                     |
| `deploy/`             | Production files: host install script, the container definitions (`podman.sh`) and their wrappers, firewall, systemd units, encrypted-disk and Tang setup, and their acceptance test |
| `docs/`               | Install, AWS, DNS, operations, security and agent guides, the architecture and the Stalwart reference                                                                                |
| `kasten`              | The wrapper for the local dev stack                                                                                                                                                  |
| `compose.yaml`        | The local dev stack                                                                                                                                                                  |
| `dev/`                | Dev stack helpers: test mail, the outbox CA, the GnuPG image and an IMAP source for import tests                                                                                     |
| `tests/`              | Integration tests and the README walkthrough against the dev stack                                                                                                                   |
| `kasten.example.json` | An example production `kasten.json`, with comments                                                                                                                                   |
| `tools/`              | The vendored anti-slop Oxlint plugins that `pnpm lint` loads                                                                                                                         |

## License

Apache-2.0. Copyright Alex Burlis. Stalwart is a separate project under its own licence, used unmodified as a released binary.

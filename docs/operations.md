# Operations

This page covers running Kasten after the install: monitoring, backups, upgrades, the acceptance run on a real server, reboots, lost devices, rotation, removing a pilot domain and moving hosts.

## How to run the commands on this page

Run every command on this page on the VPS, as root, unless the step names another machine. The Kasten helpers are in `/usr/local/sbin`, so they work from any directory. Every Kasten container runs with rootless Podman as the host user `kasten`.

| Command                      | What it does                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kasten-cli <command>`       | Runs one Kasten CLI command in a new, temporary container. The container sees `/var/lib/kasten/cli` read-only as `/etc/kasten`, and `/var/lib/kasten/cli/state` writable as `/etc/kasten/state`. Standard input always reaches the command, so pipes work as they are. It uses a terminal only when standard input and output are both terminals |
| `kasten-mail-exec <command>` | Runs `kasten-server <command>` inside the running mail container, `kasten-mail`, while `kasten.service` runs                                                                                                                                                                                                                                     |
| `kasten-mail-run <command>`  | Runs `kasten-server <command>` in a new, temporary mail container, while `kasten.service` is stopped (`systemctl stop kasten.service`). `kasten-server`'s own lock refuses a command while the running server or another command uses the volume                                                                                                 |
| `kasten-podman <arguments>`  | Runs Podman as the `kasten` user, for example `kasten-podman ps -a` or `kasten-podman images`. `kasten-podman ps -a` shows `(healthy)` for `kasten-mail` once its health check passes                                                                                                                                                            |
| `kasten <command>`           | The name of a Kasten CLI command, for example `kasten check`. Run it as `kasten-cli check`                                                                                                                                                                                                                                                       |
| `kasten-server <command>`    | The name of a mail server command, for example `kasten-server backup`. Run it with `kasten-mail-exec` or `kasten-mail-run`, as the step says                                                                                                                                                                                                     |

`kasten-mail-exec` and `kasten-mail-run` pass `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` and `KASTEN_BACKUP_ENV_FILE` into the container when they are set, and nothing else from your environment.

Container root in the CLI container is the `kasten` user on the host. So every file in `/var/lib/kasten/cli` must belong to `kasten:kasten`, without group or other access. Otherwise `kasten-cli` refuses with exit status 2 and prints the command that fixes it: `chown -R kasten:kasten /var/lib/kasten/cli && chmod -R go= /var/lib/kasten/cli`.

`/var/lib/kasten/cli` belongs to `kasten`, and `/var/lib/kasten/data` to the mail server's user. A process that runs as either user, such as a container's root, can leave a link there. Root would follow it: a `>`, `cp` or editor would write, and a `chown` or `chmod` of one file would change, whatever file the link names. So once the mail server has run, write a file there as the directory's owner. Each of these commands writes what comes on standard input, from a pipe, from `< file`, or typed until Ctrl-D:

```sh
setpriv --reuid=kasten --regid=kasten --init-groups sh -c 'umask 077 && cat >/var/lib/kasten/cli/<name>'
. /etc/kasten/host.env
setpriv --reuid="$KASTEN_MAIL_UID" --regid="$KASTEN_MAIL_UID" --clear-groups sh -c 'umask 077 && cat >/var/lib/kasten/data/secrets/<name>'
```

The file gets the right owner, mode 0600 and its directory's SELinux label, and a link leads it only to a file that the owner could change anyway. Do not use `install` there: on Fedora it gives the new file the label `var_lib_t`, which the running mail container cannot read (seen in a Fedora 45 VM on 6 November 2026). To move a file that the CLI wrote into `cli/state/`, move it as `kasten`: `setpriv --reuid=kasten --regid=kasten --init-groups mv /var/lib/kasten/cli/state/<name> /var/lib/kasten/cli/<name>`. The `chown -R` and `chmod -R` line above follows no link. The local container test, `deploy/test/run.sh`, checks that such a write follows a link that `kasten` left in `cli/` only as far as `kasten` could, and that `install.sh` and `kasten-bootstrap` follow no such link.

Every `kasten-cli` command on this page except `kasten-cli aws smtp-password` also takes `--config /etc/kasten/kasten.json`. The `./kasten` wrapper in the repository drives only the local dev stack: it refuses to run without `.kasten-dev/kasten.json`. Never use it for the VPS. [`deploy/README.md`](../deploy/README.md) lists the host files and the commands they expect.

## Daily check and monitoring

### What runs on its own

| Job                         | Where                                                  | When                                                            | Reports to                                                         |
| --------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `kasten check`              | Separate trusted machine, through the observer wrapper | Daily while online, after import/upgrades                       | One aggregate Kuma heartbeat; example offline tolerance seven days |
| `kasten-server backup`      | Pico backup timer                                      | Nightly 03:15 plus up to 30 minutes                             | Existing backup Kuma monitor                                       |
| `kasten probe`              | Off-host observer timer                                | Daily, on pilot domain during pilot, production domain after MX | Dedicated delivery heartbeat                                       |
| `fstrim`                    | Pico OS timer                                          | Weekly                                                          | System journal                                                     |
| Disk unlock and Tang access | Mail host and Tang host, respectively                  | Each event                                                      | Existing event monitors; protected URL files                       |

The mail-host installer enables Kasten's backup timer and Fedora's trim and update timers. Configure the [off-host checks](../deploy/observer/README.md) separately.

Kasten never empties Deleted Items (Trash) or Junk Mail on its own. `kasten setup` turns off Stalwart's automatic expunge, which deletes mail 30 days after it lands in either folder. Mail leaves them only when you delete it there, so both folders keep using disk until you empty them.

`kasten check` confirms these things:

- The key set is exactly the one you expect, and no key or subkey expires.
- Every stored message is encrypted to exactly that key set, or is a listed exception. [Security](security.md#messages-the-server-stores-as-they-are) lists the exceptions.
- No readable Sent copy exists.
- No readable draft is older than one hour.

After key creation, MFA, `lock` and `reader create`, configure the Mac [key-check observer](../deploy/observer/README.md). Invoke it once for all human accounts, never once per account into a shared monitor. Exit 0 means clean,1 findings and2 error, including rejected Kuma heartbeat. A missing heartbeat remains a failure, never cached success.

Review every finding that the check reports. Each `FINDING` line names the kind and, for a message, its email id. Decide which case applies:

1. A readable Sent copy or draft that the client left: delete it. The client keeps its own encrypted copy.
2. Legitimate mail, such as sender-encrypted mail, mail that arrived before the key, or an imported Sent copy: add its email id to the account's list in the file that `checkExceptionsFile` in `kasten.json` names, for example `{"you@example.com": ["<email id>"]}`. The next run is then clean and the monitor recovers, so a later key swap alerts again.

A listed id excuses only that one message. A draft older than one hour stays a finding, even when it is listed. A Sent copy's date proves nothing, because the app and the import source each choose it, so review each Sent finding before you list it. `check --exceptions <file>` reads another file instead, for one run. The local dev-stack proof of an imported Sent copy listed through `checkExceptionsFile` is `tests/integration/cli-check.test.ts`, which passed on 4 November 2026.

The off-host observer runs `kasten probe` with only dedicated probe credentials and its own state. It proves SES acceptance and mailbox receipt separately, waits boundedly and does not resend an ambiguous attempt. Its source-state lock also excludes overlapping manual invocations. Start on the pilot-domain account during the pilot; change to the production-domain account only at MX cutover. See the observer guide for exact commands and the [install guide](install-vps.md#14-run-the-acceptance-checks) for ordering.

It waits up to 600 seconds for the message (`--timeout`). Exit status 0 means the message arrived, 1 means it did not arrive or the outcome is uncertain, and 2 means an error, for example an unreadable `kasten.json`, one without a `probe` section, or a Kuma push that fails.

Amazon SES replaces the Message-ID of every message it relays ([SES header fields](https://docs.aws.amazon.com/ses/latest/dg/header-fields.html)). So the probe recognises the copy that comes back by a random marker of 16 hex digits in its subject, `Kasten delivery probe <day> <marker>`. It saves the marker in `probe.json` before the submit. A `probe.json` written by an earlier version has no marker. If that state is from the same day and its copy was not yet received, the probe reports it as not received, and sends a fresh probe the next day.

The probe's full loop, with the marker, was proven only on a local test stack, with Mailpit in place of SES: `tests/integration/cli-probe.test.ts` passed on 4 November 2026. Mailpit keeps the Message-ID, so only the unit tests' fake relay (`relayMessageId`) replaces it as SES does. A November 2026 pilot completed the probe through live SES and public MX. Verify the same route for your installation.

### Uptime Kuma

[Uptime Kuma](https://github.com/louislam/uptime-kuma) is one free monitor that works. Any monitor with push heartbeats and certificate checks works too.

A push monitor waits for a request to its push URL. It alerts when no request arrives within the heartbeat interval. The push URL has this form:

```text
https://kuma.example.net/api/push/<token>?status=up&msg=OK&ping=
```

Treat each push URL as a secret, because anyone with it can report success. Create one push monitor, with its own URL, for each job:

- `kasten check` reads its URL from the file that `kumaPushUrlFile` in `kasten.json` names.
- `kasten probe` reads its URL from the file that `probe.kumaPushUrlFile` names.
- The backup reads its URL as `KASTEN_PUSH_URL` from `/var/lib/kasten/secrets/backup.env`. `kasten-push` passes it to `curl` on standard input after a successful backup.
- The unlock event reads its URL from the file that `KASTEN_UNLOCK_PUSH_URL_FILE` in `/etc/kasten/host.env` names. The documented setup uses `/var/lib/kasten/secrets/unlock-push-url`, inside LUKS.
- The Tang hook, `kasten-tang-event`, reads its URL from `/etc/kasten/tang-push-url` on the Tang host.

Put each observer URL file beside its protected configuration on the observer host, mode `0600`; keep backup secrets on the mail host inside LUKS. The CLI sets `status`, `msg` and `ping` itself.

Create these monitors:

| Monitor        | Type                           | Target                                                             | Heartbeat interval            |
| -------------- | ------------------------------ | ------------------------------------------------------------------ | ----------------------------- |
| Mail API       | HTTP(s), certificate expiry on | `https://mail.example.com/healthz/live`, which answers 200         | 5 minutes                     |
| MX certificate | HTTP(s), certificate expiry on | `https://mx.example.com/healthz/live`                              | 5 minutes                     |
| Inbound SMTP   | TCP port                       | `mx.example.com`, port 25                                          | 5 minutes                     |
| App            | HTTP(s), certificate expiry on | `https://app.example.com/`                                         | 5 minutes                     |
| Safety check   | Push                           | `kasten check`                                                     | Operator-defined grace period |
| Delivery probe | Push                           | `kasten probe`, once you enable `kasten-probe.timer`               | 25 hours                      |
| Backup         | Push                           | the nightly backup                                                 | 25 hours                      |
| Unlock events  | Push                           | `kasten-unlock` after each successful mount (`unlock ok <method>`) | Event record, not a heartbeat |
| Tang access    | Push                           | `kasten-tang-event` on the Tang host                               | Event record, not a heartbeat |

The unlock and Tang hooks send no periodic heartbeats, so a normal Push monitor for them also goes down when its interval expires. Set their status and rearm them as in the [observer guide](../deploy/observer/README.md#unlock-and-tang-access-events-existing-kuma).

Stalwart answers `/healthz/live` on the public listener too. Its root path `/` answers 404, which a Kuma HTTP monitor reports as down. The health path was checked on the local dev stack, not yet on a real VPS.

The safety observer pushes exactly one aggregate worst result, so a later healthy account cannot hide an earlier failure.

Also watch the certificate on port 25. Let's Encrypt no longer sends expiry email, and a TCP monitor does not read the certificate that port 25 offers after `STARTTLS`. The MX certificate monitor reads the certificate that Stalwart serves for `mx.example.com` on port 443. `kasten setup` requests the ACME certificate for that name too, also when it is in another domain of `domains` than the mail API, so the monitor covers that case. Senders get a certificate for the same name after `STARTTLS` on port 25. That this is the same certificate is inspected in the setup code, not yet tested on a real VPS. So also run this check every week (weekly check 8), from a machine that can open outbound TCP port 25:

```sh
openssl s_client -connect mx.example.com:25 -starttls smtp -servername mx.example.com </dev/null 2>/dev/null | openssl x509 -noout -enddate
```

The Inbound SMTP monitor and this command need outbound TCP port 25 from the machine that runs them. Many hosting and home networks block it. If your monitor host cannot open port 25, leave the Inbound SMTP monitor out: the daily probe proves that mail still reaches port 25.

Send the monitor's alerts to an address outside Kasten, for example a Gmail address. A "mail is down" alert must not depend on the mail system it reports on.

### Weekly checks

Do these once a week, or have your agent do them:

1. Open the SES console's account dashboard. Check that sending is enabled and that no enforcement or review notice is shown. An agent runs the same check from your computer with the read-only [`kasten-ops` key](aws-ses.md#read-only-user-for-the-weekly-checks): `aws sesv2 get-account --region eu-central-1 --query '{Sending:SendingEnabled,Enforcement:EnforcementStatus,Quota:SendQuota}'`. `Sending` must be `true` and `Enforcement` must be `HEALTHY`.
2. Open AWS Billing and Cost Management. Check month-to-date spend. With the `kasten-ops` key, an agent runs `aws budgets describe-budget --account-id 111122223333 --budget-name kasten-monthly --query 'Budget.CalculatedSpend'` instead. Do not call the Cost Explorer API (`aws ce ...`): AWS charges for each request.
3. List the backup snapshots from a machine other than the VPS, as in [List snapshots from outside the VPS](#list-snapshots-from-outside-the-vps). Check that last night's snapshot exists. Optionally, compare the bucket's stored size in the provider's console with the size that `restic --repository-file repo.txt --password-file restic.pw stats --mode raw-data --no-lock` prints. A bucket that is much larger keeps deleted files, as in [Bucket key choices](#bucket-key-choices).
4. Check for new Stalwart and restic releases and security advisories, as in [Upgrades](#upgrades).
5. On the VPS, run `dnf5 needs-restarting; echo $?`. `Reboot should not be necessary.` and exit status 0 mean that none is due. Otherwise its message says which installed updates, for example of the kernel or systemd, take effect only after a reboot, or what failed; exit status 1 covers both. When a reboot is due, reboot as in [Before a planned reboot](#reboots-and-unlock). Do not add `-C`: the cache-only form fails on Fedora 44 and 45, with exit status 1, whether or not a reboot is due.
6. On the VPS, run `df -h / /var/lib /home`. At least 3 GiB must be free on `/`, and on `/var/lib` if it is a separate file system: the sparse volume file `/var/lib/kasten.luks` grows into this space. Podman keeps the images in `/home/kasten/.local/share/containers/storage`. If `/home` is a separate file system, it also needs space for the next upgrade's images. If less is free, first remove old images, as in step 7 of [Upgrade steps](#upgrade-steps). If that is not enough, plan a larger disk.
7. Check for security advisories that affect the software inside the images. The host's automatic updates never reach it. Check Debian's security advisories (DSA) for the Debian packages that [`server/README.md`](../server/README.md) lists, Node.js 24 security releases, and nginx security advisories. In the repository, run `pnpm audit --prod` for the JavaScript packages in `pnpm-lock.yaml`. If an advisory affects Kasten, update the images as in [Image and dependency updates](#image-and-dependency-updates).
8. From a machine that can open outbound TCP port 25, run the `openssl s_client` command in [Uptime Kuma](#uptime-kuma). The date it prints must be more than two weeks away.

## Backups

### What runs

`kasten-server backup` runs nightly. It takes these steps:

1. It streams a consistent `sqlite3 .dump` of the mail database into `restic backup`. The database never sits unencrypted in a temporary file.
2. It runs `restic forget --keep-daily 30 --prune`, which keeps one snapshot for each of the last 30 days.

It exits with status 5 when the snapshot was saved but the retention step failed. Any other non-zero status means that the backup failed. `kasten-push` calls the Kuma push URL only after status 0.

restic encrypts every snapshot with the restic password. The snapshot holds your mail still encrypted to your key bundle. It also holds readable metadata, and any queue or upload rows that were live at that moment. Protect the restic password like your mail key.

Nightly backups mean you can lose up to 24 hours of mail if the server fails. Thirty daily snapshots are for recovery, not a long-term archive.

### Configure it

The backup needs three files on the encrypted volume, each readable only by its owner:

| File on the VPS                                   | Owner and mode            | Path inside the mail container               | Holds                                 |
| ------------------------------------------------- | ------------------------- | -------------------------------------------- | ------------------------------------- |
| `/var/lib/kasten/secrets/backup.env`              | root, `0600`              | None: `kasten-backup.service` reads it       | The variables below                   |
| `/var/lib/kasten/data/secrets/restic-password`    | `KASTEN_MAIL_UID`, `0600` | `/var/lib/kasten/secrets/restic-password`    | The restic password, on one line      |
| `/var/lib/kasten/data/secrets/restic-backend.env` | `KASTEN_MAIL_UID`, `0600` | `/var/lib/kasten/secrets/restic-backend.env` | The bucket key, as `NAME=value` lines |

The mail container sees only `/var/lib/kasten/data`, as `/var/lib/kasten`. So the host's `/var/lib/kasten/secrets` and the container's `/var/lib/kasten/secrets` are different directories.

`KASTEN_MAIL_UID` is the host uid and gid that own the mail server's files. Rootless Podman maps the server's uid 2525 inside the container to it. install.sh sets it in `/etc/kasten/host.env`, from the `kasten` user's subordinate IDs.

`backup.env` sets these variables:

| Variable                 | Value                                                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESTIC_REPOSITORY`      | For example `s3:https://s3.eu-central-003.backblazeb2.com/<bucket>/kasten` or `b2:<bucket>:kasten`                                                                                                                     |
| `RESTIC_PASSWORD_FILE`   | `/var/lib/kasten/secrets/restic-password`, the path inside the container                                                                                                                                               |
| `KASTEN_BACKUP_ENV_FILE` | `/var/lib/kasten/secrets/restic-backend.env`, the path inside the container. Its lines: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for the S3 API, or `B2_ACCOUNT_ID` and `B2_ACCOUNT_KEY` for a `b2:` repository |
| `KASTEN_PUSH_URL`        | Optional. The Kuma push URL to call after a successful backup                                                                                                                                                          |

Write one `NAME=value` line for each variable. Put the push URL in double quotes, for example `KASTEN_PUSH_URL="https://kuma.example.net/api/push/<token>?status=up&msg=OK&ping="`. The URL holds `&`, and the commands below read `backup.env` with the shell: without the quotes, the shell does not set the variable.

`kasten-server` refuses `RESTIC_PASSWORD` as a variable. In the backend file it accepts only restic backend variables, whose names start with `B2_`, `AWS_`, `AZURE_`, `GOOGLE_`, `OS_`, `ST_` or `RCLONE_`.

Keep credentials out of `RESTIC_REPOSITORY`, and put them in the file that `KASTEN_BACKUP_ENV_FILE` names: `kasten-podman` passes the values of `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` and `KASTEN_BACKUP_ENV_FILE` in a process's arguments for an instant, and every user on the host can read those arguments, as in [Security](security.md#container-isolation-on-the-host).

Set it up once:

1. Create a private bucket in your storage provider. On Backblaze B2 with an `s3:` repository, also set the bucket's lifecycle rule, as in [Bucket key choices](#bucket-key-choices). B2 also offers free daily caps on storage and transactions. A reached cap makes the backup fail, so the backup monitor alerts; set any cap well above the nightly use.
2. Create an application key for that bucket only. Choose the key type from the table below. Save it in your password manager.
3. Generate a long random restic password. Save it in your password manager.
4. Write the three files on the VPS, with the owners and modes in the table above. Write `backup.env` into root's own directory, for example with `(umask 077; cat >/var/lib/kasten/secrets/backup.env)`. Write the two restic files as the mail server's user, as in [How to run the commands on this page](#how-to-run-the-commands-on-this-page): each command reads the file's content from standard input, from a pipe or until Ctrl-D.

   ```sh
   . /etc/kasten/host.env
   setpriv --reuid="$KASTEN_MAIL_UID" --regid="$KASTEN_MAIL_UID" --clear-groups sh -c 'umask 077 && cat >/var/lib/kasten/data/secrets/restic-password'
   setpriv --reuid="$KASTEN_MAIL_UID" --regid="$KASTEN_MAIL_UID" --clear-groups sh -c 'umask 077 && cat >/var/lib/kasten/data/secrets/restic-backend.env'
   ```

   Save the `RESTIC_REPOSITORY` value in your private configuration directory, next to `kasten.json`. It is not secret, and a [restore after host loss](#restore-after-host-loss) needs it.

5. While `kasten.service` runs, create the restic repository:

   ```sh
   set -a; . /var/lib/kasten/secrets/backup.env; set +a
   kasten-mail-exec backup-init
   ```

6. Run `systemctl start kasten-backup.service`. Check that `journalctl -t kasten-backup` shows `backup complete`. Read the backup's report by this tag: rootless Podman moves itself out of the unit, so a search by unit name misses the report.

### Bucket key choices

| Key                                                            | A break-in on the VPS can                                                    | Retention works?                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Bucket-scoped key with delete rights                           | Delete every snapshot at once                                                | Yes. On B2 with an `s3:` repository, only with a lifecycle rule                                      |
| Bucket-scoped key without delete rights, plus a lifecycle rule | Hide every snapshot. The lifecycle rule deletes hidden files after its delay | Not yet tested on a real bucket. restic must still be able to remove its lock files and pruned packs |

Prefer the key without delete rights if your test shows that `kasten-server backup` exits with status 0 with it. Otherwise use the bucket-scoped key. A key without delete rights only delays loss. Set the lifecycle rule's hide-to-delete delay to longer than a week, and list the snapshots weekly from outside the VPS, so that you notice in time.

On Backblaze B2, a delete through the S3 API only hides the file. A hidden file keeps its storage, and its cost, until a lifecycle rule deletes it. So an `s3:` repository on B2 needs a lifecycle rule with either key, or `restic forget --prune` frees nothing in the bucket. For the key with delete rights, choose the bucket setting **Keep only the last version of the file**, which is `daysFromHidingToDeleting: 1`. For the key without delete rights, set `daysFromHidingToDeleting` to more than 7. Neither rule is yet tested on a real bucket. Weekly check 3 compares the bucket's stored size with the repository's size, so a missing rule shows up.

### List snapshots from outside the VPS

Run this on your own computer, with a read-only key for the same bucket. Set the key in the environment first: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for the S3 API, or `B2_ACCOUNT_ID` and `B2_ACCOUNT_KEY` for a `b2:` repository. `repo.txt` holds the `RESTIC_REPOSITORY` value, and `restic.pw` the restic password.

```sh
restic --repository-file repo.txt --password-file restic.pw snapshots --no-lock
```

`--no-lock` lets a key without write rights list snapshots.

### Restore rehearsal

Rehearse a cold restore before you move real mail in, and after any upgrade that changes the database format. Use a disposable Linux machine with Docker and no public ports, for example a local VM. Keep it on encrypted storage, because the restored database holds readable metadata.

Take every file from your password manager and your private configuration directory, never from the VPS. The rehearsal must prove that you can recover when the VPS is gone, as in [Restore after host loss](#restore-after-host-loss).

Steps 1 to 5 of this rehearsal on a second machine passed on 6 November 2026: a Colima VM on a Mac (arm64, the amd64 image under Rosetta) restored the Hetzner rehearsal server's latest snapshot from Backblaze B2 through the S3 API, every row count matched, and the server became healthy in about 12 seconds without a network. Steps 2 to 7 passed on 11 November 2026 in the same Colima VM, with the images of release `6124401` copied from the server: the latest snapshot restored in 7 seconds with every row count matching, the server was healthy without a network after about 6 seconds, `reader create` proved its read-only reader, and one restored message decrypted with `read get` and the operator key. The rehearsal container, its volumes and the copied files were then removed. A backup to a local restic repository and a restore on the same host, with `kasten-mail-run restore latest`, passed on 5 November 2026 in `deploy/test/run.sh all` (a Fedora 45 container without SELinux), and on 6 November 2026 in the two Lima stages of `deploy/test/lima/` (Fedora 45 and Fedora 44 VMs with SELinux enforcing).

1. Build the `kasten-server` and `kasten-cli` images on your computer from the commit that your private configuration directory records for the VPS, as in [deploy/README.md](../deploy/README.md#order-of-use). Load them into Docker on the rehearsal machine, for example with `docker save kasten-server:<version> kasten-cli:<version> | ssh <rehearsal machine> docker load`.
2. Create an empty volume and prepare it. Note the `volumeId` that `init` prints:

   ```sh
   docker volume create kasten-rehearsal
   docker run --rm -v kasten-rehearsal:/var/lib/kasten kasten-server:<version> init
   ```

3. Write `restic-password` and `restic-backend.env` from your password manager into a directory, for example `./rehearsal`. Give the directory owner 2525 and mode `0700`, and the files owner 2525 and mode `0600`. Docker on this machine maps no user IDs, so the server's uid 2525 is the host's uid 2525 here, not `KASTEN_MAIL_UID` as on the VPS. The restore takes a restic lock, so use a bucket key that can write. A read-only key works only for listing with `--no-lock`.
4. Write `rehearsal.env` like `backup.env`, with the `RESTIC_REPOSITORY` value from your private configuration directory. Point `RESTIC_PASSWORD_FILE` at `/mnt/rehearsal/restic-password` and `KASTEN_BACKUP_ENV_FILE` at `/mnt/rehearsal/restic-backend.env`. Then restore the latest snapshot:

   ```sh
   set -a; . ./rehearsal.env; set +a
   docker run --rm -e KASTEN_VOLUME_ID=<volume id> \
     -e RESTIC_REPOSITORY -e RESTIC_PASSWORD_FILE -e KASTEN_BACKUP_ENV_FILE \
     -v kasten-rehearsal:/var/lib/kasten -v "$PWD/rehearsal:/mnt/rehearsal:ro" \
     kasten-server:<version> restore latest
   ```

   It prints each table's row count. It fails unless every count matches the snapshot and the database passes SQLite's integrity check.

5. Start Stalwart without any network, so that it cannot send queued mail through SES or ask for certificates:

   ```sh
   docker run -d --name kasten-rehearsal --network none -e KASTEN_VOLUME_ID=<volume id> \
     -v kasten-rehearsal:/var/lib/kasten kasten-server:<version>
   docker inspect -f '{{.State.Health.Status}}' kasten-rehearsal
   ```

   The status must be `healthy` within about a minute.

6. Check that one restored message decrypts with `kasten read get` ([the CLI guide](../cli/README.md#commands)). Run the `kasten-cli` image with `--network container:kasten-rehearsal`, so that it reaches the server's `127.0.0.1:8080`. Build a directory for `/etc/kasten` from off-host copies only: `kasten.json` and the operator public key file from your private configuration directory, the admin API key from your password manager, and your copy of `lock.json` in a `state/` subdirectory. Mount it writable at `/etc/kasten`, and mount the operator's secret key and passphrase files from your password manager. Run the image as your own user (`--user "$(id -u):$(id -g)"`), so that it can read the `0600` files. First create a reader with `reader create --account you@example.com --config /etc/kasten/kasten.json --url http://127.0.0.1:8080`. Then run `read get` with `--url http://127.0.0.1:8080`. This also proves that the admin API key in your password manager still works.
7. Run `docker rm -f kasten-rehearsal` and `docker volume rm kasten-rehearsal`. Delete the copied files, then the machine. Keep only the record of what passed.

Keep the real server unavailable to the rehearsal: never point MX or DNS at the disposable machine.

### Restore for real

1. Stop the mail service: `systemctl stop kasten.service`.
2. Restore the latest snapshot. For an older one, give its snapshot id instead of `latest`:

   ```sh
   set -a; . /var/lib/kasten/secrets/backup.env; set +a
   kasten-mail-run restore latest
   ```

3. Start the mail service: `systemctl start kasten.service`.
4. Run a full check of every account: `kasten-cli check --full --config /etc/kasten/kasten.json`. Without `--account`, it checks every account in `users` except the probe account, so each of them needs its lock and reader credential.
5. Run the security check from your computer, as in [the install guide](install-vps.md#12-run-the-security-check).

The restore builds a new database next to the old one. It leaves the live database unchanged if it fails. It needs free space on the volume for one more copy of the database.

The restore keeps the previous database as `stalwart.sqlite.before-restore-<UTC time>`, with its `-wal` and `-shm` files, in `/var/lib/kasten/data/stalwart/` on the host. These files hold the old mail and use space on the volume. Once the restored server works, delete them:

```sh
rm /var/lib/kasten/data/stalwart/stalwart.sqlite.before-restore-*
```

To go back to the database from before the restore, stop the mail service and swap the files back. First move the restored database aside with its own `-wal` and `-shm` files, because SQLite would apply a leftover `-wal` file to the wrong database. Replace `<UTC time>` with the time in the file name:

```sh
systemctl stop kasten.service
cd /var/lib/kasten/data/stalwart
for ext in "" -wal -shm; do [ ! -e "stalwart.sqlite$ext" ] || mv "stalwart.sqlite$ext" "stalwart.sqlite.restored$ext"; done
for ext in "" -wal -shm; do [ ! -e "stalwart.sqlite.before-restore-<UTC time>$ext" ] || mv "stalwart.sqlite.before-restore-<UTC time>$ext" "stalwart.sqlite$ext"; done
systemctl start kasten.service
```

Then run steps 4 and 5 above. Once the server works, delete the `stalwart.sqlite.restored*` files. This swap-back has not been tested.

### Restore after host loss

Use this when the VPS and its disk are gone, for example after the provider reinstalled it. It uses only the restic repository, your password manager and your private configuration directory. It has not been tested; the [restore rehearsal](#restore-rehearsal) rehearses its restore and read steps.

You need these off-host copies:

- In your password manager: the restic password and the bucket key, the admin API key, the SES SMTP user names and passwords, the probe account's password, the Kuma push URLs and the operator's secret key with its passphrase, as listed in [Secrets you save](agent-setup.md#secrets-you-save).
- In your private configuration directory: the current `kasten.json`, the public key files it names, the file that `checkExceptionsFile` names, if any, the copy of `state/lock.json` that you saved after the last `kasten lock`, the `RESTIC_REPOSITORY` value, the commit that the VPS's images were built from, and every setting that you changed in `/etc/kasten/host.env`. None of them is secret. Copy `kasten.json` there after every change on the VPS.

Without `lock.json`, step 9 can pin only the current key sets. Mail encrypted to an earlier key set, from before a key rotation, is then a finding in every check. List it in the `checkExceptionsFile` file after review. Without it, a Sent copy encrypted to an earlier key set is a finding too, like other mail. Every Sent finding stays one until its id is in the `checkExceptionsFile` file, which step 4 restores. A machine that runs `check`, such as the [Mac observer](../deploy/observer/README.md), keeps another copy of `lock.json`.

1. Install a new VPS with [the install guide](install-vps.md), sections 2 to 6: Fedora 45 as in [section 3](install-vps.md#3-install-fedora-45), then `install.sh`, the images with `kasten-podman load`, `kasten-mail-run init` and the new volume ID as `KASTEN_VOLUME_ID`. Before you run `install.sh` in section 5, write the settings that you changed into a new `/etc/kasten/host.env` (`mkdir -p /etc/kasten` first): `install.sh` reads that file and keeps its values. Leave out `KASTEN_MAIL_UID`: `install.sh` sets it from the new host's subordinate IDs, and stops if the file holds a different value. In section 6, build the images from the commit that your private configuration directory records, so that Stalwart opens the database with the release that wrote it. Use a new recovery passphrase for the new volume. Do not run `kasten-bootstrap`: the restore brings the configuration, including the admin API key.
2. Write `backup.env` with the `RESTIC_REPOSITORY` value from your private configuration directory, and `restic-password` and `restic-backend.env` from your password manager, with the owners and modes in [Configure it](#configure-it). If `KASTEN_UNLOCK_PUSH_URL_FILE` names a file, write the unlock monitor's push URL into it from your password manager, root-only with mode `0600`, as in [the observer guide](../deploy/observer/README.md#unlock-and-tang-access-events-existing-kuma).
3. Restore the latest snapshot, as in [Restore for real](#restore-for-real), step 2. `kasten.service` has not started yet, so there is nothing to stop.
4. Copy `kasten.json`, its public key files and the exceptions file from your private configuration directory into `/var/lib/kasten/cli/`. Write the secret files that `kasten.json` names from your password manager: the admin API key, the SES SMTP user name and password, the probe password, each mail password that a `users[].passwordFile` names, and the Kuma push URL files. Setup reads every `passwordFile` that is not `null`; the accounts already exist, so you can set those to `null` instead. Put your copy of `lock.json` at `/var/lib/kasten/cli/state/lock.json`. Give every file to the `kasten` user without group or other access, as in [install section 7](install-vps.md#7-prepare-the-configuration), step 7: `chown -R kasten:kasten /var/lib/kasten/cli && chmod -R go= /var/lib/kasten/cli`.
5. If the new VPS has new addresses, update `dns.ipv4` and `dns.ipv6` in `kasten.json`, and point the `mx.` and `mail.` A and AAAA records at the new VPS.
6. Run `systemctl start kasten.service`.
7. Run `kasten-cli setup --config /etc/kasten/kasten.json`. If it prints `Restart Stalwart to apply`, run `systemctl restart kasten.service`. Run it again until it reports `0 changed`.
8. Run `kasten-cli app-password list --account <email> --config /etc/kasten/kasten.json` for each account in `users` except the probe. The restored database still holds the old host's reader and import app passwords.
9. Run `kasten-cli lock --account <email> --config /etc/kasten/kasten.json` for each account in `users` except the probe. With `lock.json` restored, the pinned key set needs no `--user-fingerprint`. Without it, pass `--user-fingerprint` with the fingerprint on the account's recovery sheet. Lock ends every app session of the account.
10. Run `kasten-cli reader rotate --account <email> --config /etc/kasten/kasten.json` for each of these accounts. It writes a new reader and destroys the old host's readers. Delete any old import app password with `kasten-cli app-password delete`. Copy the new reader files and `lock.json` to every machine that runs `check` or `read`. If such a machine reaches the admin API through an SSH tunnel, point the tunnel at the new VPS.
11. Run a full check: `kasten-cli check --full --config /etc/kasten/kasten.json`. Then run the security check from your computer, as in [the install guide](install-vps.md#12-run-the-security-check).
12. Bind the new volume to Tang, as in [install section 9](install-vps.md#9-automatic-unlock-with-tang). The new VPS has a new tailnet address, so first update the Tang host's firewall and the Tailscale access policy for it, as in [the Tang guide](../deploy/tang/README.md#a-new-tailnet-address).
13. Save `/var/lib/kasten/cli/state/lock.json` in your private configuration directory again.

### Compact the database

SQLite does not give the space of deleted mail back to the volume. To compact the database, stop the mail service, run `kasten-server vacuum`, and start it again:

```sh
systemctl stop kasten.service
kasten-mail-run vacuum
systemctl start kasten.service
```

`vacuum` refuses while Stalwart or a backup uses the volume. It logs the database size before and after.

## Upgrades

### The release gate

Upgrade only to a release that passes these checks. The pins live in `server/PINS`. [Checking the upstream signatures](../server/README.md#checking-the-upstream-signatures) gives the exact commands.

**Stalwart:**

1. Use a 1.0.x release that has been public for at least three weeks, with no open security advisory. A release that fixes an advisory affecting your running release is exempt from the age rule: deploy it promptly, after the checks.
2. Download the release tarball for each architecture.
3. Check its SHA-256 against the digest on the GitHub release page.
4. Check its Sigstore bundle with `cosign verify-blob`. The signing identity must be `https://github.com/stalwartlabs/stalwart/.github/workflows/ci.yml@refs/tags/v<version>`, and the issuer must be `https://token.actions.githubusercontent.com`. cosign must print `Verified OK`.
5. Read the release notes for a database format change. If the format changes, plan the restore path before you upgrade.

**restic:**

1. Download `SHA256SUMS` and `SHA256SUMS.asc` from the GitHub release.
2. Check `SHA256SUMS.asc` with `gpg --verify` against restic's release signing key. `server/README.md` gives the key's fingerprint and where to get it.
3. Check the SHA-256 of the binary against `SHA256SUMS`.

restic publishes no Sigstore material, so the PGP signature is its gate.

**Spam rules:**

A new `spam-rules` pin in `server/PINS` does not reach a running server. `kasten-server init` copies the pinned file into the volume, but Stalwart v1.0.1 imports the rules only at startup when no spam rule exists yet, which is a new volume's first start. Kasten has no command that updates the rules of a running server. `cli/test/unit/spam-rules-pin.test.ts` fails on any new pin until its `x:HttpLookup` namespaces are reviewed into `SPAM_RULE_REMOTE_LISTS` and the test's table. Until a rules-update command exists, keep the reviewed pin for existing servers.

### Upgrade steps

1. Run `systemctl start kasten-backup.service`. Check that `journalctl -t kasten-backup` shows `backup complete`.
2. Run `kasten-cli setup --config /etc/kasten/kasten.json`. It must report `0 changed`. Then export the configuration, as in [Complete configuration and residue evidence](#complete-configuration-and-residue-evidence).
3. On your computer, update the version, SHA-256 and source lines in `server/PINS`. Then test the new pin before anything reaches the VPS:
   - Run `pnpm verify`.
   - Rebuild the dev stack with `./kasten dev up`, then run `pnpm test:integration` and `pnpm --filter @kasten/web test:e2e` against it, as in [the integration tests](../tests/integration/README.md). The integration tests include `tests/integration/send-flow.test.ts`, which proves that a send through the app's flow leaves no readable Sent copy or draft on the server.
   - Build a `kasten-server` image from the new pin and run `deploy/test/run.sh all`, as in [the acceptance test](../deploy/README.md#the-acceptance-test). It tests the host files on Fedora 45 in a container, without SELinux. It passed on 5 November 2026 (253 checks, 0 failures; arm64).
   - Run the Lima stages in `deploy/test/lima/`. They install Kasten in a Fedora VM with enforcing SELinux: on Fedora 45 with 1 GiB of memory, and on Fedora 44 followed by [the Fedora release upgrade](#the-fedora-release-upgrade) to 45. Both passed on 6 November 2026, in aarch64 VMs: `f45.sh all` with 213 checks and `upgrade.sh all` with 161, each with 0 failures.

   Any failure stops the upgrade.

4. Build both images for the VPS with a new tag, and load them on the VPS. The CLI image gets the same tag, because `KASTEN_VERSION` names both:

   ```sh
   docker build --platform linux/amd64 -t kasten-server:<version> server/
   docker build --platform linux/amd64 -f cli/Dockerfile -t kasten-cli:<version> .
   docker save kasten-server:<version> kasten-cli:<version> | ssh root@<vps> kasten-podman load
   ```

   The Dockerfile checks each download against `PINS`. Docker builds the images on your computer; on the VPS, Podman loads them for the `kasten` user and names them `localhost/kasten-server:<version>` and `localhost/kasten-cli:<version>`.

5. If mail arrived since step 1, run the backup of step 1 again now, so that a rollback loses as little mail as possible. Note the snapshot id: restic prints `snapshot <id> saved` in `journalctl -t kasten-backup`. Then run `systemctl stop kasten-backup.timer`. Every backup keeps only the newest snapshot of each day (`restic forget --keep-daily 30`), so a backup on the new release later that day would delete the noted snapshot. Start the timer again, `systemctl start kasten-backup.timer`, once the checks after the upgrade pass or the rollback is done. On the VPS, set `KASTEN_VERSION=<version>` in `/opt/kasten/.env`. Then run `systemctl restart kasten.service`.
6. Send one test message to yourself from an outside mail account that the operator names, for example a Gmail address. An agent can do this without your app. Check that it arrives: on your computer, `node cli/src/main.ts read list --account you@example.com --config kasten.json --reader-file reader.secret --url https://mail.example.com --since 1h` lists it, as in [Reading mail](agent-setup.md#reading-mail). If you are present, also reply to it from the app.
7. When the [checks after every upgrade](#checks-after-every-upgrade) pass, remove the previous images on the VPS by name: `kasten-podman image rm localhost/kasten-server:<previous> localhost/kasten-cli:<previous>`. Never prune all unused images instead: no container uses the CLI image between runs, so a prune would also remove the current CLI image. Keep the previous images until the checks pass, because the rollback needs them. They take space in `/home/kasten/.local/share/containers/storage`, on the root disk, which also holds the volume file. Record the commit that you built the new images from in your private configuration directory: a [restore after host loss](#restore-after-host-loss) builds the images from it.

### Complete configuration and residue evidence

Compare the server configuration before and after an upgrade with `kasten config export`. It reads every configuration type in the running release's own schema (`GET /api/schema`) through the admin API, including types a new release adds. Settings that are not stored read back as the release's built-in defaults, so a changed default shows up too. It skips account credentials and per-account data, reports, the queue, tasks, automatic IP bans, logs and telemetry; the file lists the skipped types under `notConfiguration`. It writes sorted JSON, one property per line, to a new mode `0600` file. Stalwart masks every secret as `****`, and the command writes nothing while `x:SystemSettings.includeSecrets` is not `false`.

Before upgrading, with Stalwart running and after upgrade step 2 reports `0 changed`:

```sh
kasten-cli config export --config /etc/kasten/kasten.json --out /etc/kasten/state/config-before-upgrade.json
```

The CLI container can write only `/etc/kasten/state`, which is `/var/lib/kasten/cli/state` inside LUKS. After the new image has started (upgrade step 5), and before `kasten-cli setup` in [Checks after every upgrade](#checks-after-every-upgrade), export `config-after-upgrade.json` the same way. Then compare the two exports:

```sh
diff -u /var/lib/kasten/cli/state/config-before-upgrade.json /var/lib/kasten/cli/state/config-after-upgrade.json
```

Exit 0 means that no setting changed. A changed `schema` line means that the release changed its object schema. Every other changed line is one property of one object; the object's type and id are the keys it sits under. Any unexplained difference stops the upgrade: roll back. `x:Account` and `x:OAuthClient` also change when users or clients are added during the window. The exports hold hostnames, account names and network settings: never copy them to chat storage or logs. Delete both files after the review. The export has not yet run on a real VPS. The export's local dev-stack proof, `tests/integration/cli-config-export.test.ts`, passed on 4 November 2026.

The complete-store export is recovery evidence, not the configuration comparison. It uses Stalwart's native export of the whole store, configuration plus mailbox data and metadata, and compares stored bytes. So it cannot show a changed built-in default that is not stored. This costs an extra full store copy per snapshot and needs space inside LUKS; stop if the protected volume cannot fit both exports. No unproven opaque subspace is omitted. Hash manifests show changed files without printing credentials, but mail changes can add noise; review the protected exports as needed and never present a noisy hash diff as semantic configuration approval.

Before upgrading, after the backup and the configuration export, with Stalwart stopped:

```sh
systemctl stop kasten.service
kasten-mail-run store-export before-upgrade
```

After the new image has started and setup/readback/security checks complete, stop it again and export `after-upgrade` with the same command. Then run `kasten-mail-run store-diff before-upgrade after-upgrade`. Exit 0 means identical complete-store manifests;1 means changes requiring review; other nonzero statuses mean errors/refusals. A schema-changing release requires compatible recovery; never import a new export into an old release blindly. Record the exact release hashes, reviewed differences and acceptance, then resume mail.

After the separately authorized synthetic receive/send/delete workload, run the host helper with the unique synthetic body marker in a protected file:

```sh
timeout --kill-after=5 1800 /usr/local/sbin/kasten-residue-check /var/lib/kasten/secrets/upgrade-canary
```

It reports counts/status only, never message bodies. Without scan roots, it scans `/` and every other mounted disk file system, such as `/home` with Podman's images, and skips the encrypted volume. A canary on unencrypted storage is a failure; inability to scan is an error. Plaintext residue inside LUKS is acknowledged and does not establish a failed OpenPGP store; run the key-set/encryption and encrypted-Sent checks separately. Verify the mount and no disk swap before interpreting confinement. After consumers stop, preserve only the small protected manifest/review and remove the exact two task-created exports plus synthetic marker. Exports contain credentials and mail; never move them to chat storage or public logs. The [server reference](../server/README.md) owns exact commands and bounds.

### Checks after every upgrade

Rerun all of these. An `allowedEndpoints` expression error or a changed default can silently reopen OAuth client registration.

1. First export `config-after-upgrade.json`, as in [Complete configuration and residue evidence](#complete-configuration-and-residue-evidence). Then run `kasten-cli setup --config /etc/kasten/kasten.json`. It reads back every setting that Kasten manages and fails on any difference. It must report `0 changed`. A change means that the new release changed a setting that Kasten sets: setup has put it back, so find out why before you continue. If setup prints `Restart Stalwart to apply`, run `systemctl restart kasten.service`. If setup prints `Run kasten lock for every account`, it had to create the app's OAuth client again, for example because `webApp.oauthClientId` changed. Run `kasten-cli lock --account <email> --config /etc/kasten/kasten.json` for each account in `users` except the probe. Lock records the new client in `lock.json` and proves the lock again. When the client id changed, setup also destroyed the old client, so its app sessions have already ended; this was not tested. This managed-setting readback does not replace the configuration export diff in [Complete configuration and residue evidence](#complete-configuration-and-residue-evidence).
2. Send a canary message from an outside mail account that the operator names. Run the aggregate key-check observer on the Mac. The check must pass, which shows that the message is stored encrypted to exactly your key set.
3. Run the security check from your computer, as in [the install guide](install-vps.md#12-run-the-security-check). It must refuse registration, Stalwart's `/login` page and management calls with user credentials, pass the exact-origin CORS preflight, and find the admin key refused (HTTP 403) from the public address. On 11 November 2026 all 10 checks passed against the Hetzner rehearsal server after `kasten lock`, including the recovery-admin login with the real secret, and all 11 passed after the upgrade to `17ab7ff`, which added the `/login` check.
4. Check that the app's token still cannot change your key set. The security check covers this with a token of the locked app client. `kasten-cli lock` proves it too, but it also signs every app session of the account out.
5. Check that a send from the app leaves no readable Sent copy. For the new release, `tests/integration/send-flow.test.ts` in step 3 of the upgrade proves it on the dev stack. On the real server, the next key check after your next send from the app reports any readable Sent copy. If you are present, send a message from the app now, run the aggregate key-check observer on the Mac and confirm that no readable Sent copy remains. This passed on the Hetzner rehearsal server on 12 November 2026, after the upgrade to `17ab7ff`: 7 messages, all encrypted to exactly the key set, 0 findings.
6. Run a short memory test, as in [Acceptance](#acceptance-on-the-real-server), under a normal mail load, but without a backup: the backup timer stays stopped until these checks pass.

If a check fails, roll back. The rollback has not been tested. Do not run real mail on a release that fails.

If the release notes (gate step 5) show no database format change: set `KASTEN_VERSION` back to the previous tag, run `systemctl restart kasten.service`, then run `kasten-cli setup --config /etc/kasten/kasten.json`.

If the new release changed the database format, the previous release must not start on the changed database. Restore the snapshot from upgrade step 1, or step 5 if you ran it again there, with the previous image:

1. Before you stop anything, list the mail that arrived since that snapshot. On your computer, for each account, run `node cli/src/main.ts read list --account <email> --config kasten.json --reader-file reader.secret --url https://mail.example.com --since <time of the snapshot> --limit 2000`, with the time as UTC, for example `2026-11-04T03:15Z`. Without `--limit`, it lists at most 50 messages. If it reports that it looked at 2000 messages, the list may be incomplete: the mail it did not list is lost by the restore. Save each listed message with `read get <email id> ... --raw <file>`, as in [Reading mail](agent-setup.md#reading-mail). The saved files are decrypted mail: keep them in a private `0700` directory.
2. Run `systemctl stop kasten.service`.
3. Set `KASTEN_VERSION` back to the previous tag in `/opt/kasten/.env`.
4. Restore the snapshot by its id, as in [Restore for real](#restore-for-real), step 2. Do not use `latest`: a nightly backup that ran on the new release is newer.
5. Run `systemctl start kasten.service`, then `kasten-cli setup --config /etc/kasten/kasten.json` and a full check, `kasten-cli check --full --config /etc/kasten/kasten.json`.
6. The restored database does not have the mail that you listed in step 1. Kasten has no command that puts saved files back into a mailbox. Give each account's saved messages to the person who owns the account, then delete the files.

### Fedora updates and the web app

- All Fedora updates install automatically every day, without automatic reboots. `dnf5-automatic.timer` runs at 06:00 plus up to 60 minutes, with the settings in `/etc/dnf/automatic.conf`. install.sh sets this up. The updates are security and bug fixes, and also new upstream versions of packages such as Podman, crun, systemd and the kernel. They reach only the host's own packages, not the packages inside the images.
- A new kernel or systemd takes effect only at the next reboot. When `dnf5 needs-restarting` reports that a reboot is due (weekly check 5), reboot after the checks in [Reboots and unlock](#reboots-and-unlock).
- Because the updates bring new upstream versions, a behaviour change in Podman, crun or systemd can land unattended. The daily check and the daily probe catch its effect, for example mail that stops arriving, but not its cause. To see what ran, read `journalctl -u dnf5-automatic.service`, which holds only recent runs since the last reboot, and `/var/log/dnf5.log`. That log stays on the disk and holds package names only. In a Fedora 45 Lima VM on 6 November 2026 (`f45.sh`), one `dnf5-automatic` run changed 94 packages, among them the kernel, crun, passt and systemd; mail stayed healthy and did not restart.
- On a 1 GB host, a large update takes the free memory down to the acceptance line. In that VM (aarch64, 1 GiB), `f45.sh` runs that update with mail running, `tailscaled` running but not signed in, a two-message test mailbox and `kasten-cli check --full` in a loop. In four such runs on 6 November 2026, the lowest `MemAvailable` was 159 to 173 MiB; an earlier run without `tailscaled` and with a plain check reached 151 MiB. The [acceptance run](#acceptance-on-the-real-server) requires at least 150 MiB. No process was killed for lack of memory, and every check passed. The real server, with a real mailbox and a signed-in `tailscaled`, will be at the line or below it. This has not yet been measured on the 1 GB server: the acceptance run measures it beside mail and a full key check.
- A memory cap on `dnf5-automatic.service` does not help. In four more such VM runs, a `MemoryHigh=` drop-in of 256, 192 or 128 MiB left the lowest `MemAvailable` at 150 to 163 MiB, no higher than without it, and made the run up to 2.2 times slower (142 s instead of 52 to 66 s). Kasten therefore ships no cap. If the real server fails the free-memory line, stop and let the owner decide: the larger plan in [install section 1](install-vps.md#1-choose-a-vps) costs more.
- Build web app updates on your own computer and deploy them to the app host. Never deploy the app from the mail server.

### The Fedora release upgrade

Move the VPS to the next Fedora release, one release at a time, about every six months: once the next release has passed the release gate in step 1, and well before the current release's support ends. Read that date on the VPS with `grep SUPPORT_END /etc/os-release`, because an update of the `fedora-release` package can change it. For Fedora 45, the Cloud image 45-1.4 gives `2027-11-24`, and the `fedora-release` package that was current on 5 November 2026 gives `2027-12-08`. Fedora publishes a release about every six months and supports each one until four weeks after the release two versions later, so each one-release step has about six months. `dnf5 system-upgrade` can also skip a release, for example from 45 to 47, but only in the four weeks between the newer release and `SUPPORT_END`. Kasten plans no such step: it would first need the upgrade stage run for that exact pair of releases. Mail is down from step 3 to step 6, and senders retry.

This procedure has not yet run on a real VPS. Its rehearsal in a local aarch64 Lima VM, `deploy/test/lima/upgrade.sh`, passed on 6 November 2026: it installed and ran Kasten on Fedora 44, then followed steps 2 to 6 to Fedora 45, one release. It had no provider snapshot, observer, SES, Tang or machine outside the VM: the recovery passphrase stood in for Tang, and the VM ran the checks that the steps run from outside the VPS. In step 4, neither boot mounted the volume or attempted an unlock, and the offline transaction took about 3.5 minutes.

1. **Release gate.** Run `deploy/test/run.sh all` and the Lima stages on the target Fedora release, including the upgrade stage from the release that the VPS runs. The tests pin Fedora 45 (`deploy/test/Dockerfile.fedora` and `deploy/test/lima/f45.yaml`) and the upgrade from Fedora 44 to 45 (`f44.yaml` and the release numbers in `upgrade.sh`), so first change those pins to the target release and the VPS's release. Then add the target release to `SUPPORTED` in `deploy/host/install.sh`: install.sh runs only on the releases listed there. Copy that Kasten release's `deploy/` to the VPS, as in [install section 5](install-vps.md#5-run-the-host-install-script).
2. **Pre-checks.**
   - Run `systemctl start kasten-backup.service`. Then list the new snapshot from outside the VPS, as in [List snapshots from outside the VPS](#list-snapshots-from-outside-the-vps).
   - Check that the key-check observer's monitor is green.
   - Write a new synthetic marker for the residue check of step 6, into a root-only file inside the volume: `(umask 077; printf 'kastenupgrade%s\n' "$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')" >/var/lib/kasten/secrets/upgrade-canary)`. The marker is random text, not a secret. From an outside mail account that the operator names, send one test message to your own address, with the marker, `cat /var/lib/kasten/secrets/upgrade-canary`, in its body. The owner's approval of this upgrade must cover these test messages. Check that the message arrived.
   - Run `dnf5 -y upgrade --refresh`. Then reboot onto the latest packages of the current release, as in [Before a planned reboot](#reboots-and-unlock). Tang unlocks the volume.
   - Run `df -h / /var`. At least 3 GiB plus the size of the download must be free: dnf5 keeps the download under `/var`, and the volume file grows in `/var/lib`.
   - Run `dnf5 -y system-upgrade download --releasever=<target>`, with the number of the target release. Mail keeps running.
3. **Freeze.**
   - Run `systemctl stop kasten.service kasten-unlock.service`. This stops mail and locks the volume.
   - Run `systemctl disable kasten.service kasten-unlock.service`. Disable both: `kasten.service` requires `kasten-unlock.service`, so either one left enabled would unlock the volume at the next boot.
   - Optionally, take a provider snapshot, but only after the owner approves its exact cost.
4. Run `dnf5 -y system-upgrade reboot`. Without `-y` and without a terminal, dnf5 asks `Is this ok [y/N]:`, exits with status 0 and does not reboot: a local Lima VM showed this on 5 November 2026. The offline transaction runs in `system-update.target`, where no Kasten unit starts. The host then boots the new release. The volume stays locked across both boots.
5. **Host checks before mail.**
   - `grep VERSION_ID /etc/os-release` prints the new release.
   - `getenforce` prints `Enforcing`.
   - `kasten-podman info --format '{{.Host.Security.Rootless}} {{.Store.TransientStore}}'` prints `true true`.
   - `systemd-analyze verify /etc/systemd/system/kasten*.service /etc/systemd/system/kasten*.timer` reports no error.
   - `nft list table inet kasten` lists the Kasten firewall.
   - `sysctl net.ipv4.ip_unprivileged_port_start` shows 25.
   - `cat /proc/swaps` lists only zram devices.
   - `systemctl is-enabled systemd-oomd.service auditd.service dnf-makecache.timer` prints `masked` for each.
   - `dnf5 repo info fedora updates` shows `protocol=https` for both repositories.

   Then run `deploy/host/install.sh --skip volume` from the copy of `deploy/`. It is safe to run again, and it writes back its own configuration files and drop-ins, for example where the upgrade left a `.rpmnew` file. Its units step enables both units again. So do not reboot between step 5 and step 6: a reboot would unlock the volume and start mail on its own.

6. **Mail.**
   - Run `systemctl enable kasten.service kasten-unlock.service`, which install.sh has already done.
   - Run `systemctl start kasten-unlock.service`. It unlocks the volume through Tang and starts `kasten.service`.
   - The unlock event must say `method=tang`: `journalctl -t kasten-unlock -g '^event='`.
   - From outside the VPS, check that port 25 answers with the SMTP banner.
   - `kasten-cli setup --config /etc/kasten/kasten.json` prints `0 changed`.
   - `kasten-podman images` lists both images.
   - Run the key-check observer and the delivery probe, as in the [observer guide](../deploy/observer/README.md).
   - From the same outside account, send a second test message with the marker of step 2, now to the new release, and check that it arrived. Then run the residue check of [Complete configuration and residue evidence](#complete-configuration-and-residue-evidence) with that marker: `timeout --kill-after=5 1800 kasten-residue-check /var/lib/kasten/secrets/upgrade-canary`. It must exit with status 0: neither message left the marker on the unencrypted disk, before, during or after the upgrade. Then delete both test messages in the app, and the marker: `rm /var/lib/kasten/secrets/upgrade-canary`.
   - Then run `dnf5 system-upgrade clean`.
   - Delete the provider snapshot of step 3 once these checks pass. Like any snapshot, a copy booted from it could reach Tang as this host, as in [Automatic unlock](security.md#automatic-unlock).
7. **Rollback.** The provider snapshot holds the host as it was after step 3: the volume locked, both units disabled, and the new release's packages that step 2 downloaded. After you restore it, enable both units and start `kasten-unlock.service`, as in step 6. Once mail runs again, run `dnf5 system-upgrade clean`, which deletes that download.
   - If a check in step 5 fails, restore the provider snapshot. Mail was locked and down, and senders retry.
   - If a check fails after step 6 and Stalwart has accepted mail, first back it up on the new release. If `kasten.service` is active and `kasten-podman ps` shows `kasten-mail` as `(healthy)`, run `systemctl start kasten-backup.service`; `journalctl -t kasten-backup` then shows the snapshot id as `snapshot <id> saved`. Otherwise `kasten-backup.service` cannot run, because it needs the running mail container: run `systemctl stop kasten.service`, then `set -a; . /var/lib/kasten/secrets/backup.env; set +a; kasten-mail-run backup`, which prints the same line. Note the snapshot id. Then restore the provider snapshot. Do not start mail on its old database, or the mail that arrives then is lost by the restore. Instead, unlock without mail through Tang with `kasten-unlock start`, then run `set -a; . /var/lib/kasten/secrets/backup.env; set +a` and `kasten-mail-run restore <id>` with the noted id, as in [Restore for real](#restore-for-real). Then run `kasten-unlock stop`, enable both units and start `kasten-unlock.service`, as in step 6.
   - Without a provider snapshot, fix forward, or reinstall the previous release and restore from the backup, as in [Restore after host loss](#restore-after-host-loss).

The logs of the offline boot are lost at the next reboot, because the journal is in RAM. `/var/log/dnf5.log` stays on the disk, with package names only.

### Image and dependency updates

Each image holds its own copies of the software it runs. `kasten-server` holds Debian's Unbound, OpenSSL, SQLite and the rest of its base image. `kasten-cli` holds Node.js and the JavaScript packages in `pnpm-lock.yaml`, such as OpenPGP.js and postal-mime, which parse incoming mail. `kasten-web` holds nginx, and its bundle holds OpenPGP.js and DOMPurify. They change only when you rebuild the image. When weekly check 7 finds an advisory that affects one of them:

1. On your computer, update what the advisory names:
   - A Debian package in `kasten-server`: the Dockerfile installs only named packages and runs no `apt-get upgrade`. So a rebuild with the same base digest and `docker build --no-cache` refreshes only the packages that the Dockerfile installs, such as `unbound` and `sqlite3`. A fix in a package of the base image itself, such as `libc6` or `libssl3t64`, needs a new `debian:trixie-slim` digest: set it in the `debian` line of `server/PINS` and in both `FROM` lines of `server/Dockerfile`. In both cases, build the VPS image in upgrade step 4 with `--no-cache` too, and check the fixed version in it before `docker save`, for example `docker run --rm --entrypoint dpkg-query kasten-server:<version> -W <package>`.
   - Node.js: set the new `node:24-slim` digest in the `FROM` line of `web/Dockerfile` and both `FROM` lines of `cli/Dockerfile`.
   - nginx: set the new `nginxinc/nginx-unprivileged` tag and digest in the second `FROM` line of `web/Dockerfile`.
   - A JavaScript package: update it with pnpm and commit the new `pnpm-lock.yaml`. `pnpm audit --prod` must then report nothing that affects Kasten.
2. Test as in upgrade step 3: `pnpm verify`, the integration and end-to-end tests, `deploy/test/run.sh all` and the Lima stages.
3. Deploy `kasten-server` and `kasten-cli` with a new tag through [upgrade steps](#upgrade-steps) 1, 2 and 4 to 7, and run every [check after an upgrade](#checks-after-every-upgrade). Deploy a new `kasten-web` image to the app host, as in [install section 10](install-vps.md#10-host-the-web-app).

This route has not yet run.

## Acceptance on the real server

The memory numbers in the README come from a simulation on a Mac. Repeat the test on your real VPS before you move real mail in. CPU timings from the simulation predict nothing about a VPS.

### What to run

Run these at the same time, then keep the server under normal load for 24 hours, with every timer that production uses enabled:

1. A bulk import of a mailbox of realistic size with `node cli/src/main.ts import-imap` on your computer, through the SSH tunnel to the import listener, as in [Move your mail in](install-vps.md#15-move-your-mail-in) ([the CLI guide](../cli/README.md#kasten-import-imap)). Turn notifications off on every device first, and on again after the import, as described there.
2. Incoming mail to the pilot domain from [section 14 of the install guide](install-vps.md#14-run-the-acceptance-checks), including two 35 MB messages at once and one message just under the 40 MiB inbound limit. Until the MX switch, mail to your own domain still goes to the old provider.
3. App use: open, search and send, including one 38 MB outgoing message.
4. The nightly backup to the real bucket.
5. While the backup runs: a full key check on the VPS, `kasten-cli check --full --no-push --config /etc/kasten/kasten.json`, and Fedora's update job, `systemctl start dnf5-automatic.service`.

Send the large inbound messages with an SMTP client that speaks `STARTTLS`, from a machine that can open outbound TCP port 25, such as the machine you used for the port-25 test in [install section 3](install-vps.md#3-install-fedora-45). If no machine you have can open port 25, ask your VPS provider or another mail provider for a host that can; without one, this part of the acceptance cannot run. For example, with [swaks](https://jetmore.org/john/code/swaks/):

```sh
head -c 25600000 /dev/urandom >25MB.bin
head -c 30000000 /dev/urandom >30MB.bin
for i in 1 2; do
  swaks --server mx.example.com --port 25 --tls --from you@outside.example --to you@pilot.example.com --attach @25MB.bin &
done
wait
swaks --server mx.example.com --port 25 --tls --from you@outside.example --to you@pilot.example.com --attach @30MB.bin
```

Base64 makes an attachment about 37% larger, so a 25.6 MB file gives a message of about 35 MB, and a 30 MB file one of about 41 MB, just under 40 MiB. `--tls` makes swaks require `STARTTLS`.

After the soak, measure one restore on its own, right after a nightly backup. Run `systemctl stop kasten.service`, then the restore of the latest snapshot, as in [Restore for real](#restore-for-real), step 2. Record its wall time and the minimum `MemAvailable`. Then run `systemctl start kasten.service` and a full check, `kasten-cli check --full --config /etc/kasten/kasten.json`. The restored database lacks the mail that arrived after that snapshot. During the pilot this is test mail only. To keep it, swap the previous database back, as in [Restore for real](#restore-for-real).

### Measured on the Hetzner rehearsal server, 11 November 2026

The server has 3.8 GiB of memory, more than the 1 GB plan. The nightly backup, a full key check and `dnf5-automatic.service` ran at once and all succeeded; the lowest `MemAvailable` in that window was 2.9 GiB, with no swap in use and no out-of-memory kill. Two messages of 33 MiB sent at the same time, as in item 2, did not both get in: Stalwart's own memory budget (`limit.memory-budget`, 256 MiB, Stalwart's default, which Kasten does not change) answered the second one with `452 4.3.1 Insufficient system storage` at about 99 MB of in-flight messages. A 4xx answer tells the sender to retry. The same message sent again on its own was accepted in 4 seconds, and a 38.6 MiB message was accepted while the first one was being stored. So the "Refused mail" criterion below counts a 4xx for concurrent large messages that arrives on retry as expected behaviour, not as a refusal. The 24-hour soak started at 22:19 UTC.

The soak sampled memory every 5 seconds from 11 November, 22:19 UTC, to 12 November, 20:17 UTC: 15,756 samples over 22 hours, under the rehearsal's real mail, the daily probe and the key checks. The rehearsal stopped after 22 of the planned 24 hours. The lowest `MemAvailable` was 2,815 MiB, against the 150 MiB floor; no sample used swap, and no out-of-memory kill happened. `getenforce` printed `Enforcing` and rootless Podman reported `true` at the end. The mail log showed no refusal of legitimate mail; its only `limit.memory-budget` entry is the 33 MiB load test above.

### Pass criteria

| Criterion           | Pass                                                                                                             | How to measure                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free memory         | `MemAvailable` stays at least 150 MiB the whole time                                                             | Sample `/proc/meminfo` every few seconds and record the minimum                                                                                               |
| Out-of-memory kills | Zero                                                                                                             | `grep oom_kill /proc/vmstat` before and after; `journalctl -k`                                                                                                |
| Refused mail        | Zero refused legitimate messages                                                                                 | Every test message arrives; no 4xx or 5xx reply in Stalwart's log                                                                                             |
| Backup speed        | The nightly backup and prune finish before the next nightly run                                                  | The backup job's start and end times                                                                                                                          |
| Import speed        | The bulk copy finishes before the pilot week starts                                                              | The import's start and end times                                                                                                                              |
| Responsiveness      | No app, JMAP or SMTP request times out                                                                           | App errors; the senders' logs                                                                                                                                 |
| Soak                | 24 hours under normal load with all of the above                                                                 | The same samples, over the whole day                                                                                                                          |
| Update memory       | Free memory and out-of-memory kills pass while `dnf5-automatic.service`, mail and the full key check run at once | The memory peak that systemd logs when the run ends, in `journalctl -u dnf5-automatic.service`; the minimum `MemAvailable` and the swap in use during the run |
| SELinux             | `getenforce` prints `Enforcing`, before and after the soak                                                       | `getenforce`                                                                                                                                                  |
| Rootless Podman     | `true true`, before and after the soak                                                                           | `kasten-podman info --format '{{.Host.Security.Rootless}} {{.Store.TransientStore}}'`                                                                         |

Record the CPU, import, backup and restore times. Also record the peak memory of mail, `dnf5-automatic.service` and the full key check while they run at once (item 5 above), the swap in use and any out-of-memory kill. The server fails the speed acceptance only if a required job misses its window under the concurrent load. The repository has no sampling script for these numbers. Record them with your own commands. Stalwart's log is `journalctl CONTAINER_NAME=kasten-mail`.

### Other checks before real mail

1. An external connection reaches port 25 over IPv4, and over IPv6 if you publish AAAA records.
2. Real messages from Gmail, Outlook and one other provider arrive at the pilot domain.
3. Your messages arrive in real Gmail, Outlook and GMX inboxes. SES accepting them is not enough.
4. DNS resolves through the local Unbound resolver. Clock sync works. Tailscale shows a direct path.
5. The security check passes. Run it from your computer, as in [the install guide](install-vps.md#12-run-the-security-check).
6. Push notifications, key unlock, offline reading and search work on your real phone. Also check these on the phone, with the mailbox from the bulk import:
   - The first download and indexing of the whole mailbox finishes, and Settings then says that all messages are saved and searchable on this device.
   - The message just under the 40 MiB inbound limit opens, and search finds a word from its text.
   - After the browser removes Kasten's data, for example after **Clear this device** or when the phone runs short of storage, the app asks for the key from the recovery sheet, then downloads and indexes the mail again. Until indexing is complete, search shows how much of the mail it covers, never a partial result as complete.

   `web/e2e/large-message.spec.ts` opens and searches a message just under the 40 MiB limit in Chromium and WebKit on the dev stack. It passed in both browsers on 4 November 2026. In Node, the largest decrypt test is 20 MB (`packages/core/test/live/decrypt.live.ts`). Neither replaces the check on the real phone.

7. The server reboots and unlocks without your computer, if you use Tang. After that first real reboot, check on the VPS that nothing reaches the unencrypted disk:
   - `swapon --show=NAME --noheadings` prints only `/dev/zram` devices.
   - `journalctl --header | grep 'File path'` prints only files under `/run/log/journal`, apart from the files in `/var/log/journal` that the Fedora image wrote before install.sh. None of those may change after the install: `find /var/log/journal -type f -printf '%p %s %T@\n' | sort | diff /root/journal-files.install -` prints nothing. The list is the one from [install section 5](install-vps.md#5-run-the-host-install-script), step 6. `deploy/test/run.sh` makes the same comparison after its test mail.
   - `rpm -q rsyslog syslog-ng` reports both as not installed, and `/var/log` holds no `syslog` or `messages` file.
8. The disk unlocks with the recovery passphrase while Tang is unreachable.
9. The [restore rehearsal](#restore-rehearsal) passes.

If any check fails, stop. [Security](security.md#when-to-stop-and-decide) lists what each failure means.

## Reboots and unlock

The boot order is network and Tailscale, then disk unlock, then mount, then Stalwart. If the disk does not unlock, Stalwart does not start and nothing answers on port 25. Senders retry for several days, so a short outage loses no mail.

**With Tang**, the disk unlocks itself when the VPS reaches the Tang server. Tang also needs Tailscale's coordination service at boot, unless you have tested Tailscale's network-map caching.

If Tang or Tailscale's coordination service is unreachable at boot, `kasten-unlock.service` fails after `KASTEN_UNLOCK_TIMEOUT` seconds (set in `/etc/kasten/host.env`), and systemd starts it again a minute later, until Tang answers. Once Tang answers, the disk unlocks and mounts, and `kasten.service` starts, with nobody acting. Exit status 6 is not retried: it means no volume file, no Tang binding, or another file system on `/var/lib/kasten`. `deploy/test/run.sh all` passed its retry test on 5 November 2026: its Fedora 45 container was restarted while Tang, in another container on a stand-in tailnet, was down, and once Tang was back, systemd's retry unlocked through Tang and started `kasten.service` with nobody acting. The retry has not yet run on a real VPS.

After an unlock, `kasten.service` takes about 30 seconds to become active: Podman runs the mail container's first health check 30 seconds after the start. A start took 31 seconds in `deploy/test/run.sh all` on 5 November 2026 (a Fedora 45 container without SELinux), and 30 or 31 seconds in the Lima stages on 6 November 2026 (Fedora VMs with SELinux enforcing), where an unlock with the recovery passphrase plus the start took 30 to 32 seconds.

If the disk unlocks but its file system does not mount, for example because it needs a repair, `kasten-unlock.service` and `kasten-unlock-passphrase` lock the disk again and fail. The unit then tries again every minute, and each attempt unlocks through Tang again. To repair the file system:

1. Run `systemctl stop kasten-unlock.service`, so that no attempt mounts the volume during the repair.
2. Run `cryptsetup open "$(kasten-unlock attach)" kasten` as root, and type the recovery passphrase.
3. Run `e2fsck /dev/mapper/kasten`.
4. Run `kasten-unlock-passphrase`. It mounts the open volume and starts `kasten.service`.

`deploy/test/host.test.py` tests the lock after a failed mount with stub commands. Neither the lock nor this repair has run on a real VPS.

**Without Tang**, or when Tang is unreachable, unlock by hand:

1. Connect over Tailscale SSH.
2. Run `kasten-unlock-passphrase` as root, and type the recovery passphrase when it asks. It unlocks and mounts the volume, then starts `kasten.service`. Before the first boot is done, it starts nothing and names the next step instead.
3. Check that Stalwart runs: `systemctl status kasten.service`.

`kasten-unlock-passphrase` is safe while an automatic attempt runs: whichever of the two mounts the volume second does not report an unlock.

When Tang returns, no restart is needed: the next attempt unlocks the disk and starts `kasten.service`. To end the retries and keep the disk locked, run `systemctl stop kasten-unlock.service`.

To lock the disk by hand, run `systemctl stop kasten.service kasten-unlock.service`. To unlock it through Tang again, run `systemctl start kasten.service`. Lock through systemd, not with `kasten-unlock stop`, so that the units' state stays true.

Before `kasten.service` has started once, the systemd command locks nothing. install.sh, and `kasten-unlock-passphrase` before the first boot is done, mount the volume without `kasten-unlock.service`. So if `systemctl is-active kasten-unlock.service` prints `inactive` while `mountpoint /var/lib/kasten` reports a mount point, also run `kasten-unlock stop`.

Every unlock and lock writes one `event=` line to the journal. Read them with `journalctl -t kasten-unlock`. A failed unlock keeps Stalwart stopped, so the Mail API and Inbound SMTP monitors alert. An unexpected unlock can mean that someone booted a copy of the server. The VPS's own journal cannot show a booted copy, because the copy writes to its own journal. Review the Kuma event history and the Tang host's `journalctl -u 'tangd@*'` against planned reboots. Configure the event hooks and existing Kuma alert routes in the [observer guide](../deploy/observer/README.md); acknowledge and rearm after reviewing an expected event. A failed unlock cannot read an event URL stored inside LUKS, so off-host availability and Tang-side events cover that case.

Logs stay in RAM only, and a reboot erases them. This includes the reports of the check and the backup. Before a planned reboot, read what you still need.

**Before a planned reboot:**

1. Check that last night's backup succeeded: `journalctl -t kasten-backup` shows its `backup complete`.
2. As root, run `kasten-bind-tang <bound Tang URL> <thumbprint>`. With a URL that is already bound, it only asks Tang for the slot's key and tests it against the LUKS header, unlocking nothing. It must print `slot N unlocks through <url>`. This is a Tang access, so the Tang event monitor goes down: acknowledge it as in the [observer guide](../deploy/observer/README.md#unlock-and-tang-access-events-existing-kuma). If the check fails, reboot only when someone with the recovery passphrase is available.
3. Run `df -h / /var/lib /home`. At least 3 GiB must be free, as in [weekly check 6](#weekly-checks).
4. Run `dnf5 needs-restarting`. It lists the installed updates, such as a new kernel or systemd, that take effect only at this reboot, or prints `Reboot should not be necessary.` when none wait for it.
5. Reboot.
6. Run `swapon --show=NAME --noheadings`. Every line it prints must name a `/dev/zram` device. If step 4 listed updates, run `dnf5 needs-restarting` again: it must now print `Reboot should not be necessary.`
7. Check that `systemctl status kasten.service` shows the unit active. If it does not, read the mail server's log: `journalctl CONTAINER_NAME=kasten-mail`.
8. Run the aggregate key-check observer on the Mac and send yourself a test message.

## Lost devices

1. Sign the lost device out. First list the account's app passwords and API keys: `kasten-cli app-password list --account you@example.com --config /etc/kasten/kasten.json`. `OTHER` marks those that Kasten did not create. Then run `kasten-cli lock --account you@example.com --revoke-others --config /etc/kasten/kasten.json` again. With the key set unchanged, it needs no `--user-fingerprint`. It destroys every grant of the app's OAuth client in that account, so every app session of the account ends at once, including the lost device's. It also destroys every app password and API key that Kasten did not create. The local dev-stack proof of `--revoke-others`, `tests/integration/cli-keys-lock.test.ts`, passed on 4 November 2026. The lost device's notifications do not end with its session: see step 4. You sign in again on your other devices.
2. Change your mail password, in case the device saved it: see [Key and credential rotation](#key-and-credential-rotation). In Stalwart v1.0.1's source, every token carries a version derived from the account's password, and Stalwart refuses a token with an older version. So a password change also ends every app session. This was read in the source, not tested. The password change keeps the account's app passwords and API keys, so `--revoke-others` in step 1 is what removes unknown ones.
3. If the lost device held your authenticator app, replace the sign-in code key. Step 1 must come first, while codes are still on: `kasten-cli lock` refuses an account without sign-in codes. Then turn the old key off and write a new one:

   ```sh
   kasten-cli user mfa reset you@example.com --config /etc/kasten/kasten.json
   kasten-cli user mfa new you@example.com --out /etc/kasten/state/you.otpauth --config /etc/kasten/kasten.json
   ```

   At once, add the key in `/var/lib/kasten/cli/state/you.otpauth` to the authenticator app on the replacement device. Then pipe the app's current code into `enrol`, with the password file from step 2:

   ```sh
   echo <code> | kasten-cli user mfa enrol you@example.com --otp-url-file /etc/kasten/state/you.otpauth --password-file /etc/kasten/<file> --config /etc/kasten/kasten.json
   ```

   Between `reset` and `enrol`, the password alone signs in and can change the key set, so keep that window short. `enrol` removes the key file once the code works. The next steps sign in with the new code. The local dev-stack proof of the `user mfa` commands, `tests/integration/cli-user-mfa.test.ts`, passed on 4 November 2026.

4. Stop the lost device's notifications. On one of your other devices, sign in again, open **Settings** > **Notifications** and choose **Stop notifications on other devices**. If you have no other device, do this on the replacement device after step 5. Until then, the lost device can keep showing the sender and subject of new mail for up to 7 days. `kasten-cli lock` and a password change end its sign-in, but not its push subscription, and the admin API cannot reach push subscriptions. After step 1, the lost device cannot subscribe again, because its sign-in has ended. Your other devices subscribe again the next time Kasten opens there. This has not yet been tested on a real phone.
5. On the replacement device, open the app, sign in and unlock with a passkey or your recovery code. Without them, restore your key from the recovery sheet.
6. If the lost device was a security key, or held a passkey that only it had, remove that passkey in **Settings** > **Your key** on another device.

Signing out does not change your key. The lost device's copy of your key stays protected by the device's own lock and by what unlocks the app: your recovery code or passphrase, or a passkey. A removed passkey still opens the key wherever a copy of its record survives ([the key on the server](security.md#the-key-on-the-server)). If you think someone has both the device and a way to unlock it, [rotate your mail key](#rotate-your-mail-key).

## Key and credential rotation

Rotate a secret when it might be exposed, for example after it reached a chat or a log, or when a person or agent loses access.

| Secret              | How to rotate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your mail key       | See [Rotate your mail key](#rotate-your-mail-key)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Operator key        | Not yet tested. Replace the file that `operatorPublicKeyFile` names as `kasten`, as in [How to run the commands on this page](#how-to-run-the-commands-on-this-page), and the app's `KASTEN_OPERATOR_KEYS_FILE`, then redeploy the app. For each account, run `kasten-cli keys set` with the user's public key file, then `kasten-cli lock --account <email> --user-fingerprint "<fingerprint on the account's current recovery sheet>"`. The key ids change, so each lock needs the fingerprint. Then copy the new `/var/lib/kasten/cli/state/lock.json` to your private configuration directory and to every machine that runs `check`: only this file holds the earlier key sets. Old mail stays readable with the old operator key until you delete it. The daily check accepts the old mail as encrypted to an earlier key set, as after a mail key rotation                                                                                                                                                                                                                                                                                                                                                                                                                |
| Mail login password | Write the new password into a file in `/var/lib/kasten/cli` as `kasten`, as in [How to run the commands on this page](#how-to-run-the-commands-on-this-page). Run `kasten-cli user password you@example.com --password-file /etc/kasten/<file> --config /etc/kasten/kasten.json`. It keeps the account's app passwords, API keys and MFA. By Stalwart's source, it also ends every app session (not tested). It removes no unknown app password or API key: `kasten-cli lock --revoke-others` does, as in [Lost devices](#lost-devices)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Reader credential   | On the VPS, run `kasten-cli reader rotate --account you@example.com --config /etc/kasten/kasten.json`. It creates and proves a new read-only reader, writes it over `/var/lib/kasten/cli/state/reader-you@example.com.secret`, then destroys every earlier reader app password, with readback. Then replace every other copy, such as `reader.secret` on the operator's computer and the Mac observer's copy, with the new file, for example with `scp -p` as in [Reading mail](agent-setup.md#reading-mail). To revoke a reader without a replacement, run `kasten-cli app-password list --account you@example.com --config /etc/kasten/kasten.json`, then `kasten-cli app-password delete --account you@example.com --id <id> --config /etc/kasten/kasten.json`. The live rotate case in `tests/integration/cli-check.test.ts` passed on 4 November 2026                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Import app password | Run `kasten-cli app-password delete --account you@example.com --id <id> --config /etc/kasten/kasten.json`. `app-password create` prints the id, and `kasten-cli app-password list` shows it. If another import is needed, create a new one with `kasten-cli app-password create --account you@example.com --purpose import --out /etc/kasten/state/import-app-password --config /etc/kasten/kasten.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Admin API key       | See [Rotate the admin API key](#rotate-the-admin-api-key)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SES SMTP credential | In the IAM console, create a second access key for the SMTP user. Take the new key's ID from the console, not from the AWS guide's `list-access-keys` command: with two keys, that command can print the old key's ID. Write the new access key ID into the file that `relays[].usernameFile` names, as `kasten`, as in [How to run the commands on this page](#how-to-run-the-commands-on-this-page). Derive the new SMTP password into a new file: run `kasten-cli aws smtp-password --region <region> --out /etc/kasten/state/ses-smtp-password.new < <new secret>`, or pipe the secret over SSH as in [the AWS guide](aws-ses.md). `--out` refuses an existing file, so it cannot replace the old password file, and the command never prints the password. On the VPS, move the new file over the one that `relays[].passwordFile` names, as `kasten`, for example `setpriv --reuid=kasten --regid=kasten --init-groups mv /var/lib/kasten/cli/state/ses-smtp-password.new /var/lib/kasten/cli/ses-smtp-password`. The CLI wrote the new file as the `kasten` user, so it already has the right owner. Run `kasten-cli setup`. If it fails, fix the cause and run it again until it succeeds; each run reloads the stored settings. Send a test message. Delete the old key |
| restic password     | On a machine with restic and a bucket key that can write, run `restic key add --new-password-file <file>`. Replace `/var/lib/kasten/data/secrets/restic-password` on the VPS with the new password, with the owner `KASTEN_MAIL_UID` and mode `0600`, as in [Configure it](#configure-it). Run `systemctl start kasten-backup.service`. Then, with the new password, run `restic key list` and `restic key remove <old key id>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Bucket key          | Create a new key. Write `/var/lib/kasten/data/secrets/restic-backend.env` again with its new lines, as the mail server's user, as in [Configure it](#configure-it). Run `systemctl start kasten-backup.service`, then delete the old key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| LUKS passphrase     | Run `cryptsetup luksAddKey --pbkdf argon2id --pbkdf-memory 262144 --pbkdf-parallel 1 --pbkdf-force-iterations 4 "$(kasten-unlock attach)"`: install.sh uses these settings, so that unlocking works with 1 GB of RAM. Test the new passphrase with `cryptsetup open --test-passphrase "$(kasten-unlock attach)"`. Then run `cryptsetup luksRemoveKey "$(kasten-unlock attach)"` with the old one. Leave the Clevis slot alone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Tang keys           | Follow [key rotation](../deploy/tang/README.md#key-rotation) in the Tang guide. Not yet tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Kuma push URLs      | Reset the token in Kuma. Update the file that holds it: `kumaPushUrlFile`, `probe.kumaPushUrlFile`, `KASTEN_PUSH_URL` in `backup.env`, the file that `KASTEN_UNLOCK_PUSH_URL_FILE` names, or `/etc/kasten/tang-push-url` on the Tang host                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Save every new secret in your password manager before you delete the old one.

### Rotate your mail key

The CLI steps passed on the local dev stack on 4 November 2026 (`tests/integration/cli-keys-lock.test.ts`: `keys set`, `lock --user-fingerprint`, then `check`). The app steps and the whole procedure have not yet run on a real server.

1. Open the app on a device that holds no key: a new device, or one where you chose **Clear this device** in Settings. Sign in.
2. The app shows "Unlock Kasten on this device" when the server keeps a copy of your key ([the key on the server](security.md#the-key-on-the-server)); do not unlock there, because that restores the old key. Otherwise it shows "Add your mail key to this device", because `kasten lock` stops the app from reading or changing keys. On either screen, choose **Make a new key** and **Create key**. Kasten makes the key's recovery code: save it in your password manager, and save the new recovery sheet, which holds it too. (**Choose my own passphrase** makes a key with a passphrase you choose instead.)
3. The app offers a passkey ("Unlock without typing"): choose **Add a passkey**, then **Use the new passkey**, so you never type the recovery code. Then it shows "Get your new key installed" with the new public key and its fingerprint. Choose **Copy request for your operator** and send it to the operator: it holds the account, the fingerprint, and one block for a root shell with the public key and the commands of step 4. The app keeps showing this screen, also after a reload, until step 5. Check the fingerprint against the new recovery sheet. **Use my existing key instead** goes back to restoring the former key from its sheet, which replaces the new key on this device.
4. The operator pastes the request's block into a root shell on the VPS. It saves the key as a file in `/var/lib/kasten/cli`, written as `kasten` as in [How to run the commands on this page](#how-to-run-the-commands-on-this-page), with `setpriv --reuid=kasten --regid=kasten --init-groups sh -c 'umask 077 && cat >/var/lib/kasten/cli/new-key.pub.asc'` and the key in a here-document. Then it runs, as the operator would by hand:

   ```sh
   kasten-cli keys set --account you@example.com --key /etc/kasten/new-key.pub.asc --config /etc/kasten/kasten.json
   kasten-cli lock --account you@example.com --user-fingerprint "<fingerprint on the new recovery sheet>" --config /etc/kasten/kasten.json
   ```

   `lock` refuses a new key set unless its user key matches this fingerprint. Take it from the sheet, never from the server.

5. In the app, choose **It's installed**, and sign in again. The app cannot check this itself, because the lock hides the key set from it. `lock` ended every app session of the account. On each other device, choose **Clear this device**, sign in, and unlock with the new key's passkey or recovery code once the server holds the new key (see below), or restore the new key from the new sheet.

Once mail encrypted to the new key has arrived, reload the app on the device that made it, or sign in or unlock there again. It then replaces the copy of the key on the server ([the key on the server](security.md#the-key-on-the-server)) and removes the former key's passkey records, so other new devices unlock with the new key's passkeys and recovery code. Devices that still hold the old key keep it until you clear them.

`keys set` replaces the key bundle, so new mail is encrypted to the new key and the operator keys. Older mail stays encrypted to the old key and the operator keys, so keep the old sheet. The app holds one key, so it shows older mail as "can't decrypt". `kasten read` can still read it with the operator key.

`lock` keeps the old set in `lock.json` as an earlier set, with the time Stalwart created the new bundle (`replacedAt`). The next check scans every message. It accepts a message encrypted to exactly the old set that arrived before that time, as the exception `earlierKeySet`. A message encrypted to the old set that arrived in that second or later is still a finding, so new mail must use the new set. A Sent copy counts by the date that the sending device chose: a copy encrypted to the old set and dated before the change is accepted. A device encrypts Sent copies to the key it holds and the operator keys in `/config.json`, not to a bundle it reads from the server. The device that made the new key uses the new set. Every other device uses the old set until you clear it and restore the new sheet (step 5). `lock` refuses a key change it cannot date.

Copy the new `/var/lib/kasten/cli/state/lock.json` to your private configuration directory, and to every machine that runs `check`. Only this file holds the earlier set, and [Restore after host loss](#restore-after-host-loss) needs it.

### Rotate the admin API key

No tested procedure exists yet. The code supports this path: when the key file is missing, `kasten setup --bootstrap` destroys the old `kasten admin api key` and writes a new one. `kasten-bootstrap` was written for the first boot, and this second use has not been run. The bootstrap never creates or changes the ACME provider, so the offline run leaves the existing certificates alone. On a volume that already has a database, `kasten-bootstrap` creates no unfinished-first-boot marker.

1. Run `systemctl stop kasten.service`. Mail stays stopped until step 4.
2. Move the key file that `admin.apiKeyFile` names off the CLI directory, but keep it on the encrypted volume: `mv /var/lib/kasten/cli/admin-api-key /var/lib/kasten/secrets/admin-api-key.old`.
3. Run `kasten-bootstrap`. It runs `kasten setup --bootstrap` against recovery mode, without any network, and writes the new key to `/var/lib/kasten/cli/admin-api-key`.
4. Run `systemctl start kasten.service`, then `kasten-cli setup --config /etc/kasten/kasten.json`. Setup must succeed with the new key and report `0 changed`.
5. Delete `/var/lib/kasten/secrets/admin-api-key.old`.

If step 3 fails, read its output first. Recovery mode's own log is `journalctl CONTAINER_NAME=kasten-recovery`. If it printed `destroyed ... admin API key(s)`, the old key no longer exists on the server: do not move the old file back. Fix the cause and run `kasten-bootstrap` again; it keeps a key file it already wrote, or creates a new key if the file is missing. Move the old file back only when the output has no `destroyed` line.

## Remove a pilot domain

`kasten setup` never destroys a domain or an account. After the pilot overlap, remove the pilot domain with these steps. They have not yet run on a real VPS. Their local dev-stack proof, `tests/integration/cli-domain-remove.test.ts`, passed on 4 November 2026.

1. Remove the domain and every address in it from `kasten.json`: its `domains` entry, the users and aliases in it, its `relays` entry, and its entry in `dns.sesDkimTokens`. If `probe` names an account in the pilot domain, change `probe` to an account in another domain.
2. Run `kasten-cli setup --config /etc/kasten/kasten.json`. It removes the aliases in the pilot domain and the domain's SES relay route.
3. Run `kasten-cli domain remove pilot.example.com --config /etc/kasten/kasten.json`. It lists the domain's accounts, mailing lists and DKIM keys, and changes nothing yet. Check the list. The command refuses while `kasten.json` still lists the domain, while the domain is the server's default domain, while an account in another domain has an alias in it, and when an account in it holds the Admin role.
4. Run the same command again with `--yes`. It destroys the listed accounts with all their mail, the mailing lists, the DKIM keys and then the domain, and reads back that they are gone.
5. Remove the pilot domain's DNS records and its SES identity. The CLI does not touch them.

Mail that arrived through aliases of accounts in other domains stays in those accounts.

## Moving to another host

This move has not been tested.

1. Install the new host with [the install guide](install-vps.md), up to and including `kasten-mail-run init`. Set the new volume ID as `KASTEN_VOLUME_ID` in `/opt/kasten/.env`. Do not run `kasten-bootstrap`: the restore brings the old configuration, including the admin API key.
2. Lower the TTL of the `mx.` and `mail.` A and AAAA records to 300 seconds, one day ahead.
3. On the old host, stop mail and keep it stopped at the next boot: `systemctl disable --now kasten.service kasten-backup.timer kasten-check.timer kasten-probe.timer`, then `systemctl disable kasten-unlock.service`. Disable the unlock too, without `--now`, because step 4 needs the mounted volume: after an unlock at boot, `kasten-unlock.service` starts `kasten.service` even when that unit is disabled. Senders queue mail and retry.
4. On the old host, run a final backup with the mail service stopped:

   ```sh
   set -a; . /var/lib/kasten/secrets/backup.env; set +a
   kasten-mail-run backup
   ```

5. Copy the host secrets, the CLI directory and the two restic files to the new host, with their modes. For example, from your computer:

   ```sh
   ssh root@<old vps> tar -C /var/lib/kasten -cf - secrets cli data/secrets/restic-password data/secrets/restic-backend.env \
     | ssh root@<new vps> tar -C /var/lib/kasten -xpf -
   ```

   Then, on the new host, give the files the new host's owners. `KASTEN_MAIL_UID` depends on each host's subordinate IDs, so the old host's value may not fit:

   ```sh
   chown -R kasten:kasten /var/lib/kasten/cli && chmod -R go= /var/lib/kasten/cli
   . /etc/kasten/host.env
   chown "$KASTEN_MAIL_UID:$KASTEN_MAIL_UID" /var/lib/kasten/data/secrets/restic-password /var/lib/kasten/data/secrets/restic-backend.env
   ```

6. On the new host, restore the final snapshot, as in [Restore for real](#restore-for-real), steps 1 to 3.
7. On the new host, run `kasten-cli setup --config /etc/kasten/kasten.json`. It must report `0 changed`.
8. Point the `mx.` and `mail.` A and AAAA records at the new host. The MX record itself does not change. Update `dns.ipv4` and `dns.ipv6` in `kasten.json`.
9. Run a full check of every account: `kasten-cli check --full --config /etc/kasten/kasten.json`. Then run the security check from your computer, as in [the install guide](install-vps.md#12-run-the-security-check), and the [acceptance checks](#acceptance-on-the-real-server).
10. Bind the new disk to Tang, if you use it.
11. When the new host has run for a few days, erase the old host's encrypted disk and cancel it.

SES is not affected by the move, because the server sends through SES and not from its own IP.

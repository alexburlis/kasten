# Off-host checks

Use a separate host for delivery probes and a trusted administration machine for key checks. The mail-host installer enables its nightly backup. Set up off-host check schedules on the machines that run them.

## Key-set and stored-message check: Mac

Keep a private directory on the Mac with `kasten.json`, the pinned `state/lock.json`, the account's reader credential and the protected files its configuration names. Copy the pin established at setup, rather than silently accepting a newly read key set. Use the mail API over HTTPS for reader access and the existing private administration route for the IP-restricted admin API. Keep the operator private key on its existing protected reader route; never copy it to the mail VPS.

The existing authorized SSH route forwards the private administration listener. Keep that tunnel alive for the check, and point this Mac-only configuration's `admin.apiUrl` at `http://127.0.0.1:18080`:

```sh
ssh -N -L 127.0.0.1:18080:127.0.0.1:8080 root@<pico-tailnet-name>
```

From the repository root, run this command after import, after each upgrade and on a daily schedule. `--url` selects the public HTTPS reader endpoint. Admin requests use the private tunnel:

```sh
/bin/sh "$PWD"/deploy/observer/check-from-mac.sh \
  "$PWD" "$HOME/.config/kasten/kasten.json" \
  --url https://mail.example.com
```

It calls the existing aggregate `kasten check` once, checking every non-probe user and pushing the combined result once. Put reviewed exceptions for this route in a file in the private directory, and name it in `checkExceptionsFile` in the private `kasten.json`; a relative name refers to that directory. The command above then needs no `--exceptions` argument. After `reader rotate` on the mail host, replace the reader copy in the private directory with the new reader file. Use the Uptime Kuma safety monitor with a seven-day offline allowance. Configuring a live BB route or a real monitor is a later authorized operation. An offline Mac is not a completed check.

## Delivery probe: separate host

Use only the dedicated probe login and its own Kuma push URL on the observer host. No SES credential, mail-host administrator key, operator private key or human mail password belongs in this observer directory.

1. Load the verified CLI image on the observer host. Install this directory's Compose file at `/opt/kasten-observer/compose.yaml` and set its `.env` to `KASTEN_VERSION=<verified tag>`. Keep the image available until you upgrade the observer.
2. Create root-only `/var/lib/kasten-observer` and `state/` (0700). Put a copy of the public configuration at `kasten.json`, the public operator key and the probe password/push URL files (0600) in it. Keep the `relays` credential paths and `admin.apiKeyFile` as configuration references only; do not copy those secret files. `probe` reads neither relay credentials nor the admin key.
3. Set `admin.apiUrl` in this observer-only configuration to the public HTTPS mail API. The probe authenticates as its own account. It does not call the administrator API. Set `stateDir` to `/etc/kasten/state` if an explicit state directory is present.
4. Use the probe account for the pilot domain after its MX points to the pilot host. Run `docker compose run --rm -T probe` in `/opt/kasten-observer`. Verify both relay acceptance and JMAP arrival before enabling the timer.
5. After final MX cutover, switch to the probe account for the production domain. Give it a fresh state directory and verify the new round trip. Keep the old state as the record of the pilot.

The timer has no dependency on the mailbox's systemd service. Failure or loss of the mailbox therefore cannot prevent the observer host from attempting the check. A 25-hour missing heartbeat and a failed probe report use the Uptime Kuma notification route to an independent inbox.

## Unlock and Tang access events: Uptime Kuma

Use an Uptime Kuma **Push** monitor attached to an independent notification route for each event source; there is no special event monitor type. Hooks default to sending **DOWN for every event**, including a successful unlock. After reviewing an event, acknowledge it with the command below. Repeated events while down do not create an up/down alert loop. A normal Push monitor also goes down when its heartbeat expires: silence is not automatically healthy, and these hooks do not supply periodic heartbeats. Keep the independent API/SMTP availability monitors for outages.

Kuma's inverted/upside-down Push behavior must be tested on the installed version before claiming event-only alerts: the required proof is event → alert → recovery at expiry, with no-event silence healthy. No installed Kuma source was available to prove that behavior locally. `KASTEN_EVENT_PUSH_STATUS` is configurable (`up` or `down`) to support the verified semantics. Set it in `/etc/kasten/host.env` on the mail host, or root-owned `/etc/kasten/tang-event.env` on Tang. The personal deployment's exact monitor mode, timeout and recovery behavior remain a real-Kuma acceptance gate; do not enable a default heartbeat monitor and claim it is an event detector.

For the mail host, store its event monitor URL in `/var/lib/kasten/secrets/unlock-push-url`, root-owned, 0600, inside LUKS. Set this non-secret path in `/etc/kasten/host.env`:

```sh
KASTEN_UNLOCK_PUSH_URL_FILE=/var/lib/kasten/secrets/unlock-push-url
```

Successful unlocks push after the volume is mounted. An unlock that fails while the disk is locked cannot read this file: it logs the failure, and the independent API/SMTP monitors detect the outage. Monitoring failure is visible in the journal and never prevents a successfully mounted mailbox from starting. Every unlock event is recorded; this does not distinguish an attacker from a legitimate reboot or promise clone detection.

For Tang on the observer host, install `deploy/host/kasten-push` as `/usr/local/sbin/kasten-push`, `deploy/tang/kasten-tang-event` as `/usr/local/sbin/kasten-tang-event` (0755), and its `tangd@.service.d/kasten.conf` drop-in. Install `curl` and `jq` if absent. Store its existing monitor URL in `/etc/kasten/tang-push-url`, root-owned, 0600. Reload systemd; no app-host reboot or proxy restart is needed. The hook reports each Tang socket activation with metadata only, including advertisement/key access; it never copies response payloads or keys. A host-root attacker can suppress these events.

After a planned event is verified, rearm its existing monitor using its protected file:

```sh
KASTEN_PUSH_URL_FILE=/var/lib/kasten/secrets/unlock-push-url \
  KASTEN_PUSH_STATUS=up KASTEN_PUSH_MESSAGE='acknowledged after review' \
  /bin/sh /usr/local/sbin/kasten-push
```

For Tang, substitute `/etc/kasten/tang-push-url`. The URL never enters arguments or output. Only a configured push failure emits a generic error; `{ok:false}`, an HTTP error or non-JSON success is refused. Validate the actual monitor's status/expiry/rearm behavior before enabling these hooks; no monitor or provider is provisioned by these files.

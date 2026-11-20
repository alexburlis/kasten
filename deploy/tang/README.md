# Tang on a second host

[Tang](https://github.com/latchset/tang) lets the mail VPS unlock its encrypted disk at boot without you. It runs on another always-on machine, for example the host that serves the web app. Only the mail VPS can reach it, and only over the tailnet.

Without Tang, the disk stays locked after each reboot until you run `kasten-unlock-passphrase` on the VPS.

## Files

| File                           | Installed as                                       | Does                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tangd.socket.d/kasten.conf`   | `/etc/systemd/system/tangd.socket.d/kasten.conf`   | Tang listens only on the tailnet address, on a port other than 80, after tailscaled                                                                         |
| `kasten-tang.nft`              | `/etc/kasten/kasten-tang.nft`                      | Drops packets to Tang's port from every address except the mail VPS. Loading it again replaces only its own table, on any nftables version                  |
| `kasten-tang-firewall.service` | `/etc/systemd/system/kasten-tang-firewall.service` | Loads that table before Tang starts. Tang does not start without it                                                                                         |
| `kasten-tang-event`            | `/usr/local/sbin/kasten-tang-event` (0755)         | After each Tang socket activation, reports event metadata only to an existing Kuma event monitor                                                            |
| `tangd@.service.d/kasten.conf` | `/etc/systemd/system/tangd@.service.d/kasten.conf` | Runs kasten-tang-event as `ExecStartPost` of every `tangd@` instance. A monitoring failure only logs `event=monitoring result=failed` and never blocks Tang |
| `../host/kasten-push`          | `/usr/local/sbin/kasten-push` (0755)               | Sends kasten-tang-event's push. curl reads the URL from stdin, and a reply without `{"ok":true}` is refused                                                 |

The socket drop-in sets `DefaultDependencies=no`. Debian orders `tangd.socket` before `sockets.target`, and `tailscaled.service` comes after it. With the default dependencies, ordering Tang after tailscaled makes a cycle, and systemd then drops Tang from the boot. `FreeBind=yes` lets Tang bind the tailnet address before `tailscale0` has it.

## Install

Run these as root on the Tang host, from a copy of this directory. The host needs systemd and Tailscale.

1. Install the packages: `apt install tang nftables`.
2. Do not enable `nftables.service` on a host that runs Docker. Debian's default `/etc/nftables.conf` starts with `flush ruleset`, which deletes Docker's and Tailscale's rules.
3. Choose a free port. The examples use 7500. `ss -ltn | grep ':7500 '` must print nothing.
4. Install the files and start Tang:

   ```sh
   TS_IP=$(tailscale ip -4)       # this host's tailnet address
   VPS_IP=100.64.0.2              # the mail VPS: run "tailscale ip -4" on it
   PORT=7500
   install -d /etc/systemd/system/tangd.socket.d /etc/kasten
   sed -e "s/@TAILNET_IP@/$TS_IP/" -e "s/@PORT@/$PORT/" tangd.socket.d/kasten.conf \
     >/etc/systemd/system/tangd.socket.d/kasten.conf
   sed -e "s/@VPS_TAILNET_IP@/$VPS_IP/" -e "s/@PORT@/$PORT/" kasten-tang.nft >/etc/kasten/kasten-tang.nft
   install -m 0644 kasten-tang-firewall.service /etc/systemd/system/
   [ -n "$(ls /var/lib/tang)" ] || /usr/libexec/tangd-keygen /var/lib/tang
   systemctl daemon-reload
   systemctl enable --now kasten-tang-firewall.service
   systemctl enable tangd.socket
   systemctl restart tangd.socket
   ```

5. Check that Tang listens only on the tailnet address: `ss -ltn | grep ":$PORT "` shows `$TS_IP:$PORT` and nothing else.
6. In the Tailscale access policy, allow the mail VPS to reach this host on `tcp:$PORT`, and no other device. The host firewall drops every other source anyway, the Tang host itself included.
7. Print the thumbprint of Tang's signing key:

   ```sh
   for k in /var/lib/tang/*.jwk; do if jose jwk use -i "$k" -r -u verify; then jose jwk thp -i "$k" -a S256; fi; done
   ```

8. On the mail VPS, bind the disk with that thumbprint pinned. The shell variables of step 4 exist only on the Tang host, so type their values: the address that `tailscale ip -4` printed on the Tang host, the port, and the thumbprint from step 7. The command reads the recovery passphrase from the terminal, or from the first line of standard input:

   ```sh
   kasten-bind-tang "http://<tang-tailnet-ip>:7500" <thumbprint>
   ```

   It adds one Clevis key slot, then asks Tang for that slot's key and tests it. The passphrase slot stays.

9. Reboot the VPS. `journalctl -t kasten-unlock -g '^event='` must show `event=unlock result=ok method=tang`.
10. Optional: report each Tang access to an existing Kuma event monitor. First read [observer setup](../observer/README.md#unlock-and-tang-access-events-existing-kuma): it says how that monitor must behave. This step also needs `deploy/host/kasten-push`, so run it in `tang/` of a copy of the whole `deploy/` directory:

    ```sh
    apt install curl jq
    install -m 0755 ../host/kasten-push /usr/local/sbin/kasten-push
    install -m 0755 kasten-tang-event /usr/local/sbin/kasten-tang-event
    install -d /etc/systemd/system/tangd@.service.d
    install -m 0644 tangd@.service.d/kasten.conf /etc/systemd/system/tangd@.service.d/
    ```

    Put the monitor's push URL on the first line of `/etc/kasten/tang-push-url`, owner root, mode 0600. Without that file, the hook sends nothing. To choose the status that each push sends, set `KASTEN_EVENT_PUSH_STATUS=up` or `down` (the default) in the root-owned file `/etc/kasten/tang-event.env`. Then run `systemctl daemon-reload`. `deploy/test/run.sh` does not install the hook, and the hook is not yet tested on a real Tang host. `deploy/test/host.test.py` runs `kasten-tang-event` against a local stand-in.

Tang serves plain HTTP. The tailnet encrypts the connection, and Clevis checks the advertisement against the pinned thumbprint.

## Review Tang access

Each request starts one `tangd@<n>-<local>:<port>-<peer>:<port>.service` instance. On the Tang host, `journalctl -u 'tangd@*'` lists them with timestamps. Compare them with planned VPS reboots and binds. Only the Tang host and the off-host Kuma history can witness a booted copy's unlock; the VPS's own RAM journal cannot.

## Back up the keys

Losing Tang's keys means that the disk no longer unlocks by itself. The passphrase still works. Keep a copy of the keys away from both hosts, for example as a file in your password manager.

```sh
umask 077
tar --numeric-owner -C /var/lib/tang -czf /root/tang-keys.tar.gz .
```

Store `/root/tang-keys.tar.gz` in your password manager, then delete the local file. Never delete keys that a bound disk still uses.

## Restore the keys

Use this on a rebuilt host, or after the key directory was lost. Tang creates new keys on its first request to an empty directory, so restore before the VPS reconnects.

```sh
systemctl stop tangd.socket
rm -f /var/lib/tang/*.jwk
tar -C /var/lib/tang -xzf tang-keys.tar.gz
chown -R _tang:_tang /var/lib/tang
systemctl start tangd.socket
```

Then, on the VPS, run `kasten-bind-tang <same URL> <thumbprint>`, with the thumbprint of the restored keys. The URL is already bound, so it only checks the slot. It prints `slot N unlocks through <url>` when Tang answers with the restored keys.

## A new tailnet address

If the Tang host gets a new tailnet address, render the socket drop-in again on the Tang host, from a copy of this directory, and check that Tang listens there:

```sh
TS_IP=$(tailscale ip -4)
PORT=7500
sed -e "s/@TAILNET_IP@/$TS_IP/" -e "s/@PORT@/$PORT/" tangd.socket.d/kasten.conf \
  >/etc/systemd/system/tangd.socket.d/kasten.conf
systemctl daemon-reload
systemctl restart tangd.socket
ss -ltn | grep ":$PORT "
```

Then, on the VPS, bind the new URL with `kasten-bind-tang "http://<new tang-tailnet-ip>:7500" <thumbprint>`. Then remove the old slot: `clevis luks unbind -d "$(kasten-unlock attach)" -s <old slot>`. `clevis luks list -d "$(kasten-unlock attach)"` shows the slots.

If the mail VPS gets a new tailnet address, for example after a [restore after host loss](../../docs/operations.md#restore-after-host-loss), render the firewall table again on the Tang host and load it:

```sh
VPS_IP=100.64.0.2              # the mail VPS's new address: run "tailscale ip -4" on it
PORT=7500
sed -e "s/@VPS_TAILNET_IP@/$VPS_IP/" -e "s/@PORT@/$PORT/" kasten-tang.nft >/etc/kasten/kasten-tang.nft
nft -f /etc/kasten/kasten-tang.nft
```

`nft -f` replaces the table in one step, so the old rules stay until the new ones are in. A restart of `kasten-tang-firewall.service` would first delete the table.

Also allow the new address in the Tailscale access policy, and remove the old one. These steps have not yet been tested.

## Key rotation

Not tested in `deploy/test/run.sh`. `/usr/libexec/tangd-rotate-keys -d /var/lib/tang` creates new keys and hides the old ones, which still answer existing bindings. Then run `clevis luks regen -d "$(kasten-unlock attach)" -s <slot>` on the VPS. Delete the hidden `.*.jwk` files only after that, and back up the new keys.

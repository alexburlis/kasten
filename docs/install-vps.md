# Install Kasten on a VPS

This guide is the manual path, from choosing a VPS to moving your mail in. To let a coding agent do most of it, read [agent setup](agent-setup.md) first; the agent follows the same steps. [`deploy/README.md`](../deploy/README.md) is the short reference for the host files.

A Fedora 45 amd64 pilot has exercised first boot, real SMTP and SES delivery, and a backup restore rehearsal. The [operations guide](operations.md#measured-on-the-hetzner-rehearsal-server-11-november-2026) records the measured limits. The local Fedora arm64 [acceptance stages](../deploy/README.md#the-acceptance-test) exercised the installer, reboot, SELinux, and recovery in separate test environments.

## Before you start

You need:

- a domain whose DNS records you can edit;
- a password manager;
- an SSH key pair on your computer, for example from `ssh-keygen -t ed25519`;
- Docker with Compose v2, Git and this repository on your computer. Docker builds the images there; the VPS runs them with Podman and has no Docker;
- Node.js 24 and pnpm on your computer, for the security check and the mail import;
- GnuPG on your computer, for the operator key;
- a [Tailscale](https://tailscale.com) account, for private admin access;
- a machine outside the VPS provider's network that can open outgoing TCP port 25, for the port-25 test in section 3. Many home connections cannot;
- an HTTPS host for the web app, on a machine other than the mail VPS;
- a bucket for backups, for example at Backblaze B2;
- optionally, a second always-on machine for [Tang](https://github.com/latchset/tang), so the disk unlocks itself after a reboot.

Start [the AWS guide](aws-ses.md) on the first day. AWS reviews the SES production request by hand, and you cannot send until it agrees.

Choose the host names now. This guide uses `mx.example.com` for the MX host, `mail.example.com` for the mail API (JMAP and sign-in) and `app.example.com` for the web app. The first two become `serverHostname` and `mailApiHostname` in `kasten.json`.

How to run the commands in this guide:

| You see                                                 | Where it runs                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kasten-cli <command> --config /etc/kasten/kasten.json` | The Kasten CLI, on the VPS, as root, from any directory. Each run starts a new, temporary container. The container sees `/var/lib/kasten/cli` read-only as `/etc/kasten`, and `/var/lib/kasten/cli/state` writable as `/etc/kasten/state`. It always passes standard input on, so a pipe needs no extra option |
| `kasten-mail-run <command>`                             | The server image's own tool, `kasten-server`, on the VPS, as root, from any directory, in a new, temporary mail container, while Stalwart is stopped. While Stalwart runs, use `kasten-mail-exec <command>`: it runs `kasten-server <command>` inside the running mail container, `kasten-mail`                |
| `node cli/src/main.ts <command>`                        | The Kasten CLI on your computer, from this repository, after `pnpm install --frozen-lockfile --filter "@kasten/cli..."`                                                                                                                                                                                        |
| `./kasten <command>`                                    | The local dev stack only. It refuses to run without `.kasten-dev/kasten.json`. Do not use it for the VPS                                                                                                                                                                                                       |

## 1. Choose a VPS

| Requirement      | Pilot starting point                 | Why                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory           | 4 GB                                 | This was the real pilot's advertised host size. The 1 GiB results below are from local VMs and simulations.                                                                                                                           |
| CPU              | 2 vCPU                               | The real pilot used this size. Measure on your host before moving primary mail.                                                                                                                                                       |
| Disk             | 20 GB; 30 GB recommended             | Stored mail takes about 1.4 times its raw size. The OS, Podman images and restic's temporary files need room too                                                                                                                      |
| Virtualisation   | Full virtualisation, for example KVM | The encrypted disk needs your own kernel. Container-based VPSs cannot run LUKS                                                                                                                                                        |
| Inbound TCP 25   | Allowed                              | Other mail servers deliver to you on port 25                                                                                                                                                                                          |
| Outbound TCP 25  | Not needed                           | Kasten sends through SES on port 587, and its firewall blocks outgoing port 25                                                                                                                                                        |
| IPv4             | One public static address            | Many mail servers still connect only over IPv4                                                                                                                                                                                        |
| IPv6             | Recommended                          | Large providers prefer IPv6 when an AAAA record exists                                                                                                                                                                                |
| Operating system | Fedora 45, with SELinux enforcing    | The host files in `deploy/` target Fedora 45. `install.sh` also accepts Fedora 44. It refuses to run unless SELinux enforces its targeted policy: the containers' SELinux levels keep the mail server away from the CLI's credentials |

On 6 November 2026, the Lima stage `deploy/test/lima/f45.sh` ran mail, a `dnf5-automatic` run that changed 94 packages, `tailscaled` (not signed in) and `kasten-cli check --full` in a loop, at the same time, in a VM with 1 GiB of memory and a two-message test mailbox. In four such runs, the lowest `MemAvailable` was 159 to 173 MiB. The acceptance run's line is 150 MiB, so this is close: the real server, with a real mailbox and a signed-in `tailscaled`, will be at the line or below it. There was no OOM kill, every check passed, and mail stayed healthy without a restart. A memory cap on the update run did not raise the minimum, as in [Fedora updates](operations.md#fedora-updates-and-the-web-app). The real 1 GB server is not yet measured: the [acceptance run](operations.md#acceptance-on-the-real-server) measures it. If it fails there, the larger plan below is the remedy, and it needs the owner's approval of its cost.

Estimate the disk you need: 1.4 times your current mailbox size, plus about 10 GB. A 5.8 GB mailbox took 8.0 GB in the simulation.

Ask the provider about port 25 before you pay. Many providers block it.

The documented real-host rehearsal used a 4 GB Hetzner VPS, upgraded from its Fedora 44 image to Fedora 45.

## 2. Lock down the provider account

Do this before you install anything. Someone with your provider login can take snapshots or boot a rescue system, and with Tang that is enough to unlock the disk.

1. Turn on TOTP two-factor sign-in for the provider account. At Netcup: Customer Control Panel (CCP) > Master Data > Activate Two-factor authentication. Netcup's default sends the code by email; an authenticator app keeps working when your mail is down.
2. Protect the server control panel too. At Netcup the Server Control Panel (SCP) has its own login: SCP > Account > Settings > Account Data > Activate Two-Factor Authentication. Netcup's older "Security Access Mode", which allowed SCP access only through the CCP, was replaced by this SCP 2FA in August 2026. This is not yet checked in the live panel.
3. Remove the provider's SMTP block. At Netcup: SCP > your server > Firewall > the "netcup Mail block" policy > Delete. This policy blocks incoming and outgoing SMTP. Third-party reports say it also blocks outgoing ports 465 and 587, so SES needs it removed too. Hetzner blocks ports 25 and 465 for each account until you file a limit request, which it accepts only after a month and a paid first invoice, case by case ([Hetzner's FAQ](https://docs.hetzner.com/cloud/servers/faq/)). The block covers inbound mail too: on 6 November 2026, the Hetzner console refused an inbound firewall rule for port 25 until that request was filed. Kasten sends through SES on port 587, which Hetzner does not block, but it receives on port 25, so file the request.
4. Do not assign any other provider firewall policy. Netcup's firewall tracks connections only for TCP, so its ingress-only rules would drop the replies to DNS, NTP and Tailscale traffic. With no policy assigned, Netcup's firewall allows all traffic, and Kasten's own nftables firewall does the filtering.
5. Do not create snapshots of the server. At Netcup, snapshots exist only when you create them under SCP > Media > Snapshots. The one exception is the optional snapshot in [the Fedora release upgrade](operations.md#the-fedora-release-upgrade), and only after the owner approves its exact cost. Hetzner charges for snapshots, and Netcup's free snapshot quota is not confirmed.
6. Optionally, set the reverse DNS of the IPv4 and IPv6 addresses to `mx.example.com`. At Netcup: SCP > your server > Network > IPv4 Addresses (or IPv6 Addresses) > Reverse DNS > Save.

Sources for the Netcup steps, read on 3 November 2026: [two-factor sign-in](https://www.netcup.com/en/helpcenter/documentation/general/mfa), [SCP login](https://www.netcup.com/en/helpcenter/documentation/general/scp-login), [firewall](https://www.netcup.com/en/helpcenter/documentation/server/firewall), [media and snapshots](https://www.netcup.com/en/helpcenter/documentation/server/media), [network](https://www.netcup.com/en/helpcenter/documentation/server/network-server), [third-party port list](https://serverkueche.de/en/tutorials/netcup-firewall-setup/).

## 3. Install Fedora 45

Install Fedora 45 by your provider's route below, then follow the steps for every provider. The Hetzner route ran on 6 November 2026, on a 2-vCPU, 4 GB amd64 server; the Netcup routes are untested.

**Hetzner: the Fedora 44 image, upgraded to Fedora 45.**

1. Create the server from Hetzner's Fedora 44 image for amd64, with your SSH public key.
2. On your computer, connect: `ssh root@203.0.113.10`.
3. Update the system and reboot: `dnf5 -y upgrade --refresh && reboot`. Then connect again.
4. Upgrade to Fedora 45: `dnf5 -y system-upgrade download --releasever=45 && dnf5 -y system-upgrade reboot`. The server reboots, applies the upgrade, then boots Fedora 45. Connect again. Keep `-y` in both commands: without a terminal, dnf5 asks for confirmation, and the reboot command then exits with status 0 without a reboot. `dnf5 offline status` shows an upgrade that is still pending.
5. Check the release. `grep VERSION_ID /etc/os-release` must print `VERSION_ID=45`, and `uname -r` must print a kernel whose name contains `fc45`.
6. Remove the downloaded upgrade packages: `dnf5 system-upgrade clean`.
7. Record what `findmnt /` and `getenforce` print. On 6 November 2026, Hetzner's Fedora 44 image had an ext4 root file system on `/dev/sda1` and booted with SELinux in permissive mode, with no AVC denials. `restorecon -Rn -v /` listed 28 files to relabel: dnf's cache, `/etc/localtime` and empty directories under `/usr/local/share/man`. `restorecon -R /`, `SELINUX=enforcing` in `/etc/selinux/config` and a reboot gave `Enforcing`, with no denials, on Fedora 44 and after the upgrade to 45. The image has neither firewalld nor nftables; `install.sh` installs nftables.
8. Record what `cloud-init status --long` prints. Hetzner's image configures the network with cloud-init, which reads Hetzner's metadata service over plain HTTP, at `169.254.169.254` and `fe80::a9fe:a9fe`, at every boot, before the network starts. Kasten's firewall allows exactly that for root. After the first reboot with the firewall, in section 9, step 3, or at your first reboot without Tang, check it again: `cloud-init status --long` must print `status: done` without errors, `systemd-analyze blame | grep cloud-init` must show each cloud-init unit taking seconds, not minutes, and `ip -6 addr show scope global` must still show the server's IPv6 address. Without the firewall rule, cloud-init would wait two minutes at every boot, then fail. On 6 November 2026, with Kasten's firewall loaded at boot, cloud-init finished in 3 to 5 seconds on Hetzner, on Fedora 44 and after the upgrade to 45, and the IPv6 address stayed.

**Netcup, option A (recommended): upload the Fedora 45 Cloud image.**

1. On your computer, download `Fedora-Cloud-Base-Generic-45-1.4.x86_64.qcow2` from `https://dl.fedoraproject.org/pub/fedora/linux/releases/45/Cloud/x86_64/images/`. The file has 606,732,288 bytes.
2. Check it: `shasum -a 256 Fedora-Cloud-Base-Generic-45-1.4.x86_64.qcow2` must print `50bdc5e70f6a24f540932d15411c1c6ae9fcfa40fb990d876d83c5cc823b2ad0`. The size and the hash come from the file `Fedora-Cloud-45-1.4-x86_64-CHECKSUM` in the same directory, read on 5 November 2026.
3. Write the two files of a NoCloud seed, which gives the server your SSH key at its first boot. `meta-data`:

   ```yaml
   instance-id: kasten-1
   local-hostname: kasten
   ```

   `user-data`, with your own public key in place of the example:

   ```yaml
   #cloud-config
   disable_root: false
   ssh_pwauth: false
   ssh_authorized_keys:
     - ssh-ed25519 AAAA… you@computer
   ```

   cloud-init gives these keys to Fedora's default user, `fedora`. Because of `disable_root: false`, it gives them to root too. `ssh_pwauth: false` turns off password sign-in over SSH.

4. Build the seed ISO, with the volume label `cidata`. On a Mac: `mkdir seed && cp meta-data user-data seed/ && hdiutil makehybrid -iso -joliet -default-volume-name cidata -o seed.iso seed`. On Linux: `genisoimage -output seed.iso -volid cidata -joliet -rock user-data meta-data`, or `cloud-localds seed.iso user-data meta-data`.
5. Upload the image in the SCP: SCP > your server > Media > Images > Upload Image. Third-party reports say the SCP accepts raw, qcow and qcow2 images, through a pre-signed URL or a direct upload. This is not yet checked in the live panel.
6. Attach `seed.iso` to the server as a CD/DVD: SCP > your server > Media > DVD drive. This is not yet checked in the live panel.
7. Install the uploaded image on the server and start it.
8. On your computer, connect as root: `ssh root@203.0.113.10`. Then remove the default user, which you do not need: `userdel -r fedora`.
9. Compare the addresses that `ip addr` prints with the IPv4 and IPv6 addresses in the SCP. Netcup's network settings with this image, IPv4 by DHCP and the IPv6 /64, are not yet checked.

The Lima VM of the local tests was set up the same way, from the aarch64 build of this image, and its root partition grew to fill the disk. This image is the base of the Lima stage `deploy/test/lima/f45.sh`: a btrfs root file system, zram swap, systemd-oomd and auditd, all of which `install.sh` handles.

**Netcup, option B: install from the Fedora Server ISO.** Use `Fedora-Server-netinst-x86_64-45-1.4.iso` from `https://dl.fedoraproject.org/pub/fedora/linux/releases/45/Server/x86_64/iso/`. `shasum -a 256 Fedora-Server-netinst-x86_64-45-1.4.iso` must print `a1e916f139a05955b943cf183b020780cca9c399b02b8f5ec4354c9e5c1dff1a`. Attach it to the server as a CD/DVD, as in option A, step 6, and install over the SCP console. Choose the minimal environment, one ext4 or xfs root file system, no swap partition, and your SSH key for root. Fedora Server's defaults, such as LVM, firewalld and Cockpit, differ from the base of the local tests. `install.sh` disables and masks firewalld.

**On every provider**, then:

1. On your computer, connect: `ssh root@203.0.113.10`.
2. Update the system, and install `dnf5-plugins`, which holds the reboot check of step 3: `dnf5 -y upgrade --refresh && dnf5 -y install dnf5-plugins`.
3. Check whether a reboot is due: `dnf5 needs-restarting; echo $?`. `Reboot should not be necessary.` and exit status 0 mean none is due. Any other result means that a reboot is due or that the check failed, and its message says which; exit status 1 covers both. When a reboot is due, run `reboot` and connect again. Do not add `-C`: on Hetzner's Fedora 44 and 45, `dnf5 -C needs-restarting` stopped with `Cache-only enabled but no cache for repository "fedora"` and exit status 1, also right after `dnf5 makecache`.
4. Check SELinux: `getenforce` must print `Enforcing`. `install.sh` refuses to run otherwise.
   - If it prints `Permissive`, set `SELINUX=enforcing` in `/etc/selinux/config`, then run `reboot`. Connect again and check `getenforce` again.
   - If it prints `Disabled`, the files have no SELinux labels yet, and an enforcing boot on unlabelled files can fail. Label them in permissive mode first. If `grep -w selinux=0 /proc/cmdline` prints a line, remove that boot option with `grubby --update-kernel=ALL --remove-args=selinux`. Set `SELINUX=permissive` in `/etc/selinux/config`, run `touch /.autorelabel`, then run `reboot`: the boot labels the file system and reboots again. Connect again; `getenforce` must print `Permissive`. Then set `SELINUX=enforcing`, run `reboot`, connect again and check `getenforce` again. This is Fedora's standard route, not yet tried on a provider image.

   Hetzner's Fedora 44 image booted in permissive mode on 6 November 2026, as in Hetzner step 7. The current Netcup images are not checked.

5. Check for firewalld: `systemctl is-active firewalld`. Fedora Server runs it; the Cloud image has none. If it prints `active`, stop it for the test: `systemctl stop firewalld`. `install.sh` disables and masks it later.
6. Install a test listener: `dnf5 -y install nmap-ncat`. Keep `-y` in every `dnf5` command of this guide: without a terminal, as over an agent's SSH session, dnf5 asks for confirmation, gets no answer and installs nothing.
7. Test inbound port 25 now, before you build anything. On the VPS, run `ncat -l 25`.
8. From a server outside the provider's network, run `nc -vz 203.0.113.10 25`. It must report success. Many home internet providers block outgoing port 25, so a test from home can fail for that reason alone.
9. Stop the listener on the VPS with Ctrl-C if it is still running.

If step 8 fails, check the provider's firewall policy again. If it still fails, stop and contact the provider: without inbound port 25 you cannot receive mail.

The IPv6 test comes later, in section 7, step 9, before you publish the AAAA record.

## 4. Set up Tailscale for admin access

Do this before the install script. The script's firewall allows SSH only over Tailscale and from the admin addresses you give it.

1. Install Tailscale on the VPS from Fedora's own package: `dnf5 -y install tailscale`. The package is in the `fedora` repository, so you need no third-party repository or key.
2. Start it: `systemctl enable --now tailscaled`.
3. Run `tailscale up` and sign in through the link it prints. Do not add `--ssh`. Tailscale SSH would answer port 22 on the tailnet itself, under the tailnet's SSH policy, in place of your SSH key. That policy's default `check` mode asks for a browser sign-in again, which stops an agent working over SSH. With plain `tailscale up`, OpenSSH answers over the tailnet and checks your key as before.
4. In the Tailscale admin console, turn off key expiry for the VPS.
5. In the access policy, allow only your own devices to reach the VPS, and only over SSH.
6. From your computer, connect over Tailscale: `ssh root@<vps-tailscale-name>`.

Verify your administrative route before restricting public SSH. Keep a working console session until a new SSH connection succeeds.

From here on, use only the Tailscale connection for admin work. Without Tailscale, pass your own fixed address to the install script with `--admin-ips` instead.

## 5. Run the host install script

1. From your computer, copy this repository's `deploy/` directory to the VPS: `scp -r deploy root@<vps-tailscale-name>:`.
2. Over the Tailscale connection, run the script as root, with your mail API host name: `deploy/host/install.sh --mail-api-host mail.example.com`. It writes `STALWART_PUBLIC_URL=https://mail.example.com` into `/opt/kasten/.env`.
3. When it asks, type a new recovery passphrase for the encrypted volume, twice. It needs at least 20 characters. Use a long random passphrase. An agent pipes the passphrase on standard input instead, over SSH from its own `0600` file on your computer, for example `ssh root@<vps-tailscale-name> deploy/host/install.sh --mail-api-host mail.example.com < volume-passphrase`.
4. Save the passphrase in your password manager.
5. From outside the tailnet, check that `ssh root@203.0.113.10` now fails.
6. Record the journal files that Fedora wrote to the disk before the script moved the journal to RAM: `find /var/log/journal -type f -printf '%p %s %T@\n' | sort >/root/journal-files.install`. The list holds file names, sizes and times only. After the first real reboot, the [acceptance checks](operations.md#other-checks-before-real-mail) compare the files with it: none may change.

The script needs no reboot, and it is safe to run again. It runs these steps, in this order: `packages`, `journald`, `swap`, `fstrim`, `user`, `volume`, `units` and `firewall`. It takes these options:

| Option                   | Use                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--admin-ips "ADDR …"`   | Also allow SSH from these IPv4 or IPv6 addresses or networks, outside Tailscale                                                                                                                                                                                                                                                    |
| `--data-size SIZE`       | Size of the encrypted volume file, for example `24G`. The default, `auto`, is the root file system's free space when install.sh creates the volume, minus 6 GiB. The volume file is sparse and grows into that space, and every upgrade adds images, so the [weekly check](operations.md#weekly-checks) measures free space on `/` |
| `--mail-api-host NAME`   | The mail API host, `mailApiHostname` in `kasten.json`. Sets `STALWART_PUBLIC_URL=https://NAME`. Without it, the script keeps the URL in `.env`, or asks on a terminal                                                                                                                                                              |
| `--passphrase-file FILE` | Read the recovery passphrase from the first line of FILE instead of the terminal. Put FILE only under `/run`, which is in RAM: a file on the disk keeps its blocks after you delete it. Standard input is simpler                                                                                                                  |
| `--skip STEP`            | Skip one of the steps `packages journald swap fstrim user volume units firewall`. Repeat it for more                                                                                                                                                                                                                               |
| `--help`                 | Print the usage                                                                                                                                                                                                                                                                                                                    |

The script needs the recovery passphrase only when it creates the volume. Without a terminal, it reads the first line of standard input. It never takes the passphrase as an argument.

The script runs only on Fedora 44 and 45, and only while SELinux enforces the targeted policy with MCS. Otherwise it stops before it changes anything. The containers' fixed MCS levels keep the mail server away from the CLI's credentials. For the same reason, `kasten-podman` refuses to create a container while SELinux is not enforcing. The local container test cannot enforce SELinux, so `deploy/test/run.sh` creates the marker file `/etc/kasten/test-without-selinux`, which lifts both checks with a loud warning. Never create that file on a real host.

The script refuses to turn on the firewall if your SSH session would be cut off. It keeps its settings in `/etc/kasten/host.env`, and the mail API URL in `/opt/kasten/.env`.

The firewall closes outgoing port 80, apart from root's requests to the provider's metadata address, so every package download must use HTTPS. Before its first download, the script writes `/etc/dnf/repos.override.d/50-kasten-https.repo`. That file makes the `fedora` and `updates` repositories use only HTTPS mirrors, and turns off Cisco's OpenH264 repository, which Kasten does not use. Any other repository that you turn on must use HTTPS too.

Until you set up Tang, the volume stays locked after every reboot. Unlock it with `kasten-unlock-passphrase`. Until the first boot in section 8 is done, that command only unlocks and mounts the volume, and prints the next step. After the first boot, it also starts `kasten.service`. `kasten.service` itself refuses to start before the first boot, because that start would be Stalwart's first normal start, with a network.

What it sets up:

- **Packages:** `podman`, `crun`, `conmon`, `passt`, `nftables`, `cryptsetup`, `clevis`, `clevis-luks`, `dnf5-plugin-automatic`, `dnf5-plugins`, `zram-generator`, `sqlite`, `e2fsprogs`, `jq`, `curl`, `policycoreutils`, `util-linux` and `diffutils`, without weak dependencies.
- **Updates:** `dnf5-automatic.timer` installs all Fedora updates every morning: security and bug fixes, and also new upstream versions of packages such as Podman, crun, systemd and the kernel. The server never reboots on its own; `dnf5 needs-restarting` says when a reboot is due. An update can change how Podman, crun or systemd behave, with nobody present: the daily check and probe catch the effect, not the cause. The script masks `dnf-makecache.timer`, because dnf5-automatic refreshes the package lists once a day.
- **Logs:** journald keeps every log in RAM, up to 32 MiB, and forwards nothing to a syslog daemon. The containers' logs go there too. Logs do not survive a reboot. If rsyslog or syslog-ng is installed, the script stops: it would write the logs to the unencrypted disk. Remove it with `dnf5 -y remove`, delete its files in `/var/log`, then run the script again. The script masks `auditd.service`, so no audit log reaches the disk; the kernel's audit messages still reach the journal in RAM. Core dumps are not stored. On the Fedora Cloud image, the journal in `/var/log/journal` and auditd's `/var/log/audit/audit.log` from before the script stay on the disk. They hold only the boots and the setup before the script's `journald` step.
- **The encrypted volume:** a LUKS2 file, `/var/lib/kasten.luks`, mounted at `/var/lib/kasten`. Mail data, the CLI's configuration, secrets and restic's temporary files all live there. Its `data/` directory belongs to the mail server's user, `cli/` and `cli/state/` belong to the `kasten` user, and `secrets/` belongs to root, each with mode 0700. On a btrfs root file system, such as the Cloud image's, the volume file has copy-on-write turned off. The script gives the new file system its SELinux labels once.
- **Swap:** compressed swap in RAM only, from `zram-generator`, half the size of the RAM. Disk swap is turned off, so nothing from memory reaches the unencrypted disk. The script comments out the swap entries in `/etc/fstab`. If an active entry is still there afterwards, the script stops: comment it out, then run the script again. The script also masks every disk swap unit, because systemd can turn on a swap partition that `/etc/fstab` does not list. When it changes the zram settings, or zram swap is off, it resets the zram device and turns its swap on. If the device stays busy, the script stops: reboot, then run it again. It stops unless zram swap is active.
- **The kasten user:** every container runs with rootless Podman as the host user `kasten`, with uid and gid 2600, no password and no shell. Its own systemd manager, `user@2600.service`, starts at boot. Container root is `kasten` on the host. The mail server's files belong to one of `kasten`'s subordinate IDs, which the script writes into `/etc/kasten/host.env` as `KASTEN_MAIL_UID`. The script stops if uid or gid 2600 already belongs to another user or group.
- **Rootless Podman:** Podman keeps its database and the state of every container in RAM, under `/run/user/2600`. Only the images stay on the disk, in `/home/kasten/.local/share/containers/storage`. The script masks `systemd-oomd`, which would kill the whole user slice, mail container included, under memory pressure. The containers' memory limits and the kernel's OOM killer stay. `/etc/sysctl.d/50-kasten.conf` lets unprivileged users bind ports from 25 up, so the mail server can bind ports 25 and 443 as `kasten`. Ports below 25, such as SSH on 22, stay privileged.
- **The firewall:** inbound TCP 25 and 443, Tailscale, and SSH over Tailscale or from `--admin-ips`. Outbound DNS, NTP, HTTPS, Tailscale and SES on port 587, and, for root only, plain HTTP to the provider's metadata service at `169.254.169.254` and `fe80::a9fe:a9fe`, which cloud-init reads at every boot on Hetzner. Outgoing TCP 25 is dropped. Fedora's `nftables.service` loads the rules from `/etc/sysconfig/nftables.conf`. If firewalld is installed, the script disables and masks it.
- **The services:** `kasten-unlock.service` unlocks and mounts the volume at boot, then `kasten.service` starts Stalwart, once the first boot is done. `kasten.service` runs the mail container, `kasten-mail`, through `kasten-mail-service` and rootless Podman, and waits until the container is healthy. Podman restarts the container after a crash; a stop through `kasten.service` is final. `kasten-backup.timer` runs the backup nightly at 03:15, plus a random delay of up to 30 minutes. Generic check/probe units are installed but not enabled.
- **The helpers** in `/usr/local/sbin`: `kasten-unlock`, `kasten-unlock-passphrase`, `kasten-unlock-event`, `kasten-bind-tang`, `kasten-bootstrap`, `kasten-check`, `kasten-push` and `kasten-residue-check`, and the container wrappers `kasten-podman`, `kasten-cli`, `kasten-mail-run`, `kasten-mail-exec` and `kasten-mail-service`. `kasten-podman` runs Podman as the `kasten` user, for root; the other wrappers run their containers through it. Only `kasten.service` runs `kasten-mail-service`: do not run it by hand. `/usr/local/lib/kasten/podman.sh` holds the one definition of the containers' arguments.

## 6. Build and load the images

The VPS never pulls images from a registry, and it builds none. You build them on your computer with Docker and copy them over.

1. On your computer, in this repository, choose a version tag, for example the commit: `v=$(git rev-parse --short HEAD)`.
2. Build both images for `linux/amd64`. The server image builds from `server/`; the CLI image builds from the repository root:

   ```sh
   docker build --platform linux/amd64 -t "kasten-server:$v" server/
   docker build --platform linux/amd64 -f cli/Dockerfile -t "kasten-cli:$v" .
   ```

3. Copy them to the VPS, where Podman loads them for the `kasten` user: `docker save "kasten-server:$v" "kasten-cli:$v" | ssh root@<vps-tailscale-name> kasten-podman load`. Podman names them `localhost/kasten-server:<tag>` and `localhost/kasten-cli:<tag>`.
4. On the VPS, set the tag from step 1 in `/opt/kasten/.env`: `sed -i 's/^KASTEN_VERSION=.*/KASTEN_VERSION=<tag>/' /opt/kasten/.env`.
5. Prepare the data directory on the encrypted volume: `kasten-mail-run init`. It prints one JSON line, `{"volumeId":"<32 hex digits>","created":true,...}`, and stores a random recovery login on the volume.
6. Set that volume ID in `/opt/kasten/.env`: `sed -i 's/^KASTEN_VOLUME_ID=.*/KASTEN_VOLUME_ID=<volumeId>/' /opt/kasten/.env`. From then on, the server refuses to start on any other volume.

On an Apple-silicon Mac, the `linux/amd64` build runs under emulation. Use Rosetta emulation in Docker, for example `colima start --vm-type vz --vz-rosetta`: under QEMU emulation, Stalwart crashed in the image's build-time version check.

## 7. Prepare the configuration

1. Create the SES identity and the SMTP user, as in [the AWS guide](aws-ses.md). Its [section 8](aws-ses.md#8-create-one-smtp-user-per-domain) writes the SMTP user name and password straight into `/var/lib/kasten/cli/ses-smtp-username` and `/var/lib/kasten/cli/ses-smtp-password` on the VPS.
2. Create the operator key on your computer. `kasten.json` needs one. Every stored message is also encrypted to it, so keep its secret key off the server, in your password manager:

   ```sh
   gpg --quick-gen-key "Kasten operator <operator@example.com>" ed25519 cert,sign never
   gpg --quick-add-key <fingerprint> cv25519 encr never
   gpg --armor --export <fingerprint> >operator.pub.asc
   ```

   `gpg --list-keys operator@example.com` prints the fingerprint. The key must not expire. Save the secret key, from `gpg --armor --export-secret-keys <fingerprint>`, and its passphrase in your password manager.

   These commands ask for the passphrase interactively. An agent uses the non-interactive commands in [The operator key](agent-setup.md#the-operator-key) instead.

3. In a private directory outside the repository (mode `0700`), copy [`kasten.example.json`](../kasten.example.json) to `kasten.json` and change every value. [The CLI guide](../cli/README.md#kastenjson) describes each field. Keep these production values:

   | Field                  | Value                                                                                                                                                                                                  |
   | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `mailApiHostname`      | The name you gave `install.sh --mail-api-host`                                                                                                                                                         |
   | `http`                 | `{"mode": "production", "publicBind": "[::]:443", "adminBind": "127.0.0.1:8080", "acme": {"directory": "https://acme-v02.api.letsencrypt.org/directory", "contact": ["<an address outside Kasten>"]}}` |
   | `admin.apiUrl`         | `http://127.0.0.1:8080`                                                                                                                                                                                |
   | `admin.apiKeyFile`     | `admin-api-key`. The first boot writes it                                                                                                                                                              |
   | `admin.allowedIps`     | `["127.0.0.1", "::1"]`                                                                                                                                                                                 |
   | `webApp.origin`        | `https://app.example.com`                                                                                                                                                                              |
   | `webApp.redirectPath`  | `/oauth/callback`. The app always uses this path                                                                                                                                                       |
   | `webApp.oauthClientId` | `kasten-web`, or your own value. The app host uses the same value                                                                                                                                      |

   Keep `adminBind` at `127.0.0.1:8080`. The mail container's health check calls that address, and `kasten.service` waits for it.

   This private directory is your private configuration directory. Also record in it the commit that you built the images from in section 6. A [restore after host loss](operations.md#restore-after-host-loss) builds the images from that commit.

4. List every person in `users`, each with a `passwordFile` that holds a new password. Setup creates only accounts that have one, and stops on a listed account that does not exist yet. If the first boot stops on a listed account without a `passwordFile`, add one and run `kasten-bootstrap` again. Save each password in your password manager.
5. Add a probe account: one more entry in `users`, for example `probe@example.com` with `probe-password`, and `"probe": {"account": "probe@example.com", "passwordFile": "probe-password", "kumaPushUrlFile": null}`. `kasten lock` needs it for its proof sign-in, and `kasten probe` sends its daily test mail from it.
6. Copy `kasten.json` and the other files it names to the VPS, into `/var/lib/kasten/cli/`. Use the file names from your `kasten.json`, for example: `scp kasten.json operator.pub.asc you-password probe-password root@<vps-tailscale-name>:/var/lib/kasten/cli/`. The SES files are already there from step 1. `kasten.json` itself holds no secrets.
7. On the VPS, give the files to the `kasten` user and close them to everyone else: `chown -R kasten:kasten /var/lib/kasten/cli && chmod -R go= /var/lib/kasten/cli`. The CLI container's root is the host user `kasten`, so the CLI can read only the files that `kasten` owns. `kasten-cli` refuses to run while any file or directory in `/var/lib/kasten/cli` belongs to another user or group, or gives group or others access; its error message prints this line. Once the mail server has run, add a file to `/var/lib/kasten/cli` only as `kasten`, as in [How to run the commands](operations.md#how-to-run-the-commands-on-this-page): root itself would follow a link that a container left there.
8. Print the DNS records: `kasten-cli dns --config /etc/kasten/kasten.json`.
9. Create every printed record except MX, as in [DNS](dns.md). Leave out the AAAA record of `mx.example.com` until an external port-25 test over IPv6 passes. Test it as in section 3, with `ncat -6 -l 25` on the VPS and `nc -6 -vz 2001:db8::10 25` from outside the provider's network.
10. Wait until `dig +short A mail.example.com` and `dig +short A mx.example.com` print the VPS address. Stalwart needs both to get its certificates.

## 8. First boot: bootstrap the server

The first boot uses Stalwart's recovery mode, once, to create the admin API key. Normal runs never use it. Run these steps on the VPS, as root.

1. Run `kasten-bootstrap`. It takes these steps:
   - It copies the recovery login to `/var/lib/kasten/cli/recovery-admin` for this run.
   - It starts Stalwart in recovery mode on port 8080, in a container without any network.
   - It runs `kasten setup --bootstrap` inside that container's network namespace. Setup creates the key-only admin account and its API key, and writes the key to `/var/lib/kasten/cli/admin-api-key` (mode 0600). The key works only from the addresses in `admin.allowedIps`. Save the key in your password manager: a [restore after host loss](operations.md#restore-after-host-loss) needs it.
   - It stops and removes the recovery container, and deletes the copy of the recovery login.

   Without a network, Stalwart cannot fetch its web admin UI. Setup stores the web UI, the ASN/GeoIP data and the spam rules' four remote lists as disabled, so the first normal start downloads nothing either.

2. Start the normal service: `systemctl start kasten.service`. It waits until the mail container is healthy. In the container test and the Lima VMs, a start took 30 to 31 seconds, because Podman runs the first health check 30 seconds after the start.
3. Apply the full configuration: `kasten-cli setup --config /etc/kasten/kasten.json`. This first normal run also applies the settings that Stalwart creates defaults for on its first normal start: the upload lifetime in `x:Jmap`, the SES route, the throttles and the disabled remote spam lists. It then checks that the session advertises the Web Push key that Stalwart generated. It also creates the ACME provider and the certificate settings, which the bootstrap listed as `deferred`: creating the provider registers an account with the certificate authority, so it needs the network. Stalwart then requests the certificates for `mail.example.com` and `mx.example.com`.
4. If setup prints `Restart Stalwart to apply: ...`, run `systemctl restart kasten.service`.
5. Run setup again. It must print `0 changed`. You can run it at any time; it changes only what differs.

Every setup run prints `warning   DnsResolver: The configured DNS resolver cannot validate DNSSEC. DANE has been disabled ...`. This is expected. Stalwart counts a resolver as DNSSEC-capable only when it has a TCP connection, and Kasten's resolver entry uses UDP. The warning names Stalwart's built-in `default` TLS strategy, which asks for DANE but carries no mail: Kasten sends everything through its `strict` strategy, to SES, with DANE off. Details are in the [Stalwart reference](stalwart-v1.0.1.md#11-production-tls-with-acme-tls-alpn-01).

In the 6 November 2026 rehearsal, the Fedora 45 amd64 VPS with SELinux enforcing obtained a Let's Encrypt certificate for both the mail API and MX hostnames. Verify that both of your hostnames are covered.

The admin API listens only on `127.0.0.1:8080`. The CLI container uses the host's network, so it reaches the admin API directly, and you need no SSH tunnel. To reach it from your computer instead, forward the port with `ssh -N -L 8080:127.0.0.1:8080 root@<vps-tailscale-name>`. Stalwart then sees `127.0.0.1`, which the admin key allows. That route is not yet tested. Recovery mode has no network at all: only the bootstrap container reaches it.

To add a person later, follow these steps in order, on the VPS, as root. The account receives mail as soon as `user add` creates it. Until the account has its key bundle, the server stores that mail readable, and the nightly backup copies it that way. See [Messages the server stores as they are](security.md#messages-the-server-stores-as-they-are).

1. Write the new password into a file in `/var/lib/kasten/cli/` as `kasten`: `setpriv --reuid=kasten --regid=kasten --init-groups sh -c 'umask 077 && cat >/var/lib/kasten/cli/<file>'`, with the password on standard input. Run `kasten-cli user add <email> --password-file /etc/kasten/<file> --config /etc/kasten/kasten.json`. It prints two `note` lines: the warning above, and what must happen before you give out the address.
2. If no account is locked yet, follow section 11, steps 1 to 8, for the person, then go on with step 7 here. Otherwise go on with step 3. After the first `kasten lock`, the app can neither change MFA nor upload a key, and `lock` refuses an account without sign-in codes.
3. Create the person's sign-in code key: `kasten-cli user mfa new <email> --out /etc/kasten/state/<name>.otpauth --config /etc/kasten/kasten.json`. The file is on the host at `/var/lib/kasten/cli/state/<name>.otpauth`. Give the person the key in it: show it as a QR code with a local tool, or let them type its secret into their authenticator app.
4. Pipe the person's current code into `enrol`: `echo <code> | kasten-cli user mfa enrol <email> --otp-url-file /etc/kasten/state/<name>.otpauth --password-file /etc/kasten/<file> --config /etc/kasten/kasten.json`. It checks the code against the key, turns codes on, proves that the password alone no longer signs in, and removes the key file.
5. The person signs in to the app, with the password and a code. The app shows "Add your mail key to this device". The person chooses **Make a new key**, chooses its passphrase and saves the recovery sheet. The app then shows the public key and its fingerprint, and the person chooses **Copy request for your operator** and sends the request to the operator. Once step 6 is done, the person chooses **It's installed**.
6. The operator saves the public key as a file in `/var/lib/kasten/cli`, written as `kasten` the same way as the password in step 1. Then the operator runs `kasten-cli keys set --account <email> --key /etc/kasten/<key file> --config /etc/kasten/kasten.json`, then `kasten-cli lock --account <email> --user-fingerprint "<fingerprint on the sheet>" --config /etc/kasten/kasten.json`. Take the fingerprint from the person's recovery sheet, never from `kasten-cli keys show`. Steps 2 to 4 of [Rotate your mail key](operations.md#rotate-your-mail-key) describe the same route through the locked app.
7. Run `kasten-cli reader create --account <email> --config /etc/kasten/kasten.json`. Add the account to `users` in `kasten.json`, with `"passwordFile": null`, so that `check` without `--account` covers it. Copy the new `state/lock.json` to your private configuration directory. Also add the account to the off-host observer's `kasten.json`, and copy the new `state/lock.json` and the reader credential there.
8. Only then give out the address, or set up a forward to it.

`kasten-cli user password <email> --password-file /etc/kasten/<file> --config /etc/kasten/kasten.json` replaces a password the same way as `user add`.

Not yet tested on a real VPS: adding a person after the lock. The dev-stack test of `user mfa`, `tests/integration/cli-user-mfa.test.ts`, passed on 4 November 2026.

## 9. Automatic unlock with Tang

Skip this section if you will unlock the volume by hand after each reboot.

On the Tang machine, follow [the Tang setup](../deploy/tang/README.md#install). It installs Tang, makes it listen only on the machine's tailnet address (the examples use port 7500), lets only the VPS reach it, in its own firewall and in the Tailscale access policy, and prints the thumbprint of Tang's signing key. Then [back up Tang's keys](../deploy/tang/README.md#back-up-the-keys).

On the VPS:

1. Run `kasten-bind-tang "http://<tang-tailnet-ip>:7500" <thumbprint>`. It asks for the recovery passphrase, or reads it from the first line of standard input. It adds one Clevis key slot pinned to that thumbprint, and tests it against Tang without unlocking anything.
2. Keep the passphrase slot. You need it when Tang is down.
3. Reboot, and check that the volume unlocks and Stalwart starts without you. `journalctl -t kasten-unlock -g '^event='` shows `event=unlock result=ok method=tang`, and `systemctl status kasten.service` shows it active. On Hetzner, also check cloud-init, as in [section 3](#3-install-fedora-45), Hetzner step 8.

If Tang does not answer, one unlock attempt lasts up to `KASTEN_UNLOCK_TIMEOUT` seconds (300 by default, set in `/etc/kasten/host.env`). Then `kasten-unlock.service` fails, nothing is mounted and mail stays stopped. systemd tries again a minute later, and after every failed attempt, until Tang answers. After the unlock, the unit starts `kasten.service` by itself; you run no command. To get mail back sooner without Tang, unlock by hand with `kasten-unlock-passphrase`, as in [Reboots and unlock](operations.md#reboots-and-unlock).

Without a Tang binding, the unit fails once with exit status 6 (systemd shows `6/NOTCONFIGURED`) and does not try again.

On 5 November 2026, `deploy/test/run.sh all`, in a Fedora 45 container with SELinux off, ran `kasten-bind-tang` against Tang on a stand-in tailnet. A container restart stood in for each reboot. After a reboot and after a poweroff, the volume unlocked through Tang, and `kasten.service` was active 34 and 35 seconds later, with nobody acting. After a reboot while Tang was down, the unlock failed and nothing was mounted. Once Tang was back, systemd's retry unlocked through Tang and mail started with nobody acting. The test set `KASTEN_UNLOCK_TIMEOUT` to 20 seconds. None of these steps has run over a real tailnet yet.

## 10. Host the web app

The app is static files in the `kasten-web` image. Host it on a machine other than the mail VPS, so that a break-in on the mail server cannot change the code that handles your key.

1. On your computer, build the image from the repository root, for the app host's platform. This example is for an amd64 host: `docker build --platform linux/amd64 -f web/Dockerfile -t "kasten-web:$v" .`. Copy it with `docker save "kasten-web:$v" | ssh <app-host> docker load`.
2. Put a copy of `operator.pub.asc` on the app host, for example as `/srv/kasten-web/operator.pub.asc`. It must be the same public key as `operatorPublicKeyFile`: `kasten lock` refuses a key set without it. The container runs as user 101 and stops if it cannot read the file. It is a public key, so make it readable: `chmod 0644 /srv/kasten-web/operator.pub.asc`.
3. Run the image on the app host. `KASTEN_API_URL` is the same URL as `STALWART_PUBLIC_URL` on the VPS, and `KASTEN_OAUTH_CLIENT_ID` is `webApp.oauthClientId` from `kasten.json`:

   ```sh
   docker run -d --name kasten-web --restart unless-stopped \
     --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
     -p 127.0.0.1:8080:8080 \
     -e KASTEN_API_URL=https://mail.example.com \
     -e KASTEN_OAUTH_CLIENT_ID=kasten-web \
     -e KASTEN_OPERATOR_KEYS_FILE=/operator.pub.asc \
     -v /srv/kasten-web/operator.pub.asc:/operator.pub.asc:ro \
     "kasten-web:<tag>"
   ```

   `KASTEN_APP_NAME` optionally sets the app's name. At start, the image writes `/config.json`, the Content Security Policy and the other response headers, including separate policies for the message frames under `/frame/`. [The web app guide](../web/README.md#the-kasten-web-image) lists every variable.

4. Put it behind an HTTPS proxy at `https://app.example.com`. The proxy forwards to port 8080 of the container, which speaks plain HTTP. The proxy must pass the image's response headers unchanged.
5. Point the DNS name at the app host, with any CDN proxy turned off.
6. Open `https://app.example.com/config.json` and check the values: `apiUrl`, `oauthClientId`, `operatorKeys` and `appName`.

The app signs in through `https://app.example.com/oauth/callback`. Setup registered exactly that redirect URI, from `webApp.origin` and `webApp.redirectPath`.

The web image test checks that the container writes `/config.json` from these variables and refuses invalid values. The development stack mounts a generated configuration instead. A separate HTTPS host served the rootless web container during the November 2026 pilot.

Keep the app host's deploy credentials off the mail server.

## 11. Create your key and lock the account

1. On your phone, open `https://app.example.com` and add it to the Home Screen.
2. Sign in with your account's password, and enrol sign-in MFA in Settings. Do it before step 8: after the lock, the app can no longer change MFA, and `kasten lock` refuses an account without sign-in codes.
3. Allow notifications.
4. Create your mail key and choose its passphrase. Memorise the passphrase; do not write it down.
5. Print the recovery sheet. Keep it away from your home.
6. On a second device, open the app and restore the key from the sheet. This proves the sheet works.
7. Do steps 1 to 6 for every other user. You can import a household member's old mail (section 15) only after that member has done steps 1 to 6 and step 8 has locked their account.
8. On the VPS, lock each account: `kasten-cli lock --account you@example.com --user-fingerprint "<fingerprint on your printed recovery sheet>" --config /etc/kasten/kasten.json`. Read the fingerprint from the sheet you printed in step 5, never from `kasten-cli keys show` or the server. For another user, use the fingerprint on that user's sheet. Lock checks the key set, checks that its user key is the one on your sheet, and checks that the account has sign-in codes. It makes the app's OAuth client non-first-party, removes the client's grants in that account and pins the key fingerprints in `/var/lib/kasten/cli/state/lock.json`. Then it proves, with a sign-in as the probe account, that an app token can no longer change keys, account settings or app passwords.
   - If lock refuses because the user key is not the one on your sheet, someone may have replaced the key set before the lock. Stop and investigate.
   - Lock pins nothing while the account has app passwords or API keys other than Kasten's reader and import passwords. List them with `kasten-cli app-password list --account you@example.com --config /etc/kasten/kasten.json`; it marks each of them `OTHER`. Then run lock again with `--revoke-others`, which destroys them. When lock refuses for this reason, it has already made the client non-first-party and ended the app's sessions in that account.
   - After the last lock, copy `/var/lib/kasten/cli/state/lock.json` to your private configuration directory, next to `kasten.json`. It holds fingerprints and key IDs, no secrets. Copy it again after every later `kasten lock`. A [restore after host loss](operations.md#restore-after-host-loss) needs it.
9. Sign in to the app again. The lock ended its session. If the app was locked at that moment, it asks once for your passphrase, then for the sign-in, then for the passphrase again. If the app then shows the restore screen that says "The key saved on this device is not in your server's key set any more", stop: someone may have swapped the key set. Investigate before you use the account.
10. Create the reader credential for the daily check, for every account in `users` in `kasten.json` except the probe account: `kasten-cli reader create --account you@example.com --config /etc/kasten/kasten.json`, then the same command with each other user's address. Each run writes a read-only app password into `/var/lib/kasten/cli/state/`, and proves that it cannot write. The check in step 12 checks all these accounts, and exits with status 2 if one of them has no reader.
11. Configure the [off-host observer](../deploy/observer/README.md) with the human account list, protected lock and reader state, a private admin tunnel and a public reader URL. Keep the push URL protected on the observer.
12. Run the check once: `systemctl start kasten-check.service`. Read its report with `journalctl -t kasten-check`. Exit status 0 means clean, 1 means findings, and 2 means an error, for example an unreadable `kasten.json` or admin API key file.

From step 4 on, the server encrypts every new message to your key set.

The dev-stack tests of the lock's refusals in step 8 (`tests/integration/cli-keys-lock.test.ts`) passed on 4 November 2026.

## 12. Run the security check

Run the security check from your computer, not from the VPS. It needs a source address that is neither loopback nor allowed by the admin key, as a stranger on the internet would have.

1. In a private directory outside the repository (mode `0700`), put copies of `kasten.json`, the admin API key file and the probe's password file from `/var/lib/kasten/cli/`, each with mode `0600`.
2. From this repository, run `node cli/src/main.ts security-check --config <directory>/kasten.json`. It tests `https://<mailApiHostname>` by default. To also prove that the recovery login fails, add `--recovery-admin-file` with a `0600` copy of `/var/lib/kasten/data/secrets/recovery-admin`.
3. Delete the copies.

It prints one `PASS` or `FAIL` line for each of these live checks:

- public OAuth client registration, device sign-in and Stalwart's built-in `/login` page are refused;
- management calls are refused for a user password, an app password and a token of the locked app client;
- the CORS answer names only the app's exact origin, never the caller's origin and never `*`;
- the admin API key is refused from a public address;
- the session advertises Web Push;
- a login as the recovery admin fails, with `--recovery-admin-file`.

If any check fails, stop. Do not move real mail in.

## 13. Set up backups

Follow [Backups](operations.md#backups). The exact commands are in [the deploy reference](../deploy/README.md#backups). Run one backup and one restore rehearsal before real mail.

## 14. Run the acceptance checks

The inbound tests need a domain whose MX already points at the VPS. Until the MX switch in section 15, other servers still deliver your own domain's mail to the old provider. So set up a pilot domain first: a second domain, or a subdomain such as `pilot.example.com`.

1. In `/var/lib/kasten/cli/kasten.json`, add it as the last entry in `domains`. Keep your own domain first: setup keeps the admin account in the first domain.
2. Add an address in the pilot domain to your account's `aliases`.
3. Run setup: `kasten-cli setup --config /etc/kasten/kasten.json`.
4. Create the pilot domain's MX record, `10 mx.example.com.`.
5. Send the inbound test mail to that alias.
6. Set up a probe account in the pilot domain, so that the daily probe proves the pilot domain's public MX during the pilot. Create the pilot domain's SES identity and its own SMTP user, as in [the AWS guide](aws-ses.md), sections 4 and 8, and add its `relays` entry and DKIM tokens to `kasten.json`. Add the account to `users`, for example `probe@pilot.example.com` with its own password file in `/var/lib/kasten/cli`, and set `probe.account` and `probe.passwordFile` to it. Write that file as `kasten`, as in section 8, step 1 of adding a person. Take the production-domain probe account from section 7 out of `users` for the pilot: `kasten check` without `--account` checks every account in `users` except the one that `probe` names, and a probe account has no lock, so the check would fail. Setup never destroys an account that `users` no longer lists. Run setup again. Then run the probe once, `kasten-cli probe --config /etc/kasten/kasten.json`, and require exit status 0. Only then enable its daily timer, `systemctl enable --now kasten-probe.timer`, or the timer of the host that runs the probe, as in [observer setup](../deploy/observer/README.md).

Not yet tested: a second entry in `domains`. The probe follows its account’s domain MX. Use the pilot-domain account during the pilot; switch to the production-domain account only after its final MX switch. The next probe run after the switch sends from the new account, the same day, and must report `received`. The earlier account's result never counts for it.

Setup bars only the account that `probe` names from sending to other domains. Every other account, a probe account that `probe` no longer names included, can send anywhere through SES. Keep each probe password only in a file in `/var/lib/kasten/cli` that only `kasten` can read, and retire the pilot probe account after the switch, as in section 15.

Follow [Acceptance on the real server](operations.md#acceptance-on-the-real-server). It includes a 24-hour soak, the memory criteria and real delivery tests.

## 15. Move your mail in

Do this only when all of these are true:

- SES production access is granted.
- The acceptance checks and the security check pass.
- The app works on your real phone, including push and recovery from the sheet.
- The server has rebooted and unlocked automatically through Tang with the laptop absent. Manual recovery is tested separately.
- The restore rehearsal has passed.
- Your monitoring alerts go to an address outside Kasten.
- Every account you import into is locked (section 11, step 8: `kasten lock` passed), so the server encrypts every imported message to its pinned key set.

Before each import run, turn notifications off on every device: **Settings** > **Turn off notifications**. Each message that the import appends makes the server push a change to every subscribed device. With **Show sender and subject in notifications** on, a device then keeps replacing one quiet "Mailbox updated" notice; with it off, it shows "New mail" for every message. Turn notifications on again after the run, with **Turn on notifications**.

`kasten import-imap` copies the old mail. For encrypted destination reconciliation, add protected local `--key <operator-secret.asc> --passphrase-file <file>`. Missing or unusable keys fail visibly; keys never go to the VPS. Run it on your computer with `node cli/src/main.ts import-imap`, not on the VPS: the VPS firewall blocks outgoing IMAP. [The CLI guide](../cli/README.md#kasten-import-imap) lists its options. It needs:

- Kasten's IMAP import listener: set `imapImportBind` to `"127.0.0.1:143"` in `/var/lib/kasten/cli/kasten.json`, run setup on the VPS, and restart `kasten.service` when setup asks. Set it back to `null` after the import.
- An SSH tunnel to that listener, for example `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:11143:127.0.0.1:143 root@<vps-tailscale-name>`. Then use `--dest-host 127.0.0.1 --dest-port 11143`. Do not use local port 1143: Proton Bridge listens there by default, so the import could reach Bridge instead of Kasten. `ExitOnForwardFailure=yes` makes `ssh` stop when the local port is taken, instead of running without the tunnel.
- The old mailbox's password in a `0600` file, for `--source-password-file`.
- An import app password for your Kasten account, for `--dest-password-file`. An account with MFA cannot use its own password over IMAP, and after `kasten lock` the app cannot create an app password. Create it on the VPS: `kasten-cli app-password create --account you@example.com --purpose import --out /etc/kasten/state/import-app-password --config /etc/kasten/kasten.json`. Its permission list holds only what the import does over IMAP. It first checks the account's encryption: it refuses an account that `kasten lock` has not pinned, or where Stalwart would store appends in plaintext or encrypt them to another key set. The checks are: the server's `encryptAtRest` and `encryptOnAppend` on, the account's `encryptionAtRest` on `Aes256` with `encryptOnAppend`, a bundle with no problem, and exactly the pinned key IDs. Stalwart never encrypts mail it has already stored. These checks are inspected in the code. Their dev-stack tests, in `tests/integration/cli-import-imap.test.ts`, passed on 4 November 2026: they prove the refusal before `kasten lock` and the passing check on a locked account. The command checks that it signs in and that nine sample JMAP calls are refused; the IMAP limits were tested on the dev stack (`tests/integration/cli-import-imap.test.ts`). Like every Stalwart credential, it can still download and upload blobs over HTTP ([Stalwart reference, section 8](stalwart-v1.0.1.md#8-app-passwords)). The command prints the app password's id; note it for the delete. Copy the file to a `0600` file on your computer, for example with `scp -p root@<vps-tailscale-name>:/var/lib/kasten/cli/state/import-app-password .`. Then delete it on the VPS: `rm /var/lib/kasten/cli/state/import-app-password`.

After the last import run, delete the app password and its copy: `kasten-cli app-password delete --account you@example.com --id <id> --config /etc/kasten/kasten.json` on the VPS, and the file on your computer.

Not yet tested on a real VPS: the import through the SSH tunnel. The dev stack's import test uses an app password from `app-password create`. The dev-stack tests of the All Mail reconciliation, a moved message, a dropped flag and a flag that another folder keeps on a shared message (`tests/integration/cli-import-membership.test.ts`) passed on 4 and 5 November 2026.

The bulk copy and the delta run below are default runs, without `--folder`. Only a default run copies every folder and reconciles them against All Mail, so only its `Result: clean.` counts. All Mail and Starred are not copied as folders. A label in the old mailbox becomes one more folder membership of the same message in Kasten. A message that is only in All Mail lands in a Kasten folder of the same name, for example `All Mail`. The report names up to 25 such messages, each in a line such as `Note: All Mail: UID … is in no other folder`, and counts the rest. A `--folder` run is never the completion gate: it reports every All Mail message outside the named folders as missing.

Then:

1. Copy all old mail in with `import-imap` before starting the pilot week, in a default run, with notifications off.
2. Run a full check of every account you imported into: `kasten-cli check --full --account you@example.com --config /etc/kasten/kasten.json`. It must exit 0, which shows that every imported message is stored encrypted to exactly the pinned key set. Review any finding as in [Daily check and monitoring](operations.md#daily-check-and-monitoring).
3. Turn notifications on again on every device and verify new-mail-only push, then run a one-week pilot on the pilot domain. Prove its dedicated delivery probe during the pilot, using that domain’s public MX, as in section 14.
4. Check the bulk copy's reconciliation report. It matches each source message, by folder and UID, to its copy, by Message-ID, a fingerprint of the Date, From, To and Subject fields, the internal date and the flags. Accept only a report whose last line begins with `Result: clean.` Also review the section "No longer in the source folder". It lists earlier copies of mail that you moved or deleted in the old mailbox since an earlier run. The import reports them and never deletes them. A moved message is already in its new folder, so removing its old copy from the listed Kasten folder loses nothing. For a message deleted in the old mailbox, decide whether to keep it. A flag you removed in the old mailbox, for example by marking a message unread or unflagging it, is removed in Kasten too. A flag you set only in Kasten stays. Kasten keeps one set of flags per message, so when the old mailbox has the same message in two folders, a flag that one of them still has stays.
5. List the accounts elsewhere, for example your bank or registrar, that send sign-in codes or warnings to this domain. Decide for each one whether to move it to another address first.
6. One day before the switch, lower the TTL of the old MX record to 300 seconds.
7. Run `import-imap` again with the same `--state` file, in a default run, with notifications off, to copy mail that arrived since the first run. Check its report as in step 4, including the section "No longer in the source folder". Run the full check of step 2 again; it must exit 0 before the switch. Then turn notifications on again.
8. Change the MX record to `10 mx.example.com.`, as in [DNS](dns.md#switching-mx).
9. Watch the first day. Check that mail from several providers arrives. Switch the probe to the production-domain probe account from section 7: in `kasten.json`, put it back in `users` with its password file, set `probe.account` and `probe.passwordFile` to it, take the pilot probe account out of `users`, and run setup. Where the probe runs on the VPS, run it once, `kasten-cli probe --config /etc/kasten/kasten.json`, and require exit status 0; its timer stays enabled. On apps, switch the existing pilot observer to the production-domain probe and separate state directory as in [observer setup](../deploy/observer/README.md). Run its service once and require success, then keep its apps timer enabled. Never enable the mailbox-host probe for the personal installation.
10. If incoming mail fails within the first day, put the old MX record back. Stop the probe at once, because it would send to the old provider: `systemctl disable --now kasten-probe.timer` on the VPS, or the probe timer on the host that runs it. Then rerun `import-imap` with the same `--state` file after the next MX switch, to copy what the old mailbox received meanwhile. Mail that reached Kasten during the failed window stays in Kasten and readable in the app. No tool copies it back to the old mailbox; list it with `kasten read list --since <time of the switch> --limit 2000`, as in [Reading mail](agent-setup.md#reading-mail), so that you know which messages the old mailbox lacks. If it reports that it looked at 2000 messages, the list may be incomplete.
11. When the first day has passed, retire the pilot probe account. Setup no longer bars it from sending to other domains, and its password is still on disk. Write a new random password into a file in `/var/lib/kasten/cli` that you do not save, and run the `chown` and `chmod` line from section 7, step 7. Then run `kasten-cli user password probe@pilot.example.com --password-file /etc/kasten/<that file> --config /etc/kasten/kasten.json`. Then delete both password files, and every copy of the old one, such as the observer's.
12. Keep the old mailbox for two weeks. Check it daily and copy any mail that still arrives there.
13. After the two weeks, remove the pilot domain from Kasten as in [Remove a pilot domain](operations.md#remove-a-pilot-domain), then remove its DNS records. `domain remove` also destroys the pilot probe account. Delete the pilot domain's SES identity and SMTP user, as in [Remove a sending domain](aws-ses.md#remove-a-sending-domain).

Not yet tested on a real VPS: `domain remove`. Its dev-stack test, `tests/integration/cli-domain-remove.test.ts`, passed on 4 November 2026.

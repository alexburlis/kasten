#!/usr/bin/env python3
"""Behavioral checks of the actual host helpers with disposable local fixtures."""
import http.server
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / 'deploy/host'
# The shells that run the host scripts as /bin/sh: bash on Fedora, run as "sh", which puts it in
# POSIX mode; and dash, the strictest common /bin/sh, where this machine has it. The tests of
# signal handling run under each, because shells differ there.
SHELLS = [shell for shell in (shutil.which('bash'), shutil.which('dash')) if shell]
STOP_SIGNALS = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)


def shell_function(source, name):
    """The definition of one top-level shell function, up to its closing brace."""
    start = source.index(f'\n{name}() {{\n') + 1
    return source[start:source.index('\n}\n', start) + 3]


def write_stubs(bins, stubs):
    bins.mkdir()
    for name, body in stubs.items():
        path = bins / name
        path.write_text('#!/bin/sh\n' + body + '\n')
        path.chmod(0o700)


def default_stop_signals():
    for sig in STOP_SIGNALS:
        signal.signal(sig, signal.SIG_DFL)


def interrupt(test, shell, args, env, ready, sig):
    """Runs args with shell as sh in its own process group, and sends sig to the whole group, as
    a terminal or a dropped SSH session does, once the file ready exists."""
    proc = subprocess.Popen(['sh', *args], executable=shell, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, start_new_session=True,
                            preexec_fn=default_stop_signals)
    try:
        deadline = time.monotonic() + 10
        while not ready.exists():
            test.assertIsNone(proc.poll(), 'the script ended before its blocking step')
            test.assertLess(time.monotonic(), deadline, 'the script never reached its blocking step')
            time.sleep(0.05)
        os.killpg(proc.pid, sig)
        _, err = proc.communicate(timeout=10)
        return proc.returncode, err
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()


class PushServer:
    def __init__(self, status=200, body=b'{"ok":true}'):
        self.calls = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                owner.calls.append(self.path)
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        self.server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    @property
    def url(self):
        return f'http://127.0.0.1:{self.server.server_port}/api/push/synthetic?status=up&msg=OK&ping='


class HostHelpers(unittest.TestCase):
    def run_push(self, env):
        return subprocess.run(['/bin/sh', str(HOST / 'kasten-push')],
                              env={'PATH': os.defpath + ':/opt/homebrew/bin', **env}, capture_output=True,
                              text=True, timeout=10)

    def test_indented_swap_rows_are_disabled(self):
        source = (HOST / 'install.sh').read_text()
        pattern = re.search(r"sed -i -E '([^']+)' /etc/fstab", source).group(1)
        sample = ('  /swapfile none swap sw 0 0\n'
                  '\tUUID=123 none\tswap\tsw 0 0\n'
                  '/swapfile2 none swap sw 0 0\n'
                  # fstab(5): the options field and everything after it are optional.
                  '/swapfile3 none swap\n'
                  'UUID=abc none swap\n'
                  '/swapfile4\tnone\tswap\n'
                  '  /swapfile5 none swap  \n'
                  '# /disabled none swap sw 0 0\n'
                  '/data none swapx sw 0 0\n'
                  '/dev/root / ext4 defaults 0 1\n')
        result = subprocess.run(['sed', '-E', pattern], input=sample,
                                capture_output=True, text=True, check=True)
        active = [line for line in result.stdout.splitlines()
                  if line.strip() and not line.lstrip().startswith('#')]
        self.assertEqual(active, ['/data none swapx sw 0 0', '/dev/root / ext4 defaults 0 1'])
        self.assertIn('# /disabled none swap sw 0 0', result.stdout)

    def run_swap_step(self, fstab_text, sed):
        """Runs install.sh's actual step_swap on a scratch fstab, with zram already active."""
        source = (HOST / 'install.sh').read_text()
        step = ''.join(shell_function(source, name) for name in ['fstab_swap', 'step_swap'])
        with tempfile.TemporaryDirectory(prefix='kasten-swap-test-') as tmp:
            work = Path(tmp)
            fstab, swaps = work / 'fstab', work / 'swaps'
            fstab.write_text(fstab_text)
            swaps.write_text('Filename Type Size Used Priority\n/dev/zram0 partition 1024 0 100\n')
            script = ('set -eu\n'
                      'log() { printf "install: %s\\n" "$*" >&2; }\n'
                      'die() { printf "install: error: %s\\n" "$*" >&2; exit 1; }\n'
                      'HOST_DIR=/nonexistent\nput() { CHANGED=false; }\nsystemctl() { :; }\nswapoff() { :; }\n' +
                      sed + '\n' +
                      step.replace('/etc/fstab', str(fstab)).replace('/proc/swaps', str(swaps)) + 'step_swap\n')
            result = subprocess.run(['/bin/sh', '-c', script], env={'PATH': os.defpath},
                                    capture_output=True, text=True, timeout=10)
            return result, fstab.read_text()

    def test_swap_step_disables_every_disk_swap_row_or_stops(self):
        fstab = 'UUID=abc none swap\n/dev/root / ext4 defaults 0 1\n'
        # GNU sed's -i, which the host has, for the BSD or GNU sed of the test machine.
        gnu_in_place = 'sed() { [ "$1 $2" = "-i -E" ] || exit 99; command sed -E "$3" "$4" >"$4.new"; mv "$4.new" "$4"; }'
        result, after = self.run_swap_step(fstab, gnu_in_place)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('commented out the swap entries', result.stderr)
        self.assertEqual([line for line in after.splitlines() if not line.startswith('#')],
                         ['/dev/root / ext4 defaults 0 1'])
        # A row that the rewrite misses must stop the install, not be reported as disabled.
        result, after = self.run_swap_step(fstab, 'sed() { :; }')
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('commented out the swap entries', result.stderr)
        self.assertIn('still has an active swap entry', result.stderr)
        self.assertEqual(after, fstab)

    def test_auto_volume_size_keeps_six_gib_of_the_free_space(self):
        size = shell_function((HOST / 'install.sh').read_text(), 'volume_size')
        gib = 1048576
        for total, avail, expected in [(40, 36, '30G'), (40, 9, None)]:
            with self.subTest(total=total, avail=avail):
                script = ('die() { printf "install: error: %s\\n" "$*" >&2; exit 1; }\n'
                          'df() { case $2 in --output=size) v=$AUDIT_SIZE ;; --output=avail) v=$AUDIT_AVAIL ;; *) exit 99 ;; esac; '
                          'printf "Header\\n%12s\\n" "$v"; }\n'
                          'KASTEN_DATA_SIZE=auto\n' + size + 'volume_size\n')
                result = subprocess.run(['/bin/sh', '-c', script], capture_output=True, text=True, timeout=10,
                                        env={'PATH': os.defpath, 'AUDIT_SIZE': str(total * gib),
                                             'AUDIT_AVAIL': str(avail * gib)})
                if expected is None:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('too little free space', result.stderr)
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), expected)

    def test_volume_creation_cleans_up_when_a_signal_ends_it(self):
        source = (HOST / 'install.sh').read_text()
        functions = ''.join(shell_function(source, name) for name in ['abort_volume', 'create_volume'])
        for shell, sig in [(shell, sig) for shell in SHELLS for sig in STOP_SIGNALS]:
            with self.subTest(shell=shell, sig=sig.name), tempfile.TemporaryDirectory(prefix='kasten-volume-test-') as tmp:
                work = Path(tmp)
                ready = work / 'ready'
                write_stubs(work / 'bin', {
                    'truncate': ': >"$3"', 'logger': 'exit 0', 'mountpoint': 'exit 1', 'umount': 'exit 0',
                    'losetup': 'case " $* " in *" --show "*) echo /dev/loop9 ;; *" DIO "*) echo 1 ;; esac',
                    # luksFormat is the long step: argon2id with 256 MiB.
                    'cryptsetup': f'case $1 in luksFormat) cat >/dev/null; : >{ready}; exec sleep 30 ;; esac; exit 1'})
                script = ('set -eu\n'
                          'log() { printf "install: %s\\n" "$*" >&2; }\n'
                          'die() { printf "install: error: %s\\n" "$*" >&2; exit 1; }\n'
                          'volume_size() { echo 2G; }\nvolume_dirs() { :; }\n'
                          f'LUKS_FILE={work}/kasten.luks MNT={work}/mnt KASTEN_DM_NAME=kasten '
                          'PASSPHRASE=synthetic-passphrase-0123456789\n' + functions + 'create_volume\n')
                code, err = interrupt(self, shell, ['-c', script], {'PATH': f'{work}/bin:' + os.defpath}, ready, sig)
                self.assertEqual(code, 128 + sig, err)
                self.assertIn('removing the incomplete', err)
                self.assertFalse((work / 'kasten.luks.new').exists())

    def bootstrap_fixture(self, work, podman_stub, setpriv_stub=''):
        """The actual kasten-bootstrap with its paths under work and stub commands. The stub
        setpriv records its arguments in work/setpriv-calls, then runs the command it was given."""
        source = (HOST / 'kasten-bootstrap').read_text()
        lib = (HOST / 'podman.sh').read_text()
        (work / 'cli').mkdir()
        (work / 'cli/kasten.json').write_text('{}\n')
        (work / 'recovery-admin').write_text('admin:synthetic\n')
        (work / '.env').write_text('KASTEN_VERSION=synthetic\nKASTEN_VOLUME_ID=\n')
        (work / 'host.env').write_text('KASTEN_MAIL_UID=526812\n')
        self.assertIn('KASTEN_ENV_FILE=/opt/kasten/.env', lib)
        (work / 'podman.sh').write_text(lib.replace('KASTEN_ENV_FILE=/opt/kasten/.env', f'KASTEN_ENV_FILE={work}/.env'))
        script = source
        for old, new in [('. /usr/local/lib/kasten/podman.sh', f'. {work}/podman.sh'),
                         ('HOST_ENV=/etc/kasten/host.env', f'HOST_ENV={work}/host.env'),
                         ('PATH=/usr/sbin:/usr/bin', f'PATH={work}/bin:/usr/bin:/bin'),
                         ('CLI_DIR=/var/lib/kasten/cli', f'CLI_DIR={work}/cli'),
                         ('RECOVERY_ADMIN=/var/lib/kasten/data/secrets/recovery-admin',
                          f'RECOVERY_ADMIN={work}/recovery-admin'),
                         ('DATABASE=/var/lib/kasten/data/stalwart/stalwart.sqlite', f'DATABASE={work}/absent'),
                         ('UNFINISHED=/var/lib/kasten/.kasten-bootstrap-incomplete', f'UNFINISHED={work}/unfinished')]:
            self.assertIn(old, script)
            script = script.replace(old, new)
        (work / 'kasten-bootstrap').write_text(script)
        write_stubs(work / 'bin', {
            'id': 'echo 0', 'mountpoint': 'exit 0', 'systemctl': 'exit 1',
            # install [options] <source> <target>: only the marker file is installed.
            'install': 'for a do src=${dst:-}; dst=$a; done; cp "$src" "$dst"',
            'setpriv': f'printf "%s\\n" "$*" >>{work}/setpriv-calls\n{setpriv_stub}\n'
                       'while :; do case $1 in --*) shift ;; *) break ;; esac; done\nexec "$@"',
            'kasten-podman': f'printf "%s\\n" "$*" >>{work}/podman-calls\n{podman_stub}'})
        return work / 'kasten-bootstrap', {'PATH': f'{work}/bin:' + os.defpath}

    def test_bootstrap_cleans_up_when_a_signal_ends_it(self):
        for shell, sig in [(shell, sig) for shell in SHELLS for sig in STOP_SIGNALS]:
            with self.subTest(shell=shell, sig=sig.name), tempfile.TemporaryDirectory(prefix='kasten-bootstrap-test-') as tmp:
                work = Path(tmp)
                ready = work / 'ready'
                # The recovery container's start is the blocking step.
                script, env = self.bootstrap_fixture(work, f'case $1 in run) : >{ready}; exec sleep 30 ;; esac')
                code, err = interrupt(self, shell, [str(script)], env, ready, sig)
                self.assertEqual(code, 128 + sig, err)
                self.assertFalse((work / 'cli/recovery-admin').exists(), 'the copy of the recovery login was left behind')
                self.assertIn('rm --force --ignore --depend --time=30 kasten-recovery',
                              (work / 'podman-calls').read_text().splitlines())

    def test_bootstrap_copies_the_recovery_login_as_its_owners_not_as_root(self):
        # data/ belongs to the server's user and cli/ to kasten: a link that either left there
        # must not lead root's read or write. So the server's user reads, and kasten writes.
        with tempfile.TemporaryDirectory(prefix='kasten-bootstrap-test-') as tmp:
            work = Path(tmp)
            seen = work / 'copy-at-recovery-start'
            script, env = self.bootstrap_fixture(work, f'case $1 in run) cp {work}/cli/recovery-admin {seen}; exit 1 ;; esac')
            result = subprocess.run(['sh', str(script)], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(seen.read_text(), 'admin:synthetic\n', result.stderr)
            # The two sides of the pipe start together, so either may record first.
            calls = sorted((work / 'setpriv-calls').read_text().splitlines())
            self.assertEqual(len(calls), 2, calls)
            writer, reader = calls
            self.assertEqual(reader, f'--reuid=526812 --regid=526812 --clear-groups cat {work}/recovery-admin')
            self.assertRegex(writer, r'^--reuid=2600 --regid=2600 --init-groups sh -c .* sh ' + re.escape(f'{work}/cli/recovery-admin') + '$')
            self.assertFalse((work / 'cli/recovery-admin').exists(), 'the copy of the recovery login was left behind')

    def test_bootstrap_stops_when_the_server_user_cannot_read_the_recovery_login(self):
        # As when data/secrets/recovery-admin is a link to a file of root's: the server's user
        # cannot read it, so no copy is made and no container starts.
        with tempfile.TemporaryDirectory(prefix='kasten-bootstrap-test-') as tmp:
            work = Path(tmp)
            script, env = self.bootstrap_fixture(
                work, '', setpriv_stub='case " $* " in *" --reuid=526812 "*) echo "cat: Permission denied" >&2; exit 1 ;; esac')
            result = subprocess.run(['sh', str(script)], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn('could not copy', result.stderr)
            self.assertNotIn('run ', (work / 'podman-calls').read_text())
            self.assertFalse((work / 'cli/recovery-admin').exists())

    def test_tang_firewall_loads_without_nftables_destroy(self):
        # "destroy" needs nftables 1.0.7 and Linux 6.3; Debian 12 has 1.0.6 and 6.1, and the Tang
        # host is an existing server. Declaring and deleting the table first replaces it
        # atomically, in one nft -f batch, on every nftables version.
        lines = (ROOT / 'deploy/tang/kasten-tang.nft').read_text().splitlines()
        statements = [line.strip() for line in lines if line.strip() and not line.lstrip().startswith('#')]
        self.assertFalse(any(statement.split()[0] == 'destroy' for statement in statements), statements)
        self.assertEqual(statements[:3],
                         ['table inet kasten_tang', 'delete table inet kasten_tang', 'table inet kasten_tang {'])

    def test_server_version_does_not_present_the_rules_pin_as_active(self):
        # Stalwart imports the spam rules only at a new volume's first start, so the image's pin
        # does not say which rules a running server uses. It belongs to the pins list only.
        source = (ROOT / 'server/bin/kasten-server').read_text()
        with tempfile.TemporaryDirectory(prefix='kasten-version-test-') as tmp:
            work = Path(tmp)
            shutil.copy(ROOT / 'server/PINS', work / 'PINS')
            write_stubs(work / 'bin', {'id': 'echo 2525', 'dpkg': 'echo amd64', 'sqlite3': 'echo 3.46.1 2024-08-13',
                                       'stalwart': 'echo "Stalwart 1.0.1"', 'restic': 'echo "restic 0.19.1"',
                                       'unbound': 'echo "Version 1.22.0"'})
            for old in ['readonly IMAGE_DIR=/opt/kasten', '/usr/local/bin/stalwart', '/usr/local/bin/restic',
                        '/usr/sbin/unbound']:
                self.assertIn(old, source)
            source = (source.replace('readonly IMAGE_DIR=/opt/kasten', f'readonly IMAGE_DIR={work}')
                      .replace('/usr/local/bin/', f'{work}/bin/').replace('/usr/sbin/unbound', f'{work}/bin/unbound'))
            (work / 'kasten-server').write_text(source)
            result = subprocess.run(['bash', str(work / 'kasten-server'), 'version'], capture_output=True, text=True,
                                    env={'PATH': f'{work}/bin:' + os.defpath}, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        binaries, pins = result.stdout.split('pins (', 1)
        self.assertIn('stalwart: Stalwart 1.0.1', binaries)
        self.assertNotIn('spam-rules', binaries)
        self.assertRegex(pins, r'\n  spam-rules +3\.0\.3 +sha256:43124c2e')

    def test_push_accepts_only_acknowledged_heartbeat(self):
        for status, body, success in [(200, b'{"ok":true}', True),
                                      (200, b'{"ok":false,"msg":"Monitor not found"}', False),
                                      (200, b'<html>proxy</html>', False),
                                      (404, b'{"ok":true}', False)]:
            with self.subTest(status=status, body=body), PushServer(status, body) as server:
                result = self.run_push({'KASTEN_PUSH_URL': server.url})
                self.assertEqual(result.returncode == 0, success, result.stderr)
                self.assertNotIn(server.url, result.stdout + result.stderr)

    def test_check_runs_one_aggregate_check_for_every_account(self):
        # kasten check combines every non-probe account into one report and one Kuma heartbeat,
        # so a healthy account cannot overwrite another account's down. kasten-check runs it once,
        # with the caller's arguments, and keeps its exit status.
        with tempfile.TemporaryDirectory(prefix='kasten-host-test-') as tmp:
            work = Path(tmp)
            calls = work / 'calls'
            write_stubs(work / 'bin', {'kasten-cli': f'printf "%s\\n" "$*" >>{calls}; exit 1'})
            result = subprocess.run(['/bin/sh', str(HOST / 'kasten-check'), '--no-push'],
                                    env={'PATH': f'{work}/bin:/usr/bin:/bin'}, capture_output=True,
                                    text=True, timeout=10)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertEqual(calls.read_text().splitlines(), ['check --config /etc/kasten/kasten.json --no-push'])

    def test_unlock_event_is_down_without_exposing_url(self):
        for body, succeeds in [(b'{"ok":true}', True), (b'{"ok":false}', False)]:
            with tempfile.TemporaryDirectory(prefix='kasten-event-test-') as tmp, PushServer(body=body) as server:
                work = Path(tmp)
                url_file = work / 'url'
                url_file.write_text(server.url + '\n')
                url_file.chmod(0o600)
                settings = work / 'host.env'
                settings.write_text(f'KASTEN_UNLOCK_PUSH_URL_FILE={url_file}\n')
                source = (HOST / 'kasten-unlock-event').read_text().replace('/etc/kasten/host.env', str(settings))
                result = subprocess.run(['/bin/sh', '-c', source, str(HOST / 'kasten-unlock-event'), 'ok', 'tang'],
                                        env={'PATH': os.defpath + ':/opt/homebrew/bin'}, capture_output=True,
                                        text=True, timeout=10)
                self.assertEqual(result.returncode == 0, succeeds, result.stderr)
                self.assertNotIn(server.url, result.stdout + result.stderr)
                query = parse_qs(urlsplit(server.calls[0]).query)
                self.assertEqual(query['status'], ['down'])
                self.assertIn('acknowledge after review', query['msg'][0])

    def test_push_requires_private_url_file(self):
        with tempfile.TemporaryDirectory(prefix='kasten-push-test-') as tmp, PushServer() as server:
            path = Path(tmp) / 'url'
            path.write_text(server.url + '\n')
            path.chmod(0o644)
            result = self.run_push({'KASTEN_PUSH_URL_FILE': str(path)})
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(server.calls, [])
            path.chmod(0o600)
            result = self.run_push({'KASTEN_PUSH_URL_FILE': str(path)})
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_personal_host_does_not_enable_observer_timers(self):
        source = (HOST / 'install.sh').read_text()
        units = source.split('step_units() {', 1)[1].split('\nrender_nft()', 1)[0]
        with tempfile.TemporaryDirectory(prefix='kasten-install-test-') as tmp:
            work = Path(tmp)
            script = ('put() { :; }; write_env() { :; }; '
                      'systemctl() { printf "%s\\n" "$*" >>"$AUDIT_UNITS"; }; '
                      f'HOST_DIR={HOST}; DEPLOY_DIR={ROOT / "deploy"}; '
                      'step_units() {' + units + '\nstep_units\n')
            result = subprocess.run(['/bin/sh', '-c', script], env={'PATH': os.defpath,
                                    'AUDIT_UNITS': str(work / 'units')}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            enables = [line for line in (work / 'units').read_text().splitlines() if line.startswith('enable ')]
            self.assertIn('enable --now kasten-backup.timer', enables)
            # The release upgrade disables both while the volume stays locked; a rerun enables both.
            self.assertIn('enable kasten-unlock.service kasten.service', enables)
            self.assertFalse(any('kasten-check.timer' in line or 'kasten-probe.timer' in line for line in enables))

    def test_residue_check_detects_plaintext_leak_without_printing_it(self):
        marker = 'synthetic-residue-marker-0123456789'
        with tempfile.TemporaryDirectory(prefix='kasten-residue-test-') as tmp:
            work = Path(tmp)
            control = work / 'canary'
            control.write_text(marker + '\n')
            scan = work / 'root'
            scan.mkdir()
            (scan / 'benign').write_text('no readable mail here\n')
            args = ['/bin/sh', str(HOST / 'kasten-residue-check'), str(control), str(scan)]
            clean = subprocess.run(args, capture_output=True, text=True, timeout=10)
            self.assertEqual(clean.returncode, 0, clean.stderr)
            (scan / 'leak').write_text('readable body ' + marker + '\n')
            dirty = subprocess.run(args, capture_output=True, text=True, timeout=10)
            self.assertEqual(dirty.returncode, 1, dirty.stderr)
            self.assertIn('unencrypted canary matches: 1', dirty.stdout)
            self.assertNotIn(marker, dirty.stdout + dirty.stderr)
            (scan / 'leak').unlink()
            restored = subprocess.run(args, capture_output=True, text=True, timeout=10)
            self.assertEqual(restored.returncode, 0, restored.stderr)

    def test_residue_host_guard_refuses_missing_mount_wrong_mapper_and_disk_swap(self):
        source = (HOST / 'kasten-residue-check').read_text()
        guard = 'verify_host_protection() {' + source.split('verify_host_protection() {', 1)[1].split('\nif [ "$#"', 1)[0]
        with tempfile.TemporaryDirectory(prefix='kasten-residue-guard-') as tmp:
            work = Path(tmp)
            swaps = work / 'swaps'
            for mode, swap, succeeds in [('ok', '/dev/zram0', True), ('missing', '/dev/zram0', False),
                                          ('wrong', '/dev/zram0', False), ('ok', '/swapfile', False)]:
                with self.subTest(mode=mode, swap=swap):
                    swaps.write_text(f'Filename Type Size Used Priority\n{swap} file 100 0 -2\n')
                    script = ('mountpoint() { [ "$AUDIT_MODE" != missing ]; }; '
                              'findmnt() { if [ "$AUDIT_MODE" = wrong ]; then echo /dev/root; else echo /dev/mapper/kasten; fi; }; '
                              'cryptsetup() { echo "type: LUKS2"; };\n' +
                              guard.replace('/proc/swaps', str(swaps)).replace('/etc/kasten/host.env', str(work / 'absent.env')) +
                              '\nverify_host_protection\n')
                    result = subprocess.run(['/bin/sh', '-c', script], env={'PATH': os.defpath, 'AUDIT_MODE': mode},
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode == 0, succeeds, result.stderr)

    def run_unlock_start(self, work, settings, stubs, volume=True, command=('kasten-unlock', 'start')):
        """Runs the actual kasten-unlock start in work, or another command of the actual unlock
        helpers, with stub commands for the host tools."""
        (work / 'host.env').write_text(settings)
        if volume:
            (work / 'volume').touch()
        (work / 'mount').mkdir()
        for name in ['kasten-unlock', 'kasten-unlock-passphrase', 'kasten-unlock-event', 'kasten-push']:
            source = (HOST / name).read_text().replace('/etc/kasten/host.env', str(work / 'host.env'))
            if name == 'kasten-unlock':
                source = source.replace('LUKS_FILE=/var/lib/kasten.luks', f'LUKS_FILE={work}/volume')
                source = source.replace('MNT=/var/lib/kasten', f'MNT={work}/mount')
            (work / name).write_text(source)
            # kasten-unlock-passphrase runs its helper directly.
            (work / name).chmod(0o700)
        bins = work / 'bin'
        bins.mkdir()
        stubs = {'mount': 'exit 0', 'logger': 'exit 0',
                 'losetup': 'case " $* " in *" DIO "*) echo 1 ;; *) echo /dev/loop0 ;; esac', **stubs}
        for name, body in stubs.items():
            path = bins / name
            path.write_text('#!/bin/sh\n' + body + '\n')
            path.chmod(0o700)
        return subprocess.run(['/bin/sh', str(work / command[0]), *command[1:]],
                              env={'PATH': f'{bins}:' + os.defpath + ':/opt/homebrew/bin'},
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)

    def test_unlock_monitor_failure_is_visible_without_blocking_mounted_mail(self):
        with tempfile.TemporaryDirectory(prefix='kasten-unlock-test-') as tmp, PushServer(body=b'{"ok":false}') as server:
            work = Path(tmp)
            url = work / 'url'
            url.write_text(server.url + '\n')
            url.chmod(0o600)
            result = self.run_unlock_start(work, f'KASTEN_UNLOCK_PUSH_URL_FILE={url}\n',
                                           {'mountpoint': 'exit 1', 'cryptsetup': 'exit 0'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('unlock event could not reach monitoring', result.stderr)
            self.assertNotIn(server.url, result.stdout + result.stderr)

    def test_unlock_unit_retries_tang_failures_and_then_starts_mail(self):
        unit = {}
        for line in (HOST / 'units/kasten-unlock.service').read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                key, value = line.split('=', 1)
                unit.setdefault(key, []).append(value)
        self.assertEqual(unit.get('Type'), ['oneshot'])
        # systemd refuses Restart=always and on-success for a oneshot unit.
        self.assertEqual(unit.get('Restart'), ['on-failure'])
        self.assertTrue(unit.get('RestartSec'))
        # A restart does not start kasten.service, whose start job failed with the unlock. A
        # blocking start would wait for this unit's own start to finish; a failed start must not
        # undo the mount, so the command's own failure is only logged.
        self.assertIn('-/usr/bin/systemctl --no-block start kasten.service', unit.get('ExecStartPost', []))
        prevented = {int(code) for value in unit.get('RestartPreventExitStatus', []) for code in value.split()}
        self.assertTrue(prevented, 'permanent failures need RestartPreventExitStatus=')
        tang_down = {'mountpoint': 'exit 1', 'cryptsetup': 'exit 1', 'sleep': 'exit 0',
                     'timeout': 'while :; do case $1 in -* | [0-9]*) shift ;; *) break ;; esac; done; exec "$@"',
                     'clevis': 'case $2 in list) echo "1: tang \'{}\'" ;; *) echo "Tang unreachable" >&2; exit 1 ;; esac'}
        cases = [('Tang does not answer', tang_down, True, True),
                 ('the volume file is missing', {'mountpoint': 'exit 1'}, False, False),
                 ('the volume has no Tang binding', {**tang_down, 'clevis': 'exit 0'}, True, False),
                 ('another file system is mounted there',
                  {'mountpoint': 'exit 0', 'findmnt': 'echo /dev/vda1'}, True, False)]
        for name, stubs, volume, retried in cases:
            with self.subTest(name), tempfile.TemporaryDirectory(prefix='kasten-unlock-retry-') as tmp:
                result = self.run_unlock_start(Path(tmp), 'KASTEN_UNLOCK_TIMEOUT=0\n', stubs, volume)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.returncode not in prevented, retried, f'exit {result.returncode}: {result.stderr}')

    def test_mail_unit_stops_the_container_even_after_a_cancelled_start(self):
        unit = {}
        for line in (HOST / 'units/kasten.service').read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                key, value = line.split('=', 1)
                unit.setdefault(key, []).append(value)
        # kasten-unlock.service starts this unit with --no-block, so a lock can stop the unlock
        # while this unit's start is still waiting for the health check. systemd then cancels the
        # start and skips ExecStop=, which runs only after a start that succeeded; the container
        # would keep the volume busy and cryptsetup close would fail. ExecStopPost= runs in every
        # case.
        self.assertIn('/usr/local/sbin/kasten-mail-service stop', unit.get('ExecStopPost', []))
        self.assertNotIn('/usr/local/sbin/kasten-mail-service stop', unit.get('ExecStop', []))
        # Rootless Podman moves itself out of the unit's cgroup. The first start command becomes
        # the podman process (exec), which systemd signals by its id and waits for before
        # ExecStopPost=.
        self.assertEqual(unit.get('ExecStart'), ['/usr/local/sbin/kasten-mail-service start',
                                                 '/usr/local/sbin/kasten-mail-service wait'])
        self.assertIn('exec kasten-podman run --detach', (HOST / 'kasten-mail-service').read_text())
        # The kasten user's manager holds the containers' cgroups and Podman's session bus. Ordered
        # after it, this unit stops first at a shutdown, while Podman still works.
        self.assertIn('user@2600.service', unit['Requires'][0].split())
        self.assertIn('user@2600.service', unit['After'][0].split())

    def test_container_output_of_one_shot_units_has_a_fixed_journal_identifier(self):
        # Rootless Podman moves itself out of the unit's cgroup, so journald files the container's
        # output under user@2600.service and "journalctl -u" misses it. The docs read it with
        # "journalctl -t <name>", which works only when the unit names its stream.
        for name in ['kasten-check', 'kasten-probe', 'kasten-backup']:
            with self.subTest(name):
                unit = {}
                for line in (HOST / f'units/{name}.service').read_text().splitlines():
                    if '=' in line and not line.startswith('#'):
                        key, value = line.split('=', 1)
                        unit.setdefault(key, []).append(value)
                self.assertEqual(unit.get('SyslogIdentifier'), [name])

    def test_containers_have_one_definition(self):
        # podman.sh holds the argument lists of the mail and CLI containers, so the mail service,
        # its one-shot runs, recovery mode and every CLI run get the same limits and hardening.
        lib = (HOST / 'podman.sh').read_text()
        mail = re.search(r'MAIL_ARGS="([^"]*)"', lib).group(1).split()
        cli = re.search(r'CLI_ARGS="([^"]*)"', lib).group(1).split()
        self.assertIn('--memory=768m', mail)
        self.assertIn('--memory=384m', cli)
        # As PID 1 the CLI's node process ignores SIGTERM: a stopped unit would leave its container.
        self.assertIn('--init', cli)
        runs = []
        for path in sorted(HOST.iterdir()):
            if not path.is_file() or path.name == 'podman.sh':
                continue
            text = path.read_text(errors='replace').replace('\\\n', ' ')
            self.assertNotRegex(text, r'--memory|--cap-drop|--security-opt', path.name)
            for line in text.splitlines():
                if re.search(r'kasten-podman run\b', line) and not line.lstrip().startswith('#'):
                    runs.append(path.name)
                    self.assertRegex(line, r'\$MAIL_ARGS|\$CLI_ARGS', f'{path.name}: {line.strip()}')
        # kasten-bootstrap runs recovery mode and the CLI.
        self.assertEqual(runs, ['kasten-bootstrap', 'kasten-bootstrap', 'kasten-cli', 'kasten-mail-run',
                                'kasten-mail-service'])

    def run_podman_wrapper(self, work, args, enforce, marker=False, env=None):
        """Runs the actual kasten-podman with stub commands; the stub setpriv records what Podman
        would get: its arguments and its environment."""
        source = (HOST / 'kasten-podman').read_text()
        bus, marker_path = work / 'bus', work / 'test-without-selinux'
        for old, new in [('"/run/user/$KASTEN_UID/bus"', f'"{bus}"'), ('MARKER=/etc/kasten/test-without-selinux',
                                                                        f'MARKER={marker_path}'),
                         ('PATH=/usr/sbin:/usr/bin', f'PATH={work}/bin')]:
            self.assertIn(old, source)
            source = source.replace(old, new)
        (work / 'kasten-podman').write_text(source)
        if not bus.exists():
            server = socket.socket(socket.AF_UNIX)
            server.bind(str(bus))
            server.close()
        if marker:
            marker_path.touch()
        elif marker_path.exists():
            marker_path.unlink()
        seen_args, seen_env = work / 'seen-args', work / 'seen-env'
        if not (work / 'bin').exists():
            write_stubs(work / 'bin', {'id': 'echo 0', 'logger': f'printf "%s\\n" "$*" >>{work}/logged',
                                       'getenforce': 'echo "$AUDIT_SELINUX"',
                                       # The shell adds only PWD, SHLVL and _ to what env then prints.
                                       'setpriv': f'printf "%s\\n" "$@" >{seen_args}\nexec /usr/bin/env >{seen_env}'})
        for path in (seen_args, seen_env):
            if path.exists():
                path.unlink()
        result = subprocess.run(['/bin/sh', str(work / 'kasten-podman'), *args], capture_output=True, text=True,
                                env={'PATH': f'{work}/bin:' + os.defpath, 'AUDIT_SELINUX': enforce, **(env or {})},
                                timeout=10)
        if not seen_env.exists():
            return result, None
        passed = dict(line.split('=', 1) for line in seen_env.read_text().splitlines())
        return result, {'args': seen_args.read_text().splitlines(),
                        'env': {name: value for name, value in passed.items() if name not in ('PWD', 'SHLVL', '_')}}

    def test_podman_runs_as_kasten_with_only_its_own_environment(self):
        with tempfile.TemporaryDirectory(prefix='kasten-podman-') as tmp:
            work = Path(tmp)
            result, seen = self.run_podman_wrapper(work, ['ps', '-a'], 'Enforcing', env={
                'TERM': 'xterm', 'RESTIC_REPOSITORY': 'rest:http://synthetic.test/repo',
                'KASTEN_UNRELATED': 'synthetic-value', 'HOME': '/root'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(seen['args'], ['--reuid=2600', '--regid=2600', '--init-groups', 'podman', 'ps', '-a'])
            # The values come from the caller only for TERM and the three backup settings.
            self.assertEqual(seen['env'], {'PATH': f'{work}/bin', 'HOME': '/home/kasten',
                                           'XDG_RUNTIME_DIR': '/run/user/2600',
                                           'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/2600/bus',
                                           'TERM': 'xterm', 'RESTIC_REPOSITORY': 'rest:http://synthetic.test/repo'})

    def test_podman_creates_no_container_unless_selinux_enforces_or_the_test_marker_exists(self):
        with tempfile.TemporaryDirectory(prefix='kasten-podman-') as tmp:
            work = Path(tmp)
            for args in [['run', '--rm', 'image'], ['create', 'image'], ['container', 'run', 'image'],
                         ['container', 'create', 'image']]:
                for mode in ['Permissive', 'Disabled', '']:
                    with self.subTest(args=args, mode=mode):
                        result, seen = self.run_podman_wrapper(work, args, mode)
                        self.assertEqual(result.returncode, 125, result.stderr)
                        self.assertIn('SELinux is not enforcing', result.stderr)
                        self.assertIsNone(seen, 'Podman ran')
                with self.subTest(args=args, mode='Enforcing'):
                    result, seen = self.run_podman_wrapper(work, args, 'Enforcing')
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(seen['args'][4:], args)
                    self.assertNotIn('WARNING', result.stderr)
            # Commands that create no container, such as a stop at a lock, need no check.
            for args in [['stop', 'kasten-mail'], ['rm', '--force', 'kasten-mail'], ['load'], ['exec', 'kasten-mail', 'x']]:
                with self.subTest(args=args):
                    result, seen = self.run_podman_wrapper(work, args, 'Disabled')
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(seen['args'][4:], args)
            # The local test's marker lets a container start, loudly, and the journal records it.
            result, seen = self.run_podman_wrapper(work, ['run', '--rm', 'image'], 'Disabled', marker=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIsNotNone(seen)
            self.assertIn('WARNING', result.stderr)
            self.assertIn('event=selinux-check result=skipped', (work / 'logged').read_text())

    def test_install_needs_enforcing_targeted_selinux_with_mcs(self):
        gate = shell_function((HOST / 'install.sh').read_text(), 'selinux_gate')
        self.assertIn('/sys/fs/selinux/mls', gate)
        for mode, mls, policy, marker, succeeds in [
                ('Enforcing', '1', 'targeted', False, True),
                ('Permissive', '1', 'targeted', False, False),
                ('Disabled', '', '', False, False),
                ('Enforcing', '0', 'targeted', False, False),
                ('Enforcing', '1', 'mls', False, False),
                # Only the local container test creates the marker.
                ('Disabled', '', '', True, True)]:
            with self.subTest(mode=mode, mls=mls, policy=policy, marker=marker), \
                    tempfile.TemporaryDirectory(prefix='kasten-selinux-') as tmp:
                work = Path(tmp)
                (work / 'mls').write_text(mls + '\n' if mls else '')
                if marker:
                    (work / 'marker').touch()
                write_stubs(work / 'bin', {'getenforce': f'echo {mode}', 'logger': 'exit 0',
                                           'sestatus': f'printf "Loaded policy name:             %s\\n" {policy or "-"}'})
                script = ('log() { printf "install: %s\\n" "$*" >&2; }\n'
                          'die() { printf "install: error: %s\\n" "$*" >&2; exit 1; }\n'
                          f'NO_SELINUX_MARKER={work}/marker\n' +
                          gate.replace('/sys/fs/selinux/mls', str(work / 'mls')) + 'selinux_gate\n')
                result = subprocess.run(['/bin/sh', '-c', script], env={'PATH': f'{work}/bin:' + os.defpath},
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode == 0, succeeds, result.stderr)
                self.assertEqual('WARNING' in result.stderr, marker, result.stderr)

    def test_unlock_waiting_for_tang_accepts_a_concurrent_passphrase_unlock(self):
        # kasten-unlock-passphrase opens the volume while the unit's start waits for Tang, and
        # mounts it either before or after that start does.
        for name, mount, events in [('the passphrase mounted first', 'echo "already mounted" >&2; exit 32', []),
                                    ('this start mounted first', 'exit 0', ['method=existing'])]:
            with self.subTest(name), tempfile.TemporaryDirectory(prefix='kasten-unlock-race-') as tmp:
                work = Path(tmp)
                log = work / 'events'
                stubs = {'mountpoint': 'exit 1', 'sleep': 'exit 0', 'mount': mount,
                         # Closed at the first check, open from then on.
                         'cryptsetup': '[ -e "$0.open" ] || { : >"$0.open"; exit 1; }',
                         'timeout': 'while :; do case $1 in -* | [0-9]*) shift ;; *) break ;; esac; done; exec "$@"',
                         'clevis': 'case $2 in list) echo "1: tang \'{}\'" ;; *) echo "Tang unreachable" >&2; exit 1 ;; esac',
                         'findmnt': 'echo /dev/mapper/kasten',
                         'logger': f'printf "%s\\n" "$*" >>{log}'}
                result = self.run_unlock_start(work, 'KASTEN_UNLOCK_TIMEOUT=0\n', stubs)
                self.assertEqual(result.returncode, 0, result.stderr)
                unlocks = [line for line in (log.read_text().splitlines() if log.exists() else [])
                           if 'event=unlock ' in line]
                self.assertEqual([re.search(r'method=\S+', line).group(0) for line in unlocks], events)

    def test_unlock_does_not_mount_again_what_the_passphrase_mounted_meanwhile(self):
        # Seen in the deploy test: the kernel stacks a second ext4 mount of the same device on
        # the same directory, so the start must look again before it mounts.
        with tempfile.TemporaryDirectory(prefix='kasten-unlock-stack-') as tmp:
            work = Path(tmp)
            calls, log = work / 'calls', work / 'events'
            stubs = {'sleep': 'exit 0',
                     # Not mounted at the start's first look; mounted by the passphrase from then on.
                     'mountpoint': '[ -e "$0.seen" ] || { : >"$0.seen"; exit 1; }',
                     'cryptsetup': '[ -e "$0.open" ] || { : >"$0.open"; exit 1; }',
                     'mount': f'echo mount >>{calls}',
                     'timeout': 'while :; do case $1 in -* | [0-9]*) shift ;; *) break ;; esac; done; exec "$@"',
                     'clevis': 'case $2 in list) echo "1: tang \'{}\'" ;; *) echo "Tang unreachable" >&2; exit 1 ;; esac',
                     'findmnt': 'echo /dev/mapper/kasten',
                     'logger': f'printf "%s\\n" "$*" >>{log}'}
            result = self.run_unlock_start(work, 'KASTEN_UNLOCK_TIMEOUT=0\n', stubs)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(calls.exists(), 'the start mounted the volume a second time')
            self.assertNotIn('event=unlock ', log.read_text() if log.exists() else '')

    def test_lock_unmounts_every_stacked_mount_before_it_closes(self):
        with tempfile.TemporaryDirectory(prefix='kasten-unlock-stop-') as tmp:
            work = Path(tmp)
            calls = work / 'calls'
            stubs = {# Two mounts stacked on the directory.
                     'mountpoint': f'[ "$(cat {calls} 2>/dev/null | grep -c umount)" -lt 2 ]',
                     'umount': f'echo umount >>{calls}',
                     'cryptsetup': f'case $1 in status) exit 0 ;; close) echo close >>{calls} ;; esac'}
            result = self.run_unlock_start(work, '', stubs, command=('kasten-unlock', 'stop'))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(calls.read_text().splitlines(), ['umount', 'umount', 'close'])

    def test_an_unlock_whose_mount_fails_locks_the_volume_again(self):
        # systemd runs ExecStop only after a start that succeeded, so a stop of the failed unit
        # cannot lock what the failed start unlocked.
        # Each unlock and lock writes one event= line, so monitoring sees the failed mount.
        cases = [('a Tang unlock', ('kasten-unlock', 'start'), False, True,
                  ['unlock failed tang mount', 'lock ok - mount']),
                 ('a passphrase unlock', ('kasten-unlock-passphrase',), False, True,
                  ['unlock ok passphrase -', 'unlock failed passphrase mount', 'lock ok - mount']),
                 # For example, opened by hand to repair the file system: not this command's to lock.
                 ('a volume that was open before', ('kasten-unlock', 'start'), True, False,
                  ['unlock failed existing mount']),
                 # The repair in docs/operations.md: open by hand, e2fsck, then the passphrase command.
                 ('a volume that was open before the passphrase command', ('kasten-unlock-passphrase',),
                  True, False, ['unlock failed passphrase mount'])]
        for name, command, open_before, closes, events in cases:
            with self.subTest(name), tempfile.TemporaryDirectory(prefix='kasten-unlock-mount-') as tmp:
                work = Path(tmp)
                state, calls, log = work / 'open', work / 'calls', work / 'events'
                if open_before:
                    state.touch()
                stubs = {'mountpoint': 'exit 1', 'findmnt': 'exit 1', 'id': 'echo 0',
                         'mount': 'echo "mount: wrong fs type, bad option, bad superblock" >&2; exit 32',
                         'cryptsetup': f'case $1 in status) [ -e {state} ] ;; open) : >{state} ;;'
                                       f' close) rm {state} && echo "close $2" >>{calls} ;; *) exit 1 ;; esac',
                         'timeout': 'while :; do case $1 in -* | [0-9]*) shift ;; *) break ;; esac; done; exec "$@"',
                         'clevis': f'case $2 in list) echo "1: tang \'{{}}\'" ;; unlock) : >{state} ;; esac',
                         'logger': f'printf "%s\\n" "$*" >>{log}'}
                result = self.run_unlock_start(work, 'KASTEN_UNLOCK_TIMEOUT=0\n', stubs, command=command)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(state.exists(), not closes, result.stderr)
                self.assertEqual(calls.read_text().splitlines() if calls.exists() else [],
                                 ['close kasten'] if closes else [])
                seen = []
                for line in log.read_text().splitlines() if log.exists() else []:
                    found = re.search(r'event=(\w+) result=(\w+)', line)
                    if found:
                        method = re.search(r' method=(\w+)', line)
                        reason = re.search(r' reason=(\w+)', line)
                        seen.append(' '.join([found[1], found[2], method[1] if method else '-',
                                              reason[1] if reason else '-']))
                self.assertEqual(seen, events)

    def test_tang_activation_reports_metadata_only(self):
        with tempfile.TemporaryDirectory(prefix='kasten-tang-test-') as tmp, PushServer() as server:
            work = Path(tmp)
            url = work / 'url'
            url.write_text(server.url + '\n')
            url.chmod(0o600)
            source = (ROOT / 'deploy/tang/kasten-tang-event').read_text()
            source = source.replace('/etc/kasten/tang-push-url', str(url))
            source = source.replace('/etc/kasten/tang-event.env', str(work / 'absent.env'))
            source = source.replace('/usr/local/sbin/kasten-push', str(HOST / 'kasten-push'))
            result = subprocess.run(['/bin/sh', '-c', source],
                                    env={'PATH': os.defpath + ':/opt/homebrew/bin'},
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            query = parse_qs(urlsplit(server.calls[0]).query)
            self.assertEqual(query['status'], ['down'])
            self.assertEqual(query['msg'], ['Tang access - acknowledge after review'])
            self.assertNotIn(server.url, result.stdout + result.stderr)

    def test_event_status_is_selectable_for_verified_native_monitor(self):
        with tempfile.TemporaryDirectory(prefix='kasten-event-status-') as tmp, PushServer() as server:
            work = Path(tmp)
            url = work / 'url'
            url.write_text(server.url + '\n')
            url.chmod(0o600)
            settings = work / 'host.env'
            settings.write_text(f'KASTEN_UNLOCK_PUSH_URL_FILE={url}\nKASTEN_EVENT_PUSH_STATUS=up\n')
            source = (HOST / 'kasten-unlock-event').read_text().replace('/etc/kasten/host.env', str(settings))
            result = subprocess.run(['/bin/sh', '-c', source, str(HOST / 'kasten-unlock-event'), 'ok', 'tang'],
                                    env={'PATH': os.defpath + ':/opt/homebrew/bin'}, capture_output=True,
                                    text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(parse_qs(urlsplit(server.calls[0]).query)['status'], ['up'])


if __name__ == '__main__':
    unittest.main()

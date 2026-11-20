# Kasten documentation

Start with the [project README](../README.md). It says what Kasten is, what you need and what it costs.

## Guides

| Guide                                           | Read it when                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Install on a VPS](install-vps.md)              | You set up a real server by hand, from choosing a VPS to moving your mail in                  |
| [Agent setup](agent-setup.md)                   | A coding agent does the setup: what you do, what it may do and what it must never get         |
| [AWS and SES](aws-ses.md)                       | You create the AWS account, the SES identity, the SMTP users and the setup permissions        |
| [DNS records](dns.md)                           | You create or check the records for your domain, or switch MX                                 |
| [Operations](operations.md)                     | You run the server: monitoring, backups, upgrades, acceptance, reboots and rotation           |
| [Security model](security.md)                   | You want to know what Kasten protects, what it does not, and when to stop                     |
| [Architecture](architecture.md)                 | You build or change Kasten: the contract between its parts                                    |
| [Stalwart v1.0.1 reference](stalwart-v1.0.1.md) | You change how Kasten talks to Stalwart: its verified behaviour, and every value setup writes |

## Component guides

| Guide                                                         | What it covers                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [cli/README.md](../cli/README.md)                             | Every `kasten` CLI command, its flags, files and exit codes, and `kasten.json`                           |
| [deploy/README.md](../deploy/README.md)                       | The production host files, the first boot, backups, the daily check and probe, and their acceptance test |
| [deploy/tang/README.md](../deploy/tang/README.md)             | The Tang host for automatic unlock, and its key backup                                                   |
| [server/README.md](../server/README.md)                       | The `kasten-server` image: its commands, data volume, backups and restore                                |
| [web/README.md](../web/README.md)                             | The web app, where plaintext lives on the device, the `kasten-web` image and its end-to-end tests        |
| [packages/core/README.md](../packages/core/README.md)         | `@kasten/core`, the library that the app and the CLI share                                               |
| [dev/README.md](../dev/README.md)                             | The local dev stack and the files in `.kasten-dev/`                                                      |
| [tests/integration/README.md](../tests/integration/README.md) | The integration tests against the dev stack                                                              |
| [tests/walkthrough/README.md](../tests/walkthrough/README.md) | The browser test that follows the README's "Try it locally"                                              |

## Order for a first install

1. Read [security](security.md), so you know the limits before you start.
2. Start [AWS and SES](aws-ses.md) on the first day. The production review can take a day or more.
3. Follow [install on a VPS](install-vps.md). It links to [DNS](dns.md) and [operations](operations.md) at the right steps. If a coding agent does the setup, read [agent setup](agent-setup.md) first; the agent follows the same guide.

## Conventions

- `example.com`, `203.0.113.10` and `2001:db8::10` stand for your domain and your VPS addresses.
- `./kasten …` drives the local dev stack only. It works after `./kasten dev up`.
- On the VPS, the kasten CLI runs as root, from any directory, as `kasten-cli <command>`, with `--config /etc/kasten/kasten.json` for the commands that read it. `security-check`, `import-imap` and `read` run on your computer instead, from a checkout, as `node cli/src/main.ts <command>`.
- `kasten-server …` is the server image's own tool. On the VPS, as root and from any directory, run `kasten-mail-run <command>` while Stalwart is stopped, or `kasten-mail-exec <command>` while it runs.
- A detail that has not yet run on real infrastructure says so, and names what is missing, for example "not yet tested on a real VPS".
- Provider facts carry the source and the date it was read. Providers change their prices and consoles, so check the source before you pay.

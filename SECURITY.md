# Security

This source is a technical preview. Use the [security model](docs/security.md) to understand who can read mail and how to protect the web app, mail host, keys, and backups.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/alexburlis/kasten/security/advisories/new) to send your report to the maintainers. You can also open **Security** → **Advisories** → **Report a vulnerability**. Keep security reports out of public issues and pull requests.

Include the affected commit or release, the relevant configuration with secrets removed, and reproduction details that use test data. Keep real emails, passwords, recovery sheets, and private keys out of reports.

## Reviewed secret-scan findings

The source scan reports three findings under the private-key rule. Review the
file hashes when preparing a release. If a file changes or the scan reports
another finding, review it before publication. The scanner runs with its
standard detection rules.

| Path                                                                                                           | Reason                                                            | SHA-256                                                          |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| [packages/core/test/fixtures/keys/you-daily.sec.asc](packages/core/test/fixtures/keys/you-daily.sec.asc)       | Disposable daily key for captured test messages.                  | 30d148e753e41568eb3b3b38c326f1f66da2f75d4a2f0c88d2c2f0f91ff17b1f |
| [packages/core/test/fixtures/keys/you-recovery.sec.asc](packages/core/test/fixtures/keys/you-recovery.sec.asc) | Disposable recovery key for the same test corpus.                 | ecfb8811257f11256a583ee28549a273efd0ec22eb65ac74fe9f778a933b710a |
| [tests/walkthrough/walkthrough.spec.ts](tests/walkthrough/walkthrough.spec.ts)                                 | PGP header string that checks a browser-generated recovery sheet. | b564ac8e9b6ecb1c09f56914d5eaead1b22ad7b4f26b98aa65260d0ca12bd1c5 |

The two fixture keys protect only test data. See [fixture provenance](packages/core/test/fixtures/README.md).

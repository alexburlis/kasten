# Test fixtures

All keys here are throwaway test keys without passphrases. They protect nothing.

## Messages from a real Stalwart v1.0.1

These were captured in October 2026 from test runs of unmodified Stalwart v1.0.1. Parity matters for them: they show what the server really stores.

The only change is in the plaintext header block before the first blank line: the original test address became `you@kasten.test`, and the original display name became `You`, and one reverse-DNS name became `localhost`. Everything after the header block is byte-identical to the original, including the Stalwart-written encrypted part. The body SHA-256 column records each body's hash, which matched the original capture.

| File                                          | What it is                                                                                                        | Body SHA-256 (same as original)                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `stalwart-v1.0.1/stored-bundle.eml`           | SMTP delivery that the server encrypted to the daily and recovery keys: two PKESKs, SEIPD v1 with MDC             | `93caa8ec1bc5e2d5575090e60c0338937702e9f96ea43daae4d802f7af689f2f` |
| `stalwart-v1.0.1/stored-key-dropped.eml`      | SMTP delivery while the bundle's recovery subkey had expired: the server silently encrypted to the daily key only | `69db6bc86571fe1157d0f82f07eacc4389d3d7ff6c12b568456fc3b4217df8ba` |
| `stalwart-v1.0.1/stored-sent-gopenpgp.eml`    | A client-built PGP/MIME Sent copy (GopenPGP) that Stalwart stored byte for byte through Email/import              | `055693fc93e49fda99a4d2ffd366aa4398c6e6a39b7ed229a9f9c2c0161f8283` |
| `stalwart-v1.0.1/as-is-smime-pkcs7.eml`       | Sender-made opaque-signed S/MIME, `application/pkcs7-mime`; stored unencrypted                                    | `f4ec390dc16eb5a1db9137c55fe9ea457659c04320a4e0ae7b5d319fb2ec3f76` |
| `stalwart-v1.0.1/as-is-fake-pgpmime.eml`      | Sender-made `multipart/encrypted` with a plaintext part; stored unencrypted                                       | `fae69f2d9932620822bbc639a1bad0b10e65abf0088fadff0a9f0702499c1512` |
| `stalwart-v1.0.1/as-is-armor-text.eml`        | Sender-made `text/plain` starting with the PGP armor line; stored unencrypted                                     | `061e7be64cf13706e75df75a151f9393bbb92dc995691baab70fcbb89b4c0046` |
| `stalwart-v1.0.1/as-is-p7m-octet-stream.eml`  | Sender-made `application/octet-stream` named `statement.p7m`; stored unencrypted                                  | `7f6a00b76b59dfe89fe600b8bcdfa105f160a96645da371d7d92fdc06f9211ef` |
| `stalwart-v1.0.1/encrypted-smime-x-pkcs7.eml` | The same S/MIME as `application/x-pkcs7-mime`: the input, which Stalwart encrypted                                | `f4ec390dc16eb5a1db9137c55fe9ea457659c04320a4e0ae7b5d319fb2ec3f76` |
| `stalwart-v1.0.1/encrypted-control.eml`       | Ordinary plain text: the input, which Stalwart encrypted                                                          | `a70b484495588435c844ee31e80bdfe1e9e596f36a056852634622ff845b4989` |

The `as-is-*` files are the sender's input, and Stalwart v1.0.1 stored them unchanged: their plaintext codes were readable in the stored copies. The two `encrypted-*` files are inputs that Stalwart encrypted, so they are not what the server stores; they test the mirror's "would encrypt" answer.

The `as-is-*` rule is `is_encrypted` in `crates/email/src/message/crypto.rs:355-404` of Stalwart v1.0.1. `test/live/classifier.live.ts` sends the same sender-made forms to the dev stack and checks what Stalwart stores.

## Keys

| File                              | Fingerprint                                | Encryption subkey                           | Origin                                                                                     |
| --------------------------------- | ------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `keys/you-daily.{sec,pub}.asc`    | `CC4452E6B281ADAD2759D5A25FF5E52A26D8E0E4` | `E651DBCB5C5CE7CB`                          | The daily key of the captures above, made by gpg 2.5 (Ed25519 and Cv25519, v4, no expiry)  |
| `keys/you-recovery.{sec,pub}.asc` | `C1B5D54A6D248B876310EAD290438A4111D3F748` | `A13D9D3B334D2531`                          | The recovery key of the captures above, made by gpg 2.5                                    |
| `keys/recovery-expired.pub.asc`   | `DB599EABDE73B66DABD2D44D41AC7DDC42BAD38A` | `2EEFC581D615E2C5`, expired in January 2024 | Made by gpg 2.5 with a faked clock; user ID `Recovery Expired-Subkey <recexp@kasten.test>` |

The two `you-*` keys keep the original key material, so the Stalwart messages above still decrypt with them. Their user IDs were replaced with `You Daily (Kasten test) <you@kasten.test>` and `You Recovery (Kasten test) <you@kasten.test>` through OpenPGP.js `reformatKey`, which re-signs the user IDs and subkey bindings and leaves the fingerprints unchanged.

Every other message in the tests is built at run time by `@kasten/core` itself, with `you@kasten.test` and `sam@kasten.test`.

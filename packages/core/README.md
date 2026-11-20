# @kasten/core

The shared TypeScript library of the Kasten web app and CLI. It is written for Node 24 and current Safari, Chrome and Firefox, including a Web Worker. Its unit tests run in Node 24 and the web app's end-to-end tests in Chromium and WebKit; Firefox is not yet tested. It uses only standard web platform APIs, such as WebCrypto, `fetch`-style transports, `URL`, `TextEncoder`/`TextDecoder`, `Intl.Segmenter`, `btoa`/`atob` and `Uint8Array`; `tsconfig.json` type-checks `src/` without Node types to keep it that way.

The package ships TypeScript source. Vite bundles it for the web app, and Node 24 runs it directly through type stripping.

| Import                | What it does                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@kasten/core/jmap`   | JMAP client over an injected transport: session, method calls with back-references, upload, download, EventSource URL. One error type, `KastenJmapError`.                              |
| `@kasten/core/auth`   | OAuth 2.0 authorization code with PKCE S256 for a public client: discovery, authorize URL, callback check, code exchange, refresh, revoke, end-session URL. Stores nothing.            |
| `@kasten/core/crypto` | Key generation and unlock, key bundles, PGP/MIME decrypt of stored mail, the encrypted Sent copy, PKESK inspection, the recovery sheet.                                                |
| `@kasten/core/mime`   | `parseMessage` (postal-mime) and `buildMessage`; a structural reader that follows Stalwart's parser rules.                                                                             |
| `@kasten/core/mail`   | Mailboxes, thread lists, emails, changes, identities, keywords, moves, and the send flow with its outbox entry.                                                                        |
| `@kasten/core/safety` | `stalwartIsEncrypted`, `classifyStored` and the daily check `checkMailbox`.                                                                                                            |
| `@kasten/core/search` | A local full-text index over decrypted mail, serialised for the caller to encrypt. Words come from Unicode word segmentation (`Intl.Segmenter`), so text without spaces is searchable. |

`@kasten/core` re-exports all of them.

## Dependencies

| Package             | Why                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `openpgp` 6.3.2     | OpenPGP.js: keys, encryption, decryption. LGPL-3.0-or-later; the web bundle must keep its licence notice. |
| `postal-mime` 4.2.0 | Parses messages for display, and decodes transfer encodings for the structural reader.                    |
| `zod` 4.6.7         | Decodes JSON from JMAP and OAuth at the boundary.                                                         |
| `minisearch` 7.2.0  | The search index.                                                                                         |

The message builder is Kasten's own, on top of `btoa` and `TextEncoder`. The maintained browser builder `mimetext` pulls in Babel runtime, core-js and mime-types, and the other builders are Node-only (nodemailer) or unmaintained. The builder covers only what a sent message needs: RFC 2047 encoded words split on code points, RFC 2231 file names with numbered sections, folding at 78 characters, CRLF, base64 in 76-character lines, and 7-bit output. Round-trip tests parse every built form with postal-mime.

Every built message has a `References` field that ends with its own Message-ID, once. Amazon SES delivers the message under a Message-ID of its own, so a reply cites that ID; the message's own ID in `References` is what lets Stalwart thread the reply with the Sent copy.

## Keys

`generateMailKey(name, email, passphrase)` makes an OpenPGP v4 key: an Ed25519 primary key that certifies and signs, and a Cv25519 encryption subkey, neither expiring. The secret key uses the iterated-and-salted S2K with AES-256 and a SHA-1 checksum, which GnuPG 2.5 imports. `pnpm --filter @kasten/core test:gpg` proves it with the installed gpg.

`buildKeyBundle(userKey, operatorKeys)` writes the text of one `x:PublicKey`: one armored block per key, user key first. Stalwart v1.0.1 reads one certificate per armored block (`common/src/storage/encryption.rs:30-64`), so a single block holding several keys is not used. `inspectKeyBundle(text)` lists fingerprints, encryption subkeys, any expiry and problems such as a revoked certificate, a primary key that is not Ed25519 or an encryption subkey that is not Cv25519; Stalwart's own `expiresAt` stays null even for expiring keys.

`stalwartEncryptionKeys(key)` gives the keys Stalwart encrypts to (`crypto.rs:137-145`: every alive, unrevoked key with the transport-encryption flag, an encrypting primary key included). `encryptionKeys(key)` gives the keys Kasten encrypts to: the same, but none for a revoked or expired certificate.

## Recovery sheet

`createRecoverySheet(armoredKey)` returns the armored protected key, the fingerprint, the creation date, QR chunks and `file`, the text of the recovery file: a title, the fingerprint, the creation time, the armored key and the chunk lines. `readRecoverySheet({ chunks })` or `readRecoverySheet({ text })` rebuilds and checks the key; the caller then unlocks it with the passphrase. The text can hold the armored key, the chunk lines or both, which must then be the same key. Other lines, such as the file's title, fingerprint and date, are ignored.

Each QR chunk is `KR1:<index>:<total>:<fingerprint>:<digest>:<payload>`:

- `index` counts from 1; `fingerprint` is 40 uppercase hex digits;
- `digest` is the first 8 uppercase hex digits of SHA-256 over the whole binary key;
- `payload` is base45 (RFC 9285) of this chunk's slice of the binary key.

Every character is in the QR alphanumeric set. A chunk is at most 600 characters, the alphanumeric capacity of QR version 15 at error-correction level M. Draw each chunk with level M (`RECOVERY_QR`). A protected key needs two codes. The tests encode every chunk with `qrcode`, check the version, draw it and read it back with `jsQR`.

## Send flow

`createOutboxEntry(buildMessage(draft), identity)` makes an entry; `processOutboxEntry(account, entry, targets, persist)` advances it and returns the new state. Store the entry only in the encrypted local store, because it holds plaintext mail.

Pass `persist` (type `PersistOutboxEntry`). A send calls it with the entry as `uncertain` just before the submit request, and as `submitted` as soon as the server accepts it, before the Sent copy is written. When the submit request gets no clear answer, a leftover draft can still show that the message went out, on that send or on a later run of the `uncertain` entry. Core first destroys the other drafts of the message, such as one from an earlier send of it, while the saved entry is still `uncertain`. If the app stops then, the next run looks in Drafts again and finds what is left. Then `persist` gets the entry as `submitted`, with the draft that showed the send in `strayDraftId`. Only after that does core destroy that draft, because the saved entry is then the only record that the message went out. If the app stops after that destroy, no other draft is left, and the next run finds the draft gone and stores the Sent copy. Without `persist`, an app that stops after the submission still holds a `queued` entry, and processing that entry would send the message again.

1. Upload the message without Bcc.
2. In one request: `Email/import` into Drafts with `$draft` and `$seen`, then `EmailSubmission/set` with an explicit envelope (Bcc recipients only there) and `onSuccessDestroyEmail: ["#s"]`.
3. If the submission fails, destroy the draft in a follow-up request; the entry stays `queued`.
4. Encrypt the Sent copy, Bcc inside, to every encryption subkey of the bundle, and import it into Sent with `$seen` and `receivedAt` set to the send time.
5. Before the import, look for the Message-ID in Sent.

When the server refuses every recipient, Stalwart still creates the submission, as `final`, and queues nothing (`jmap/src/submission/set.rs:720-786`); the entry stays `queued` with the SMTP replies in `lastError`. A partial refusal is sent, and `refusedRecipients` lists who was refused. No message is submitted unless the key bundle has a usable encryption key, so its Sent copy can always be written.

Step 5 queries Sent by `receivedAt` within a minute of the send time and compares each candidate's Message-ID. A `header` filter on Message-ID would find nothing, because Stalwart's default search index does not hold headers (`indexEmailFields` lacks `headers`; `jmap/src/email/query/filter.rs:542-562`).

When the follow-up destroy of a draft fails, the entry names the draft in `strayDraftId`. `processOutboxEntry` destroys it first on the next run, and tries once more before it returns `done`. For an `uncertain` entry it first asks whether that draft has an `EmailSubmission`, because nothing can answer that once the draft is gone; while that query fails, the draft stays. `cleanStrayDraft(account, entry)` destroys only that draft and never submits, for an entry the caller does not process again. The entry is the draft's only record, so keep it until `strayDraftId` is null.

An earlier attempt can also leave a draft that `strayDraftId` does not name: an `uncertain` attempt whose Drafts lookup failed, before the user chose **Send again** (`requeue`). So when a run starts with an entry that has earlier attempts (`attempts > 0`) and that entry is `submitted`, core looks in Drafts for its Message-ID after the `submitted` save and before the Sent copy, and destroys every draft there. A run first destroys the draft that `strayDraftId` names when the run starts; while that destroy fails, the run ends before the lookup, and the next run tries again. That covers a fresh submission, an `uncertain` entry that settles as sent, and a `submitted` entry with earlier attempts that resumes after a stop or retries its Sent copy. The first draft whose destroy fails goes into `strayDraftId`. If another destroy fails too, the entry stays `submitted` with a `strayDraft` error and the Sent copy waits; the next run destroys the recorded draft and then looks again. A first attempt makes no such lookup: once the server accepts it, `strayDraftId` names any draft of the message that is left. A later run of that entry looks only after a run has failed once the server accepted it, as when its Sent copy is retried. If a first attempt whose submit got a clear answer stops right after its `submitted` save, the resumed run makes no lookup either: that save keeps `attempts` at 0 and already names any draft that is left. A first attempt that its own draft settled saves `attempts` 1, so a run that resumes it looks in Drafts once. If the lookup fails, the send still counts, and the next run of a still `submitted` entry looks again. Once the entry is `done`, a draft the lookup missed stays until someone deletes it; `kasten check` reports a plaintext draft older than one hour as `staleDraft`. The lookup comes only after the `submitted` save, so if the submit answer is lost or the app stops before that save, the earlier draft can still show that the message went out.

An `uncertain` entry also names at most one draft, and its later runs find the others through the Drafts lookup. When one of its drafts shows that the message went out but the destroy of another draft fails, the entry stays `uncertain` and names only the draft whose destroy failed. The next run whose Drafts lookup is answered finds the draft that shows the message went out, and settles the entry as sent. Until then the Outbox shows the message as possibly not sent. If the user deletes the entry first, the draft it does not name stays until someone deletes it, and `kasten check` reports it as `staleDraft`. The same holds for a `submitted` entry that the user deletes while it waits after two failed destroys: the delete destroys only the draft it names.

`maxSentCopyBytes(messageBytes)` is the largest encrypted Sent copy of a message of that size: 1.4 times the message. Stalwart refuses an upload over `x:Jmap` `maxUploadSize`, so that limit must be at least `maxSentCopyBytes` of the server's send limit, or a message near the limit is sent but its Sent copy is refused on every attempt.

| State       | Meaning                                                                                                                                                                                                                                                                                                                      | Next                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`    | Not submitted                                                                                                                                                                                                                                                                                                                | Process again; `lastError` says why the last attempt failed, for example `recipientsRefused`                                                              |
| `submitted` | Sent; the Sent copy is not stored yet                                                                                                                                                                                                                                                                                        | Process again                                                                                                                                             |
| `uncertain` | The submit request got no clear answer and core found no `EmailSubmission` for it, or the server failed after it may have queued the message. A leftover draft is destroyed, but a missing `EmailSubmission` proves nothing, because Stalwart queues the message before it commits the record (`submission/set.rs:739, 337`) | Ask the user, then `requeue` or delete; processing it again only looks for a leftover draft, asks whether it was submitted, destroys it and never submits |
| `done`      | Sent and stored                                                                                                                                                                                                                                                                                                              | Delete the entry once `strayDraftId` is null; until then keep it and call `cleanStrayDraft`                                                               |

## Safety

`stalwartIsEncrypted(raw)` mirrors `is_encrypted` in Stalwart v1.0.1, `crates/email/src/message/crypto.rs:355-404`: it says whether Stalwart stores a message as-is and why. The MIME structure comes from `mime/structure.ts`, which follows mail-parser 1.0.0's rules; its header comment lists the known differences, all on malformed or rare input.

`classifyStored(raw, expectedKeyIds)` adds Kasten's stricter rule: multipart/encrypted with protocol application/pgp-encrypted, exactly two parts, one integrity-protected OpenPGP message, and PKESK key IDs exactly equal to the expected encryption subkeys.

`checkMailbox(input)` is the daily check without I/O. It flags a key-set mismatch, any expiry, any other bundle problem, any message not encrypted to exactly the key set unless it is an exception, any unaccepted message in Sent unless an operator listed it, and any unaccepted `$draft` older than one hour. A Sent copy's `receivedAt` does not relax that rule, because the storing client or the import source chooses it; an imported Sent copy that Stalwart stores as-is needs a listing. Exceptions are messages an operator listed (never a draft), fresh drafts, and sender-made plaintext forms that Stalwart stores as-is (fake PGP/MIME, armor text, S/MIME, `*.p7m`). Unless an operator lists it, OpenPGP data to the wrong keys is never an exception: that covers a silently dropped key, sender-encrypted mail the other keys cannot read, and a Sent copy moved out of Sent. The CLI's `kasten check` adds one exception of its own, `earlierKeySet`, for mail encrypted to a key set that a later `kasten lock` replaced ([cli/README.md](../../cli/README.md#kasten-check)).

`decryptStoredMessage` keeps the outer headers, so an unsigned inner `From` never replaces the `From` the server checked, and it copies stored header bytes unchanged.

## Scripts

| Command                                | Does                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @kasten/core test`      | Vitest unit tests; no network, no Docker                                                                                                                                                                                                                                                   |
| `pnpm --filter @kasten/core typecheck` | `tsc` on `src/` without Node types, then on the tests                                                                                                                                                                                                                                      |
| `pnpm --filter @kasten/core test:gpg`  | GnuPG import and decrypt check; fails if gpg is missing. `KASTEN_GPG` names the binary, `KASTEN_GPG_TMP` a short directory for the throwaway GNUPGHOME                                                                                                                                     |
| `pnpm --filter @kasten/core test:live` | Live tests against the dev stack (`./kasten dev up` first): classifier parity with what Stalwart actually stores, decryption, the send flow, OAuth, EventSource, search, the stored key bundle, per-call object limits and `Email/changes` past the change log. Fails if the stack is down |

`test/fixtures/README.md` lists which fixtures came from a real Stalwart v1.0.1.

// What the key worker does, without the message plumbing, so the unit tests can call it directly.
// All OpenPGP work, parsing and record encryption happen here, with @kasten/core.
import {
  buildKeyBundle,
  createRecoverySheet,
  decryptStoredMessage,
  encryptSentCopy,
  generateMailKey,
  generateRecoveryCode,
  hasStalwartMarker,
  inspectKeyBundle,
  isRecoveryCode,
  KastenCryptoError,
  openEscrow,
  openPasskeyUnlock,
  readPublicKeys,
  readRecoveryCode,
  readRecoverySheet,
  sealEscrow,
  sealPasskeyUnlock,
  unlockKey,
  type KastenCryptoErrorCode,
  type PrivateKey,
  type PublicKey,
  type RecoveryInput,
} from "@kasten/core/crypto";
import { JmapClient, KastenJmapError } from "@kasten/core/jmap";
import { createOutboxEntry, openMailAccount, processOutboxEntry } from "@kasten/core/mail";
import {
  buildMessage,
  KastenMimeError,
  parseMessage,
  type ParsedAttachment,
  type ParsedMessage,
} from "@kasten/core/mime";
import { classifyStored } from "@kasten/core/safety";

import { decodeValue, encodeValue } from "../lib/codec.ts";
import { snippetOf } from "../lib/text.ts";
import { privateKeyRecord, type MessageView, type PrivateKeyRecord } from "../store/records.ts";
import {
  createDeviceUnlock,
  createVault,
  KastenVaultError,
  normalisePassphrase,
  openDeviceUnlock,
  openRecord,
  openVault,
  sealRecord,
  type RecordSlot,
  type SealedRecord,
  type VaultParams,
} from "../store/vault.ts";
import type { BundleInfo, KeyInfo, KeySheet, KeyWorkerApi, NewDeviceKey } from "./protocol.ts";

/** The slot of the protected secret key in the local store. */
export const KEY_SLOT: RecordSlot = { store: "kv", key: "privateKey" };

/** A failure the page can act on: `code` is a KastenCryptoError or KastenVaultError code, or `locked`. */
export class KeyServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "KeyServiceError";
    this.code = code;
  }
}

/**
 * What a typed passphrase may stand for: the text itself (Unicode NFC), and, when it reads as a
 * recovery code typed by hand (lowercase, without dashes), the code in Kasten's own form.
 */
export function passphraseCandidates(typed: string): string[] {
  const exact = normalisePassphrase(typed);
  const code = readRecoveryCode(typed);

  return code === null || code === exact ? [exact] : [exact, code];
}

/** Runs `attempt` with each candidate in turn until one is not refused as the wrong passphrase. */
async function withPassphrase<T>(
  typed: string,
  attempt: (passphrase: string) => Promise<T>,
): Promise<T> {
  const [first, ...rest] = passphraseCandidates(typed);
  let failure = new KeyServiceError("wrongPassphrase", "That passphrase is not right.");

  for (const passphrase of [first ?? "", ...rest]) {
    try {
      return await attempt(passphrase);
    } catch (error) {
      const wrong =
        (error instanceof KastenCryptoError || error instanceof KastenVaultError) &&
        error.code === "wrongPassphrase";

      if (!wrong) throw error;

      failure = new KeyServiceError("wrongPassphrase", error.message, error);
    }
  }

  throw failure;
}

/** The first Delivered-To address, which names the alias a message reached. */
export function deliveredTo(parsed: ParsedMessage): string | null {
  const value = parsed.headers.find((header) => header.key === "delivered-to")?.value;

  if (value === undefined) return null;

  const address = value.trim().replace(/^<|>$/gu, "").trim().toLowerCase();

  return /^[^\s@<>]+@[^\s@<>]+$/u.test(address) ? address : null;
}

/**
 * Decryption failures that recur on every attempt: the message is not PGP/MIME, its data is not
 * integrity-protected, or it is not encrypted to this key. `unreadableCiphertext` and
 * `decryptFailed` wrap any OpenPGP.js exception, such as a failed allocation, so they may not.
 */
const DEFINITE_FAILURES: ReadonlySet<KastenCryptoErrorCode> = new Set([
  "notPgpMime",
  "notIntegrityProtected",
  "noMatchingKey",
]);

function viewOf(
  emailId: string,
  parsed: ParsedMessage,
  state: {
    encrypted: boolean;
    readable: boolean;
    retry: boolean;
    safe: boolean;
    safetyDetail: string | null;
  },
): MessageView {
  return {
    emailId,
    ...state,
    subject: parsed.subject,
    from: parsed.from,
    sender: parsed.sender,
    replyTo: [...parsed.replyTo],
    to: [...parsed.to],
    cc: [...parsed.cc],
    bcc: [...parsed.bcc],
    date: parsed.date,
    messageId: parsed.messageId,
    inReplyTo: [...parsed.inReplyTo],
    references: [...parsed.references],
    deliveredTo: deliveredTo(parsed),
    text: state.readable ? parsed.text : null,
    html: state.readable ? parsed.html : null,
    snippet: state.readable ? snippetOf(parsed) : "",
    attachments: state.readable
      ? parsed.attachments.map((attachment, index) => ({
          index,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.content.length,
          disposition: attachment.disposition,
          contentId: attachment.contentId,
          related: attachment.related,
        }))
      : [],
  };
}

function rethrow(cause: unknown): never {
  if (cause instanceof KeyServiceError) throw cause;

  if (cause instanceof KastenCryptoError || cause instanceof KastenVaultError) {
    throw new KeyServiceError(cause.code, cause.message, cause);
  }

  if (cause instanceof KastenMimeError)
    throw new KeyServiceError("invalidMessage", cause.message, cause);

  // A network failure outside the send flow (the session request): the page retries later.
  if (cause instanceof KastenJmapError) throw new KeyServiceError(cause.type, cause.message, cause);

  throw new KeyServiceError(
    "failed",
    cause instanceof Error ? cause.message : "The key worker failed",
    cause,
  );
}

interface Unlocked {
  readonly dataKey: CryptoKey;
  readonly privateKey: PrivateKey;
  readonly armored: string;
  readonly info: KeyInfo;
  /** Kept for "Keep unlocked on this device"; it opens nothing the unlocked key does not. */
  readonly passphrase: string;
  /**
   * The user showed they own the key in this worker's life: they typed its passphrase, used a
   * passkey, or made or restored the key here. A device that unlocked by itself has not, so it
   * cannot add a passkey or show the recovery code until they do (proveWithPasskey, provePassphrase).
   */
  proven: boolean;
}

interface Bundle {
  readonly keys: readonly PublicKey[];
  readonly encryptionKeyIds: readonly string[];
}

/** Creates the worker's state and its calls. Nothing it holds leaves it except through the return values. */
export function createKeyService(): KeyWorkerApi {
  let unlocked: Unlocked | null = null;
  let bundle: Bundle | null = null;

  function current(): Unlocked {
    if (unlocked === null) throw new KeyServiceError("locked", "Unlock Kasten first");

    return unlocked;
  }

  /** Decrypts a stored message once (plain stored mail as is) and returns the parts asked for. */
  async function readParts(raw: Uint8Array, indexes: readonly number[]) {
    const { privateKey } = current();
    let parsed: ParsedMessage;

    try {
      parsed = await parseMessage((await decryptStoredMessage(raw, [privateKey])).message);
    } catch (error) {
      if (!(error instanceof KastenCryptoError) || error.code !== "notPgpMime") throw error;
      parsed = await parseMessage(raw);
    }

    return indexes.map((index) => {
      const attachment: ParsedAttachment | undefined = parsed.attachments[index];

      if (attachment === undefined) throw new KeyServiceError("notFound", "No such attachment");

      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: new Uint8Array(attachment.content),
      };
    });
  }

  async function infoOf(key: PrivateKey, record: PrivateKeyRecord): Promise<KeyInfo> {
    return {
      fingerprint: record.fingerprint,
      encryptionKeyIds: record.encryptionKeyIds,
      created: record.created,
      userIds: key.getUserIDs(),
      armoredPublicKey: key.toPublic().armor(),
    };
  }

  async function adopt(record: PrivateKeyRecord, passphrase: string): Promise<NewDeviceKey> {
    const privateKey = await unlockKey(record.armored, passphrase);
    const { params, dataKey } = await createVault(passphrase);
    const keyRecord = await sealRecord(dataKey, KEY_SLOT, encodeValue({ ...record }));
    const info = await infoOf(privateKey, record);

    unlocked = { dataKey, privateKey, armored: record.armored, info, passphrase, proven: true };
    bundle = null;

    return { key: info, vault: params, keyRecord };
  }

  /** Adopts the key of a recovery sheet, or of an opened escrow, which holds the same text. */
  async function adoptRecovered(input: RecoveryInput, passphrase: string): Promise<NewDeviceKey> {
    const recovered = await readRecoverySheet(input);

    return adopt(
      {
        armored: recovered.armoredKey,
        fingerprint: recovered.fingerprint,
        encryptionKeyIds: [...recovered.encryptionKeyIds],
        created: recovered.created,
      },
      passphrase,
    );
  }

  /** Unlocks this device's key with its exact passphrase (a candidate, already normalised). */
  async function unlockWith(
    passphrase: string,
    vault: VaultParams,
    keyRecord: SealedRecord,
    proven: boolean,
  ): Promise<KeyInfo> {
    const dataKey = await openVault(passphrase, vault);
    const record = decodeValue(await openRecord(dataKey, KEY_SLOT, keyRecord), privateKeyRecord);
    const privateKey = await unlockKey(record.armored, passphrase);
    const info = await infoOf(privateKey, record);

    unlocked = { dataKey, privateKey, armored: record.armored, info, passphrase, proven };

    return info;
  }

  /** Opens a passkey record and checks it belongs to the key it is used for. */
  async function openPasskey(
    armoredMessage: string,
    prf: Uint8Array,
  ): Promise<{ fingerprint: string; passphrase: string }> {
    try {
      return await openPasskeyUnlock(armoredMessage, prf);
    } finally {
      prf.fill(0);
    }
  }

  return {
    async status() {
      return {
        unlocked: unlocked !== null,
        fingerprint: unlocked?.info.fingerprint ?? null,
        proven: unlocked?.proven ?? false,
      };
    },

    async createKey(request) {
      try {
        // Without a passphrase of the user's own, the key gets a recovery code.
        const passphrase =
          request.passphrase === null
            ? generateRecoveryCode()
            : normalisePassphrase(request.passphrase);

        const key = await generateMailKey(request.name, request.email, passphrase);

        return await adopt(
          {
            armored: key.armoredPrivateKey,
            fingerprint: key.fingerprint,
            encryptionKeyIds: [...key.encryptionKeyIds],
            created: key.created,
          },
          passphrase,
        );
      } catch (error) {
        rethrow(error);
      }
    },

    async restoreKey(request) {
      try {
        return await withPassphrase(request.passphrase, (passphrase) =>
          adoptRecovered(request.input, passphrase),
        );
      } catch (error) {
        rethrow(error);
      }
    },

    async restoreFromEscrow(request) {
      try {
        return await withPassphrase(request.passphrase, async (passphrase) =>
          adoptRecovered(
            { text: await openEscrow(request.armoredMessage, passphrase) },
            passphrase,
          ),
        );
      } catch (error) {
        rethrow(error);
      }
    },

    async restoreWithPasskey(request) {
      try {
        const opened = await openPasskey(request.armoredMessage, request.prf);
        const armored = await openEscrow(request.escrow, opened.passphrase);
        const restored = await adoptRecovered({ text: armored }, opened.passphrase);

        if (restored.key.fingerprint !== opened.fingerprint) {
          unlocked = null;
          throw new KeyServiceError("invalidRecoveryData", "The passkey belongs to another key");
        }

        return restored;
      } catch (error) {
        rethrow(error);
      }
    },

    async unlock(request) {
      try {
        return await withPassphrase(request.passphrase, (passphrase) =>
          unlockWith(passphrase, request.vault, request.keyRecord, true),
        );
      } catch (error) {
        rethrow(error);
      }
    },

    async unlockWithDevice(request) {
      try {
        const passphrase = await openDeviceUnlock(request.device);

        return await unlockWith(passphrase, request.vault, request.keyRecord, false);
      } catch (error) {
        rethrow(error);
      }
    },

    async unlockWithPasskey(request) {
      try {
        const opened = await openPasskey(request.armoredMessage, request.prf);
        const info = await unlockWith(opened.passphrase, request.vault, request.keyRecord, true);

        if (info.fingerprint !== opened.fingerprint) {
          unlocked = null;
          throw new KeyServiceError("invalidRecoveryData", "The passkey belongs to another key");
        }

        return info;
      } catch (error) {
        rethrow(error);
      }
    },

    async sealPasskey(request) {
      try {
        const state = current();

        if (!state.proven) {
          request.prf.fill(0);
          throw new KeyServiceError("notProven", "Confirm it's you first");
        }

        try {
          return {
            armoredMessage: await sealPasskeyUnlock(request.prf, {
              fingerprint: state.info.fingerprint,
              passphrase: state.passphrase,
            }),
            fingerprint: state.info.fingerprint,
          };
        } finally {
          request.prf.fill(0);
        }
      } catch (error) {
        rethrow(error);
      }
    },

    async proveWithPasskey(request) {
      try {
        const state = current();
        const opened = await openPasskey(request.armoredMessage, request.prf);

        const owns =
          opened.fingerprint === state.info.fingerprint && opened.passphrase === state.passphrase;

        if (owns) state.proven = true;

        return owns;
      } catch (error) {
        rethrow(error);
      }
    },

    async provePassphrase(request) {
      try {
        const state = current();
        const owns = passphraseCandidates(request.passphrase).includes(state.passphrase);

        if (owns) state.proven = true;

        return owns;
      } catch (error) {
        rethrow(error);
      }
    },

    async rememberUnlock() {
      try {
        return await createDeviceUnlock(current().passphrase);
      } catch (error) {
        rethrow(error);
      }
    },

    async lock() {
      unlocked = null;
      bundle = null;
    },

    async recoverySheet(): Promise<KeySheet> {
      try {
        const { armored, passphrase, proven } = current();
        const sheet = await createRecoverySheet(armored);
        const isCode = isRecoveryCode(passphrase);
        const recoveryCode = isCode && proven ? passphrase : null;

        return {
          ...sheet,
          file:
            recoveryCode === null ? sheet.file : `${sheet.file}\nRecovery code: ${recoveryCode}\n`,
          recoveryCode,
          codeHidden: isCode && !proven,
        };
      } catch (error) {
        rethrow(error);
      }
    },

    async escrowKey() {
      try {
        const { armored, passphrase, info } = current();

        return {
          armoredMessage: await sealEscrow(armored, passphrase),
          fingerprint: info.fingerprint,
        };
      } catch (error) {
        rethrow(error);
      }
    },

    async checkEscrow(request) {
      try {
        const { passphrase, info } = current();
        let opened: string;

        try {
          opened = await openEscrow(request.armoredMessage, passphrase);
        } catch (error) {
          if (error instanceof KastenCryptoError) return false;

          throw error;
        }

        return (await readRecoverySheet({ text: opened })).fingerprint === info.fingerprint;
      } catch (error) {
        rethrow(error);
      }
    },

    async checkServerKey(request) {
      try {
        const { privateKey, info } = current();

        if (!hasStalwartMarker(request.raw)) return { serverEncrypted: false, matches: false };

        const expected = bundle?.encryptionKeyIds ?? info.encryptionKeyIds;
        const classification = await classifyStored(request.raw, expected);

        if (!classification.kasten.accepted) return { serverEncrypted: true, matches: false };

        try {
          await decryptStoredMessage(request.raw, [privateKey]);
        } catch (error) {
          if (!(error instanceof KastenCryptoError)) throw error;

          return { serverEncrypted: true, matches: false };
        }

        return { serverEncrypted: true, matches: true };
      } catch (error) {
        rethrow(error);
      }
    },

    async setBundle(request): Promise<BundleInfo> {
      try {
        const report = await inspectKeyBundle(request.text);
        const keys = await readPublicKeys(request.text);

        bundle = { keys, encryptionKeyIds: report.encryptionKeyIds };

        return {
          fingerprints: report.keys.map((key) => key.fingerprint),
          encryptionKeyIds: report.encryptionKeyIds,
          hasExpiry: report.hasExpiry,
          problems: report.problems,
        };
      } catch (error) {
        rethrow(error);
      }
    },

    async buildBundle(request) {
      try {
        return await buildKeyBundle(current().info.armoredPublicKey, request.operatorKeys);
      } catch (error) {
        rethrow(error);
      }
    },

    async decryptMessage(request) {
      try {
        const { dataKey, privateKey, info } = current();
        const expected = bundle?.encryptionKeyIds ?? info.encryptionKeyIds;
        const classification = await classifyStored(request.raw, expected);
        const safe = classification.kasten.accepted;
        const safetyDetail = safe ? null : classification.kasten.detail;
        let view: MessageView;

        if (classification.kasten.rejection === "notMultipartEncrypted") {
          view = viewOf(request.emailId, await parseMessage(request.raw), {
            encrypted: false,
            readable: true,
            retry: false,
            safe,
            safetyDetail,
          });
        } else {
          try {
            const decrypted = await decryptStoredMessage(request.raw, [privateKey]);

            view = viewOf(request.emailId, await parseMessage(decrypted.message), {
              encrypted: true,
              readable: true,
              retry: false,
              safe,
              safetyDetail,
            });
          } catch (error) {
            if (!(error instanceof KastenCryptoError)) throw error;

            // Keep the readable outer headers and say why the body is missing.
            view = viewOf(request.emailId, await parseMessage(request.raw), {
              encrypted: true,
              readable: false,
              retry: !DEFINITE_FAILURES.has(error.code),
              safe: false,
              safetyDetail: error.message,
            });
          }
        }

        return { view, record: await sealRecord(dataKey, request.slot, encodeValue(view)) };
      } catch (error) {
        rethrow(error);
      }
    },

    async readAttachment(request) {
      try {
        const [part] = await readParts(request.raw, [request.index]);

        if (part === undefined) throw new KeyServiceError("notFound", "No such attachment");

        return part;
      } catch (error) {
        rethrow(error);
      }
    },

    async readAttachments(request) {
      try {
        return await readParts(request.raw, request.indexes);
      } catch (error) {
        rethrow(error);
      }
    },

    async prepareSend(request) {
      try {
        return createOutboxEntry(buildMessage(request.draft), request.identity);
      } catch (error) {
        rethrow(error);
      }
    },

    async encryptSentCopy(request) {
      try {
        if (bundle === null) throw new KeyServiceError("noBundle", "The key bundle is not loaded");

        return await encryptSentCopy(request.message, bundle.keys);
      } catch (error) {
        rethrow(error);
      }
    },

    async sendOutboxEntry(request, persist) {
      try {
        if (bundle === null) throw new KeyServiceError("noBundle", "The key bundle is not loaded");

        const client = new JmapClient({
          sessionUrl: request.context.sessionUrl,
          authorization: async () => request.context.authorization,
        });

        return await processOutboxEntry(
          await openMailAccount(client),
          request.entry,
          {
            draftsMailboxId: request.context.draftsMailboxId,
            sentMailboxId: request.context.sentMailboxId,
            publicKeys: bundle.keys,
          },
          persist,
        );
      } catch (error) {
        rethrow(error);
      }
    },

    async sealRecords(request) {
      try {
        const { dataKey } = current();

        return await Promise.all(
          request.items.map((item) => sealRecord(dataKey, item.slot, item.plaintext)),
        );
      } catch (error) {
        rethrow(error);
      }
    },

    async openRecords(request) {
      try {
        const { dataKey } = current();

        return await Promise.all(
          request.items.map((item) =>
            openRecord(dataKey, item.slot, item.record).catch((cause: unknown) => {
              if (cause instanceof KastenVaultError) return null;
              throw cause;
            }),
          ),
        );
      } catch (error) {
        rethrow(error);
      }
    },
  };
}

// The typed RPC between the page and the key worker. The worker holds the unlocked OpenPGP key and
// the local-store data key; neither ever crosses this boundary. The page sends ciphertext and
// plaintext records in, and gets parsed messages, sealed records and public data out. For "Keep
// unlocked on this device" it also gets a DeviceUnlock to store: the passphrase, encrypted with a
// device key that cannot be exported.
import type { RecoveryInput, RecoverySheet } from "@kasten/core/crypto";
import type { Identity, OutboxEntry } from "@kasten/core/mail";
import type { Draft } from "@kasten/core/mime";

import type { MessageView } from "../store/records.ts";
import type { OpenRequest, SealRequest } from "../store/local-store.ts";
import type { DeviceUnlock, RecordSlot, SealedRecord, VaultParams } from "../store/vault.ts";

/**
 * The recovery sheet, with the recovery code when the key has one (it was made with
 * `passphrase: null`) and the user has proven they own the key in this worker's life. `codeHidden`:
 * the key has a recovery code that this device, which unlocked by itself, may not show.
 */
export interface KeySheet extends RecoverySheet {
  readonly recoveryCode: string | null;
  readonly codeHidden: boolean;
}

/** Public facts about the device's key. */
export interface KeyInfo {
  readonly fingerprint: string;
  readonly encryptionKeyIds: readonly string[];
  readonly created: string;
  readonly userIds: readonly string[];
  readonly armoredPublicKey: string;
}

/** What the page stores after creating or restoring a key: all of it already protected. */
export interface NewDeviceKey {
  readonly key: KeyInfo;
  readonly vault: VaultParams;
  /** The passphrase-protected armored secret key, sealed under the data key for slot kv/privateKey. */
  readonly keyRecord: SealedRecord;
}

export interface BundleInfo {
  readonly fingerprints: readonly string[];
  readonly encryptionKeyIds: readonly string[];
  readonly hasExpiry: boolean;
  readonly problems: readonly string[];
}

export interface DecryptResult {
  readonly view: MessageView;
  /** The view, sealed for its body slot, ready to store. */
  readonly record: SealedRecord;
}

export interface AttachmentContent {
  readonly filename: string | null;
  readonly mimeType: string;
  readonly content: Uint8Array<ArrayBuffer>;
}

export interface SendContext {
  readonly sessionUrl: string;
  /**
   * A current `Bearer …` value; the page refreshes the token before it calls. The worker uses it
   * for the whole call, so a step the server refuses with 401 stays queued, and the page's next
   * run forces a refresh first (retryable in state/compose.ts).
   */
  readonly authorization: string;
  readonly draftsMailboxId: string;
  readonly sentMailboxId: string;
}

/** Every call the worker answers. Each takes at most one argument. */
export interface KeyWorkerApi {
  status(): Promise<{ unlocked: boolean; fingerprint: string | null; proven: boolean }>;
  /** Makes a key. Without a passphrase of the user's own (null), the key gets a recovery code. */
  createKey(request: {
    name: string;
    email: string;
    passphrase: string | null;
  }): Promise<NewDeviceKey>;
  /** Rebuilds a key from a recovery sheet and checks the passphrase. */
  restoreKey(request: { input: RecoveryInput; passphrase: string }): Promise<NewDeviceKey>;
  unlock(request: {
    passphrase: string;
    vault: VaultParams;
    keyRecord: SealedRecord;
  }): Promise<KeyInfo>;
  /** Unlocks with the passphrase a DeviceUnlock holds ("Keep unlocked on this device"). */
  unlockWithDevice(request: {
    device: DeviceUnlock;
    vault: VaultParams;
    keyRecord: SealedRecord;
  }): Promise<KeyInfo>;
  /**
   * Unlocks with a passkey: its PRF output opens the passkey record (the passphrase, encrypted to
   * it), and the passphrase opens this device's key. The PRF bytes are transferred and wiped.
   */
  unlockWithPasskey(request: {
    armoredMessage: string;
    prf: Uint8Array<ArrayBuffer>;
    vault: VaultParams;
    keyRecord: SealedRecord;
  }): Promise<KeyInfo>;
  /** A new device: a passkey record gives the passphrase, which opens the key escrow (`escrow`). */
  restoreWithPasskey(request: {
    escrow: string;
    armoredMessage: string;
    prf: Uint8Array<ArrayBuffer>;
  }): Promise<NewDeviceKey>;
  /**
   * A passkey record for the unlocked key: its passphrase, encrypted to a new passkey's PRF output.
   * Refused (`notProven`) until the user proved they own the key in this worker's life.
   */
  sealPasskey(request: {
    prf: Uint8Array<ArrayBuffer>;
  }): Promise<{ armoredMessage: string; fingerprint: string }>;
  /** Proves ownership with a passkey the key already has: true when its record opens to this key. */
  proveWithPasskey(request: {
    armoredMessage: string;
    prf: Uint8Array<ArrayBuffer>;
  }): Promise<boolean>;
  /** Proves ownership with the typed recovery code or passphrase: true when it is the key's. */
  provePassphrase(request: { passphrase: string }): Promise<boolean>;
  /** Encrypts the passphrase of the unlocked key with a new non-extractable device key. */
  rememberUnlock(): Promise<DeviceUnlock>;
  lock(): Promise<void>;
  recoverySheet(): Promise<KeySheet>;
  /**
   * This device's passphrase-protected key, encrypted once more with the passphrase, for the
   * server to keep (`sealEscrow` in @kasten/core/crypto), and the key's fingerprint.
   */
  escrowKey(): Promise<{ armoredMessage: string; fingerprint: string }>;
  /** Whether a key escrow opens with this device's passphrase and holds this device's key. */
  checkEscrow(request: { armoredMessage: string }): Promise<boolean>;
  /** Opens a key escrow with the passphrase and adopts the key in it, as restoreKey does. */
  restoreFromEscrow(request: { armoredMessage: string; passphrase: string }): Promise<NewDeviceKey>;
  /**
   * Whether a stored message shows that the server encrypts new mail to this device's key.
   * `serverEncrypted`: multipart/encrypted with Stalwart's own wrapper text. `matches`: also
   * encrypted to exactly the bundle's keys, integrity-protected, and this key opens it.
   */
  checkServerKey(request: {
    raw: Uint8Array<ArrayBuffer>;
  }): Promise<{ serverEncrypted: boolean; matches: boolean }>;
  /** The key bundle that mail is checked against and Sent copies are encrypted to. */
  setBundle(request: { text: string }): Promise<BundleInfo>;
  /** Builds the bundle text for this device's key plus the operator keys. */
  buildBundle(request: { operatorKeys: readonly string[] }): Promise<string>;
  decryptMessage(request: {
    emailId: string;
    raw: Uint8Array<ArrayBuffer>;
    slot: RecordSlot;
  }): Promise<DecryptResult>;
  readAttachment(request: {
    raw: Uint8Array<ArrayBuffer>;
    index: number;
  }): Promise<AttachmentContent>;
  /** Several parts of one message, decrypting it once. */
  readAttachments(request: {
    raw: Uint8Array<ArrayBuffer>;
    indexes: readonly number[];
  }): Promise<AttachmentContent[]>;
  encryptSentCopy(request: { message: Uint8Array<ArrayBuffer> }): Promise<Uint8Array<ArrayBuffer>>;
  /** Builds the RFC 5322 message and its outbox entry (`@kasten/core` buildMessage and createOutboxEntry). */
  prepareSend(request: { draft: Draft; identity: Identity }): Promise<OutboxEntry>;
  /**
   * Advances an outbox entry through the core send flow; the worker has the bundle's public keys.
   * While it runs, the worker sends `progress` messages with the entry to save (see
   * PersistOutboxEntry in @kasten/core/mail); the page saves each one before the flow goes on.
   */
  sendOutboxEntry(
    request: { entry: OutboxEntry; context: SendContext },
    persist?: (entry: OutboxEntry) => Promise<void>,
  ): Promise<OutboxEntry>;
  sealRecords(request: { items: readonly SealRequest[] }): Promise<SealedRecord[]>;
  openRecords(request: {
    items: readonly OpenRequest[];
  }): Promise<(Uint8Array<ArrayBuffer> | null)[]>;
}

export type KeyWorkerMethod = keyof KeyWorkerApi;

export type ParamsOf<M extends KeyWorkerMethod> = Parameters<KeyWorkerApi[M]>[0];

export type ResultOf<M extends KeyWorkerMethod> = Awaited<ReturnType<KeyWorkerApi[M]>>;

export type WorkerRequest = {
  [M in KeyWorkerMethod]: { readonly id: number; readonly method: M; readonly params: ParamsOf<M> };
}[KeyWorkerMethod];

/** The page's answer to a `progress` message: the entry is saved (or saving failed). */
export interface ProgressAck {
  readonly ack: number;
  readonly ok: boolean;
}

/** What the page posts to the worker. */
export type PageMessage = WorkerRequest | ProgressAck;

export interface WorkerFailure {
  readonly code: string;
  readonly message: string;
}

export type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly result: ResultOf<KeyWorkerMethod> }
  | { readonly id: number; readonly ok: false; readonly error: WorkerFailure }
  /** Mid-call: save this outbox entry, then answer with a ProgressAck naming `progressId`. */
  | { readonly id: number; readonly progressId: number; readonly progress: OutboxEntry };

/** Error codes the page acts on. */
export const WORKER_ERRORS = {
  locked: "locked",
  wrongPassphrase: "wrongPassphrase",
  noKey: "noKey",
  notProven: "notProven",
  passkeyMismatch: "passkeyMismatch",
} as const;

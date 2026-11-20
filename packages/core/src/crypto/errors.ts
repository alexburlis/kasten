/** Why a crypto operation failed. */
export type KastenCryptoErrorCode =
  | "wrongPassphrase"
  | "invalidKey"
  | "notPgpMime"
  | "unreadableCiphertext"
  | "notIntegrityProtected"
  | "noMatchingKey"
  | "decryptFailed"
  | "invalidBundle"
  | "invalidRecoveryData"
  /** A passkey's output does not open its record: another passkey, or the same one changed. */
  | "passkeyMismatch"
  | "missingMessageId";

/** The error type of the crypto module. */
export class KastenCryptoError extends Error {
  readonly code: KastenCryptoErrorCode;

  constructor(code: KastenCryptoErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "KastenCryptoError";
    this.code = code;
  }
}

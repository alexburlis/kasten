export { KastenCryptoError, type KastenCryptoErrorCode } from "./errors.ts";

export { openEscrow, sealEscrow } from "./escrow.ts";

export { openPasskeyUnlock, PRF_BYTES, sealPasskeyUnlock, type PasskeyUnlock } from "./passkey.ts";

export {
  generateRecoveryCode,
  isRecoveryCode,
  readRecoveryCode,
  RECOVERY_CODE,
} from "./recovery-code.ts";

export {
  buildKeyBundle,
  encryptionKeys,
  stalwartEncryptionKeys,
  generateMailKey,
  inspectKeyBundle,
  KASTEN_PGP_CONFIG,
  readPublicKeys,
  splitArmoredBlocks,
  unlockKey,
  type ArmoredBlock,
  type BundleKey,
  type BundleSubkey,
  type EncryptionKey,
  type KeyBundleReport,
  type MailKey,
} from "./keys.ts";

export {
  decryptStoredMessage,
  encryptSentCopy,
  hasStalwartMarker,
  inspectCiphertext,
  pkeskKeyIds,
  readPgpMime,
  type CiphertextInfo,
  type DecryptedMessage,
  type PgpMimeParts,
} from "./pgpmime.ts";

export {
  base45Decode,
  base45Encode,
  createRecoverySheet,
  readRecoverySheet,
  RECOVERY_QR,
  type QrSettings,
  type RecoveredKey,
  type RecoveryInput,
  type RecoverySheet,
} from "./recovery.ts";

export type { PrivateKey, PublicKey } from "openpgp";

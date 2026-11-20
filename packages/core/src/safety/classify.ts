import { KastenCryptoError } from "../crypto/errors.ts";
import { hasStalwartMarker, inspectCiphertext, type CiphertextInfo } from "../crypto/pgpmime.ts";
import { readMime } from "../mime/structure.ts";
import { stalwartIsEncrypted, type StalwartVerdict } from "./stalwart.ts";

/** Why Kasten does not accept a stored message as safely encrypted. */
export type KastenRejection =
  | "notMultipartEncrypted"
  | "malformedPgpMime"
  | "unreadableCiphertext"
  | "notIntegrityProtected"
  | "wrongRecipients";

/** Kasten's own acceptance rule, which is stricter than Stalwart's `is_encrypted`. */
export interface KastenVerdict {
  readonly accepted: boolean;
  readonly rejection: KastenRejection | null;
  readonly detail: string;
  /** The PKESK recipient key IDs, sorted; empty when there is no readable OpenPGP message. */
  readonly keyIds: readonly string[];
}

/** Both views of one stored message. */
export interface StoredClassification {
  /** What Stalwart's `is_encrypted` says about these bytes. */
  readonly stalwart: StalwartVerdict;
  readonly kasten: KastenVerdict;
  /** True when the message carries the wrapper Stalwart writes when it encrypts (crypto.rs:85-110). */
  readonly stalwartEncrypted: boolean;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left.map((id) => id.toUpperCase()));
  const b = new Set(right.map((id) => id.toUpperCase()));

  return a.size === b.size && [...a].every((id) => b.has(id));
}

async function kastenVerdict(
  raw: Uint8Array,
  expectedKeyIds: readonly string[],
): Promise<KastenVerdict> {
  const type = readMime(raw).root.contentType;

  if (type?.type !== "multipart" || type.subtype !== "encrypted") {
    return {
      accepted: false,
      rejection: "notMultipartEncrypted",
      detail: "The root is not multipart/encrypted",
      keyIds: [],
    };
  }

  let info: CiphertextInfo;

  try {
    info = await inspectCiphertext(raw);
  } catch (error) {
    if (!(error instanceof KastenCryptoError)) throw error;

    return {
      accepted: false,
      rejection:
        error.code === "unreadableCiphertext" ? "unreadableCiphertext" : "malformedPgpMime",
      detail: error.message,
      keyIds: [],
    };
  }

  if (!info.integrityProtected) {
    return {
      accepted: false,
      rejection: "notIntegrityProtected",
      detail: "The data is not one integrity-protected (SEIPD) packet",
      keyIds: info.keyIds,
    };
  }

  if (!sameSet(info.keyIds, expectedKeyIds)) {
    return {
      accepted: false,
      rejection: "wrongRecipients",
      detail: `Encrypted to [${info.keyIds.join(", ")}], expected [${[...expectedKeyIds].toSorted().join(", ")}]`,
      keyIds: info.keyIds,
    };
  }

  return {
    accepted: true,
    rejection: null,
    detail: "Encrypted to exactly the expected keys",
    keyIds: info.keyIds,
  };
}

/**
 * Classifies a stored message two ways. `stalwart` mirrors Stalwart's
 * `is_encrypted`, so it tells what Stalwart would store as-is. `kasten` is
 * Kasten's stricter rule: multipart/encrypted with protocol
 * application/pgp-encrypted, exactly two parts, an integrity-protected
 * OpenPGP message, and PKESK key IDs exactly equal to `expectedKeyIds`.
 */
export async function classifyStored(
  raw: Uint8Array,
  expectedKeyIds: readonly string[],
): Promise<StoredClassification> {
  return {
    stalwart: await stalwartIsEncrypted(raw),
    kasten: await kastenVerdict(raw, expectedKeyIds),
    stalwartEncrypted: hasStalwartMarker(raw),
  };
}

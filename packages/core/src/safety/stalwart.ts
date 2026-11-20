import { attachmentName, partText, readMime, type MimePart } from "../mime/structure.ts";

/*
 * A mirror of `is_encrypted` in Stalwart v1.0.1,
 * crates/email/src/message/crypto.rs:355-404 (tag v1.0.1, commit
 * 23b69755cb3cd8ecd952fe0443c5ac067a506184). Stalwart stores a message as-is,
 * without encrypting it, when this returns true (ingest.rs:620-622). The
 * message structure comes from ../mime/structure.ts, which follows
 * mail-parser 1.0.0's rules.
 *
 *     fn is_encrypted(&self) -> bool {
 *         if self.content_type().is_some_and(|ct| {
 *             let main_type = ct.ctype();
 *             let sub_type = ct.subtype().unwrap_or_default();
 *             (main_type.eq_ignore_ascii_case("application")
 *                 && (sub_type.eq_ignore_ascii_case("pkcs7-mime")
 *                     || sub_type.eq_ignore_ascii_case("pkcs7-signature")
 *                     || (sub_type.eq_ignore_ascii_case("octet-stream")
 *                         && self.attachment_name().is_some_and(|name| {
 *                             name.rsplit_once('.')
 *                                 .is_some_and(|(_, ext)| ["p7m", "p7s", "p7c", "p7z"].contains(&ext))
 *                         }))))
 *                 || (main_type.eq_ignore_ascii_case("multipart")
 *                     && sub_type.eq_ignore_ascii_case("encrypted"))
 *         }) { return true; }
 *         let root = self.root();
 *         let num_parts = root.parts().count();
 *         if num_parts <= 2 {
 *             // the last Text part's text, and whether any part is a multipart
 *             ...
 *             Some(text) if (num_parts == 1 || is_multipart)
 *                 && text.trim_start().starts_with("-----BEGIN PGP MESSAGE-----") => return true
 *         }
 *         false
 *     }
 */

/** Which branch of `is_encrypted` matched. */
export type StalwartRule =
  | "pkcs7-mime"
  | "pkcs7-signature"
  | "p7-octet-stream"
  | "multipart-encrypted"
  | "pgp-armor-text";

/** Whether Stalwart v1.0.1 would store this message without encrypting it, and why. */
export interface StalwartVerdict {
  readonly storedAsIs: boolean;
  readonly rule: StalwartRule | null;
  readonly reason: string;
}

const P7_EXTENSIONS = new Set(["p7m", "p7s", "p7c", "p7z"]);

const ARMOR = "-----BEGIN PGP MESSAGE-----";

const WHITE_SPACE_START =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

/** Rust's `str::trim_start`: removes characters with the Unicode White_Space property. */
export function rustTrimStart(text: string): string {
  return text.replace(WHITE_SPACE_START, "");
}

function flatten(part: MimePart): MimePart[] {
  return [part, ...part.children.flatMap(flatten)];
}

/** Stalwart's `is_encrypted`, crypto.rs:355-404. */
export async function stalwartIsEncrypted(raw: Uint8Array): Promise<StalwartVerdict> {
  const tree = readMime(raw);
  const type = tree.root.contentType;

  if (type !== null) {
    const subtype = type.subtype ?? "";

    if (type.type === "application") {
      if (subtype === "pkcs7-mime") {
        return {
          storedAsIs: true,
          rule: "pkcs7-mime",
          reason: "Root part is application/pkcs7-mime",
        };
      }

      if (subtype === "pkcs7-signature") {
        return {
          storedAsIs: true,
          rule: "pkcs7-signature",
          reason: "Root part is application/pkcs7-signature",
        };
      }

      if (subtype === "octet-stream") {
        const name = attachmentName(tree.root);
        const dot = name === null ? -1 : name.lastIndexOf(".");
        // The comparison is case-sensitive: "x.P7M" does not match.
        const extension = name === null || dot === -1 ? null : name.slice(dot + 1);

        if (extension !== null && P7_EXTENSIONS.has(extension)) {
          return {
            storedAsIs: true,
            rule: "p7-octet-stream",
            reason: `Root part is application/octet-stream named *.${extension}`,
          };
        }
      }
    }

    if (type.type === "multipart" && subtype === "encrypted") {
      return {
        storedAsIs: true,
        rule: "multipart-encrypted",
        reason: "Root part is multipart/encrypted",
      };
    }
  }

  if (tree.partCount <= 2) {
    const parts = flatten(tree.root);
    const isMultipart = parts.some((part) => part.kind === "multipart");
    const textPart = parts.findLast((part) => part.kind === "text");

    if (textPart !== undefined && (tree.partCount === 1 || isMultipart)) {
      const text = await partText(raw, textPart);

      if (rustTrimStart(text).startsWith(ARMOR)) {
        return {
          storedAsIs: true,
          rule: "pgp-armor-text",
          reason: "A message of at most two parts whose text starts with the PGP armor line",
        };
      }
    }
  }

  return { storedAsIs: false, rule: null, reason: "Stalwart encrypts this message" };
}

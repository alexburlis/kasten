// Message forms for the classifier parity test, generated at test time. Each form is one way a
// sender can shape a message. Some are the forms Stalwart's `is_encrypted` lets through
// (crates/email/src/message/crypto.rs:355-404 in v1.0.1), as observed on Stalwart v1.0.1; others
// probe the edges of the mirror in src/safety/stalwart.ts and src/mime/structure.ts. Every body
// holds a canary, so a test can tell plaintext from ciphertext in what Stalwart stored.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createMessage, encrypt, readKey } from "openpgp";

import { concatBytes, toBase64, utf8 } from "../../../src/bytes.ts";

const run = promisify(execFile);

/** One message form. */
export interface MessageForm {
  readonly name: string;
  /** What the form is and why it is here. */
  readonly about: string;
  readonly messageId: string;
  readonly canary: string;
  readonly bytes: Uint8Array;
  /**
   * What Stalwart v1.0.1 was observed to do on SMTP delivery, or what its source says it does:
   * true when it stores the form as-is. Null for edge probes, where only parity is asserted.
   */
  readonly expectAsIs: boolean | null;
}

const ARMOR = "-----BEGIN PGP MESSAGE-----";

function crlf(text: string): string {
  return text.replace(/\r?\n/gu, "\r\n");
}

function base64Lines(bytes: Uint8Array): string {
  return (toBase64(bytes).match(/.{1,76}/gu) ?? []).join("\r\n");
}

/** Quoted-printable for 7-bit text: "=" and the start of armor dashes are encoded. */
function quotedPrintable(text: string): string {
  return crlf(text)
    .split("\r\n")
    .map((line) => line.replaceAll("=", "=3D").replace(/^-/u, "=2D"))
    .join("\r\n");
}

interface FormContext {
  readonly recipient: string;
  readonly run: string;
}

interface FormHeaders {
  readonly text: string;
  readonly messageId: string;
}

function headers(context: FormContext, name: string): FormHeaders {
  const messageId = `form-${name}-${context.run}@example.test`;

  return {
    messageId,
    text: crlf(
      [
        "From: Form Sender <sender@example.test>",
        `To: ${context.recipient}`,
        `Subject: [form] ${name} ${context.run}`,
        `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
        `Message-ID: <${messageId}>`,
        "",
      ].join("\n"),
    ),
  };
}

/** A form from a header block (Message-ID and the rest added) and the bytes after it. */
function form(
  context: FormContext,
  name: string,
  about: string,
  expectAsIs: boolean | null,
  mime: (canary: string) => Uint8Array,
): MessageForm {
  const head = headers(context, name);
  const canary = `CANARY-${name}-${context.run}`;

  return {
    name,
    about,
    messageId: head.messageId,
    canary,
    bytes: concatBytes([utf8(head.text), mime(canary)]),
    expectAsIs,
  };
}

function text(value: string): Uint8Array {
  return utf8(crlf(value));
}

/** A real opaque-signed S/MIME entity from openssl, with a throwaway self-signed certificate. */
async function opaqueSigned(
  canary: string,
): Promise<{ readonly entity: Uint8Array; readonly der: Uint8Array }> {
  const dir = await mkdtemp(join(tmpdir(), "kasten-live-smime-"));

  try {
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=sender@example.test",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ]);

    await writeFile(
      join(dir, "inner.txt"),
      crlf(`Content-Type: text/plain; charset=utf-8\n\nSigned ${canary}\n`),
    );

    const common = [
      "-sign",
      "-nodetach",
      "-in",
      join(dir, "inner.txt"),
      "-signer",
      join(dir, "cert.pem"),
    ];

    const keyArgs = ["-inkey", join(dir, "key.pem")];

    await run("openssl", [
      "smime",
      ...common,
      ...keyArgs,
      "-outform",
      "SMIME",
      "-out",
      join(dir, "smime.txt"),
    ]);
    await run("openssl", [
      "smime",
      ...common,
      ...keyArgs,
      "-outform",
      "DER",
      "-out",
      join(dir, "smime.der"),
    ]);

    const entity = (await readFile(join(dir, "smime.txt"), "latin1")).replace(/\r?\n/gu, "\r\n");

    return { entity: Buffer.from(entity, "latin1"), der: await readFile(join(dir, "smime.der")) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The MIME headers and body of the S/MIME entity, from MIME-Version on. */
function smimeEntity(entity: Uint8Array, type: string): Uint8Array {
  const value = Buffer.from(entity).toString("latin1");
  const start = value.indexOf("MIME-Version:");

  return Buffer.from(value.slice(start).replace(/application\/x-pkcs7-mime/gu, type), "latin1");
}

/** A PGP/MIME message as a sender's mail client writes it, encrypted to `armoredKey`. */
async function pgpMime(canary: string, armoredKey: string): Promise<Uint8Array> {
  const key = await readKey({ armoredKey });

  const armored = await encrypt({
    message: await createMessage({
      text: crlf(`Content-Type: text/plain; charset=utf-8\n\nEncrypted by the sender: ${canary}\n`),
    }),
    encryptionKeys: key,
    format: "armored",
  });

  return text(
    [
      "MIME-Version: 1.0",
      'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="pgp-b1"',
      "",
      "This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)",
      "--pgp-b1",
      "Content-Type: application/pgp-encrypted",
      "Content-Description: PGP/MIME version identification",
      "",
      "Version: 1",
      "",
      "--pgp-b1",
      'Content-Type: application/octet-stream; name="encrypted.asc"',
      'Content-Disposition: inline; filename="encrypted.asc"',
      "",
      armored.trimEnd(),
      "--pgp-b1--",
      "",
    ].join("\n"),
  );
}

function octetStream(
  contentType: string,
  disposition: string | null,
): (canary: string) => Uint8Array {
  return (canary) =>
    text(
      [
        "MIME-Version: 1.0",
        `Content-Type: ${contentType}`,
        ...(disposition === null ? [] : [`Content-Disposition: ${disposition}`]),
        "",
        `Statement ${canary} (plaintext)`,
        "",
      ].join("\n"),
    );
}

function armorBody(canary: string): string {
  return `${ARMOR}\n\nplaintext pretending to be OpenPGP: ${canary}\n`;
}

/**
 * Every form, for mail to `recipient`. `senderKey` is the armored public key a sender would
 * encrypt to (the recipient's own key, not the bundle).
 */
export async function messageForms(
  recipient: string,
  runTag: string,
  senderKey: string,
): Promise<MessageForm[]> {
  const context: FormContext = { recipient, run: runTag };
  const smime = await opaqueSigned(`smime-${runTag}`);
  const realPgpMime = await pgpMime(`CANARY-pgp-mime-real-${runTag}`, senderKey);

  return [
    form(
      context,
      "smime-signed-data",
      "Opaque-signed S/MIME as RFC 8551 declares it: application/pkcs7-mime; smime-type=signed-data",
      true,
      () => smimeEntity(smime.entity, "application/pkcs7-mime"),
    ),
    form(
      context,
      "smime-x-pkcs7-mime",
      "The same S/MIME as LibreSSL declares it, application/x-pkcs7-mime, which is not in the rule",
      false,
      () => smimeEntity(smime.entity, "application/x-pkcs7-mime"),
    ),
    form(context, "pkcs7-signature-root", "A root application/pkcs7-signature part", true, () =>
      text(
        [
          "MIME-Version: 1.0",
          'Content-Type: application/pkcs7-signature; name="smime.p7s"',
          "Content-Transfer-Encoding: base64",
          "",
          base64Lines(smime.der),
          "",
        ].join("\n"),
      ),
    ),
    form(
      context,
      "pkcs7-mime-mixed-case",
      "Application/PKCS7-MIME: the type comparison ignores ASCII case",
      true,
      () => smimeEntity(smime.entity, "Application/PKCS7-MIME"),
    ),
    form(
      context,
      "fake-pgp-mime",
      "A fake multipart/encrypted whose second part is plaintext",
      true,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"',
            "",
            "--b1",
            "Content-Type: application/pgp-encrypted",
            "",
            "Version: 1",
            "",
            "--b1",
            "Content-Type: text/plain; charset=utf-8",
            "",
            `${canary} (plaintext)`,
            "--b1--",
            "",
          ].join("\n"),
        ),
    ),
    form(
      context,
      "fake-pgp-mime-upper-case",
      "MULTIPART/Encrypted in mixed case, with a plaintext part",
      null,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            'Content-Type: MULTIPART/Encrypted; boundary="b2"',
            "",
            "--b2",
            "Content-Type: text/plain",
            "",
            `${canary} (plaintext)`,
            "--b2--",
            "",
          ].join("\n"),
        ),
    ),
    form(
      context,
      "pgp-mime-real",
      "A real PGP/MIME message a sender encrypted to the recipient's own key",
      true,
      () => realPgpMime,
    ),
    form(
      context,
      "armor-text",
      "A text/plain body that starts with the PGP armor line",
      true,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            armorBody(canary),
          ].join("\n"),
        ),
    ),
    form(
      context,
      "armor-leading-white-space",
      "Blank lines, spaces and tabs before the armor line (trim_start removes them)",
      null,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "",
            " \t",
            `  ${armorBody(canary)}`,
          ].join("\n"),
        ),
    ),
    form(
      context,
      "armor-nbsp",
      "U+00A0 before the armor line, in 8-bit UTF-8 (Rust's trim_start removes it)",
      null,
      (canary) =>
        concatBytes([
          text(
            [
              "MIME-Version: 1.0",
              "Content-Type: text/plain; charset=utf-8",
              "Content-Transfer-Encoding: 8bit",
              "",
              "",
            ].join("\n"),
          ),
          utf8(" "),
          text(armorBody(canary)),
        ]),
    ),
    form(
      context,
      "armor-bom",
      "A UTF-8 byte-order mark before the armor line (trim_start keeps U+FEFF)",
      null,
      (canary) =>
        concatBytes([
          text(
            [
              "MIME-Version: 1.0",
              "Content-Type: text/plain; charset=utf-8",
              "Content-Transfer-Encoding: 8bit",
              "",
              "",
            ].join("\n"),
          ),
          Uint8Array.from([0xef, 0xbb, 0xbf]),
          text(armorBody(canary)),
        ]),
    ),
    form(context, "armor-base64", "Armor text inside a base64 transfer encoding", null, (canary) =>
      text(
        [
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          base64Lines(text(armorBody(canary))),
          "",
        ].join("\n"),
      ),
    ),
    form(context, "armor-quoted-printable", "Armor text inside quoted-printable", null, (canary) =>
      text(
        [
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: quoted-printable",
          "",
          quotedPrintable(armorBody(canary)),
        ].join("\n"),
      ),
    ),
    form(
      context,
      "armor-utf16",
      "Armor text in UTF-16LE with a byte-order mark, base64-encoded",
      null,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-16",
            "Content-Transfer-Encoding: base64",
            "",
            base64Lines(Buffer.from(`﻿${crlf(armorBody(canary))}`, "utf16le")),
            "",
          ].join("\n"),
        ),
    ),
    form(
      context,
      "armor-no-content-type",
      "No Content-Type, so the body is text/plain; it starts with the armor line",
      null,
      (canary) => text(["MIME-Version: 1.0", "", armorBody(canary)].join("\n")),
    ),
    form(
      context,
      "armor-html",
      "A text/html body that starts with the armor line (an HTML part is not a Text part)",
      null,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            "Content-Type: text/html; charset=utf-8",
            "",
            armorBody(canary),
          ].join("\n"),
        ),
    ),
    form(
      context,
      "armor-multipart-one-part",
      "multipart/mixed with one text part that starts with the armor line: two parts",
      null,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="m1"',
            "",
            "--m1",
            "Content-Type: text/plain; charset=utf-8",
            "",
            armorBody(canary),
            "--m1--",
            "",
          ].join("\n"),
        ),
    ),
    form(
      context,
      "armor-multipart-two-parts",
      "The armor text part plus an attachment: three parts",
      null,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="m2"',
            "",
            "--m2",
            "Content-Type: text/plain; charset=utf-8",
            "",
            armorBody(canary),
            "--m2",
            'Content-Type: application/octet-stream; name="data.bin"',
            "Content-Transfer-Encoding: base64",
            "",
            "AAECAwQ=",
            "--m2--",
            "",
          ].join("\n"),
        ),
    ),
    form(
      context,
      "pgp-signed-inline",
      "A clear-signed text body: BEGIN PGP SIGNED MESSAGE is not the armor line",
      false,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "-----BEGIN PGP SIGNED MESSAGE-----",
            "Hash: SHA256",
            "",
            `Signed text ${canary}`,
            "-----BEGIN PGP SIGNATURE-----",
            "",
            "iQ==",
            "-----END PGP SIGNATURE-----",
            "",
          ].join("\n"),
        ),
    ),
    form(
      context,
      "p7m-octet-stream",
      "A root application/octet-stream named statement.p7m",
      true,
      octetStream(
        'application/octet-stream; name="statement.p7m"',
        'attachment; filename="statement.p7m"',
      ),
    ),
    form(
      context,
      "p7s-octet-stream",
      "The same, named *.p7s",
      true,
      octetStream('application/octet-stream; name="smime.p7s"', 'attachment; filename="smime.p7s"'),
    ),
    form(
      context,
      "p7c-octet-stream",
      "The same, named *.p7c",
      true,
      octetStream('application/octet-stream; name="certs.p7c"', 'attachment; filename="certs.p7c"'),
    ),
    form(
      context,
      "p7z-octet-stream",
      "The same, named *.p7z",
      true,
      octetStream('application/octet-stream; name="data.p7z"', 'attachment; filename="data.p7z"'),
    ),
    form(
      context,
      "p7m-upper-case-extension",
      "Named statement.P7M: the extension comparison is case-sensitive",
      null,
      octetStream(
        'application/octet-stream; name="statement.P7M"',
        'attachment; filename="statement.P7M"',
      ),
    ),
    form(
      context,
      "p7m-name-only",
      "Only the Content-Type name parameter says *.p7m",
      null,
      octetStream('application/octet-stream; name="statement.p7m"', null),
    ),
    form(
      context,
      "p7m-filename-only",
      "Only the Content-Disposition filename says *.p7m",
      null,
      octetStream("application/octet-stream", 'attachment; filename="statement.p7m"'),
    ),
    form(
      context,
      "p7m-rfc2231",
      "An RFC 2231 encoded filename that decodes to stätement.p7m",
      null,
      octetStream("application/octet-stream", "attachment; filename*=utf-8''st%C3%A4tement.p7m"),
    ),
    form(
      context,
      "p7m-filename-wins",
      "filename=statement.txt and name=statement.p7m: the filename is the attachment name",
      null,
      octetStream(
        'application/octet-stream; name="statement.p7m"',
        'attachment; filename="statement.txt"',
      ),
    ),
    form(
      context,
      "last-content-type-wins",
      "Two Content-Type fields, multipart/encrypted first and text/plain last",
      null,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b3"',
            "Content-Type: text/plain; charset=utf-8",
            "",
            `${canary} (plaintext)`,
            "",
          ].join("\n"),
        ),
    ),
    form(
      context,
      "message-rfc822-root",
      "A root message/rfc822 whose inner message is armor text (nested parts do not count)",
      null,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            "Content-Type: message/rfc822",
            "",
            "From: inner@example.test",
            "Subject: inner",
            "Content-Type: text/plain",
            "",
            armorBody(canary),
          ].join("\n"),
        ),
    ),
    form(
      context,
      "multipart-signed",
      "PGP/MIME signed (multipart/signed): readable by design, so Stalwart encrypts it",
      false,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            'Content-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="s1"',
            "",
            "--s1",
            "Content-Type: text/plain; charset=utf-8",
            "",
            `Signed ${canary}`,
            "--s1",
            'Content-Type: application/pgp-signature; name="signature.asc"',
            "",
            "-----BEGIN PGP SIGNATURE-----",
            "",
            "iQ==",
            "-----END PGP SIGNATURE-----",
            "--s1--",
            "",
          ].join("\n"),
        ),
    ),
    ...malformedForms(context),
    form(context, "control-plain", "Ordinary text/plain", false, (canary) =>
      text(
        [
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          `Hello ${canary}`,
          "",
        ].join("\n"),
      ),
    ),
    form(
      context,
      "control-alternative",
      "Ordinary multipart/alternative with text and HTML",
      false,
      (canary) =>
        text(
          [
            "MIME-Version: 1.0",
            'Content-Type: multipart/alternative; boundary="a1"',
            "",
            "--a1",
            "Content-Type: text/plain; charset=utf-8",
            "",
            `Hello ${canary}`,
            "--a1",
            "Content-Type: text/html; charset=utf-8",
            "",
            `<p>Hello ${canary}</p>`,
            "--a1--",
            "",
          ].join("\n"),
        ),
    ),
    form(context, "control-8bit-utf8", "Ordinary 8-bit UTF-8 text", false, (canary) =>
      concatBytes([
        text(
          [
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Transfer-Encoding: 8bit",
            "",
            "",
          ].join("\n"),
        ),
        utf8(crlf(`Grüße aus Köln, 東京から ${canary}\n`)),
      ]),
    ),
  ];
}

function plain(lines: readonly string[]): Uint8Array {
  return text([...lines, ""].join("\n"));
}

/** Header and parameter forms that probe the structural reader (src/mime/structure.ts). */
function malformedForms(context: FormContext): MessageForm[] {
  return [
    form(context, "folded-content-type", "Content-Type folded before its value", null, (canary) =>
      plain([
        "MIME-Version: 1.0",
        "Content-Type:",
        " application/pkcs7-mime;",
        '\tname="smime.p7m"',
        "",
        canary,
      ]),
    ),
    form(
      context,
      "no-space-after-colon",
      "Content-Type:application/pkcs7-mime, without a space",
      null,
      (canary) => plain(["MIME-Version: 1.0", "Content-Type:application/pkcs7-mime", "", canary]),
    ),
    form(context, "upper-case-field-name", "CONTENT-TYPE in capitals", null, (canary) =>
      plain(["MIME-Version: 1.0", "CONTENT-TYPE: application/pkcs7-mime", "", canary]),
    ),
    form(
      context,
      "comment-in-content-type",
      "A comment after the type: multipart/encrypted (comment)",
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          'Content-Type: multipart/encrypted (hidden); boundary="c1"',
          "",
          "--c1",
          "",
          canary,
          "--c1--",
        ]),
    ),
    form(
      context,
      "quoted-type-token",
      'A quoted type token: "application/pkcs7-mime"',
      null,
      (canary) =>
        plain(["MIME-Version: 1.0", 'Content-Type: "application/pkcs7-mime"', "", canary]),
    ),
    form(
      context,
      "quoted-type-with-semicolon",
      'A quoted type with ";" inside: quotes do not protect it',
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          'Content-Type: "multipart/encrypted; boundary=q1"',
          "",
          canary,
        ]),
    ),
    form(
      context,
      "inner-quote-type",
      'A quote inside the type token: appli"cation/pkcs7-mime',
      null,
      (canary) => plain(["MIME-Version: 1.0", 'Content-Type: appli"cation/pkcs7-mime', "", canary]),
    ),
    form(
      context,
      "semicolon-in-type-comment",
      "A comment holding ; after the type: application/pkcs7-mime (a;b)",
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          "Content-Type: application/pkcs7-mime (a;b); name=x",
          "",
          canary,
        ]),
    ),
    form(
      context,
      "garbage-line-before-type",
      "A header line without a colon before Content-Type",
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          "this line has no colon",
          "Content-Type: application/pkcs7-mime",
          "",
          canary,
        ]),
    ),
    form(
      context,
      "encrypted-without-boundary",
      "multipart/encrypted without a boundary parameter",
      null,
      (canary) => plain(["MIME-Version: 1.0", "Content-Type: multipart/encrypted", "", canary]),
    ),
    form(
      context,
      "p7m-first-name-wins",
      'name="a.p7m"; name="b.txt": the first parameter of a name wins',
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          'Content-Type: application/octet-stream; name="a.p7m"; name="b.txt"',
          "",
          canary,
        ]),
    ),
    form(
      context,
      "p7m-encoded-word-name",
      "An RFC 2047 encoded word as the name parameter",
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          'Content-Type: application/octet-stream; name="=?utf-8?q?statement.p7m?="',
          "",
          canary,
        ]),
    ),
    form(
      context,
      "p7m-rfc2231-continuation",
      "An RFC 2231 continuation: filename*0 and filename*1",
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          "Content-Type: application/octet-stream",
          'Content-Disposition: attachment; filename*0="state"; filename*1="ment.p7m"',
          "",
          canary,
        ]),
    ),
    form(
      context,
      "armor-unknown-charset",
      "Armor text in an unknown charset, which reads as UTF-8",
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=x-unknown-kasten",
          "",
          armorBody(canary),
        ]),
    ),
    form(
      context,
      "armor-iso-2022-kr",
      "Armor text labelled iso-2022-kr, which decodes to one replacement character",
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=iso-2022-kr",
          "",
          armorBody(canary),
        ]),
    ),
    form(
      context,
      "armor-base64-comment",
      "Content-Transfer-Encoding: BASE64 (comment), around armor text",
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          "Content-Type: text/plain",
          "Content-Transfer-Encoding: BASE64 (encoded)",
          "",
          base64Lines(text(armorBody(canary))),
        ]),
    ),
    form(
      context,
      "armor-last-encoding-wins",
      "Two Content-Transfer-Encoding fields: 7bit first, base64 last",
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          "Content-Type: text/plain",
          "Content-Transfer-Encoding: 7bit",
          "Content-Transfer-Encoding: base64",
          "",
          base64Lines(text(armorBody(canary))),
        ]),
    ),
    form(
      context,
      "armor-nested-alternative",
      "multipart/mixed > multipart/alternative > armor text: three parts",
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="n1"',
          "",
          "--n1",
          'Content-Type: multipart/alternative; boundary="n2"',
          "",
          "--n2",
          "Content-Type: text/plain",
          "",
          armorBody(canary),
          "--n2--",
          "--n1--",
        ]),
    ),
    form(
      context,
      "armor-unclosed-multipart",
      "multipart/mixed whose boundary never appears: broken text that starts with --",
      null,
      (canary) =>
        plain([
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="never"',
          "",
          armorBody(canary),
        ]),
    ),
  ];
}

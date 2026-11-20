// The request the install screen copies for the operator after `kasten lock`: it must carry the
// account, the sheet's fingerprint and the public key, with the commands of "Rotate your mail key",
// as one block a root shell runs from a single paste.
import { describe, expect, it } from "vitest";

import { operatorRequest } from "../src/features/keys/fingerprint.ts";

const FINGERPRINT = "690117118780143AD3F66F7208ABAF9166E1F51A";

const PUBLIC_KEY =
  "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmDMEaQAAABYJKwYBBAHaRw8BAQdA\n-----END PGP PUBLIC KEY BLOCK-----\n";

describe("operatorRequest", () => {
  const text = operatorRequest("you@example.com", FINGERPRINT, PUBLIC_KEY);

  it("names the account and the fingerprint in the recovery sheet's groups of four", () => {
    expect(text).toContain("for you@example.com.");
    expect(text).toContain("Fingerprint: 6901 1711 8780 143A D3F6 6F72 08AB AF91 66E1 F51A");
  });

  it("writes the key file as kasten, then gives keys set, then lock with that fingerprint", () => {
    const write = text.indexOf(
      "setpriv --reuid=kasten --regid=kasten --init-groups sh -c 'umask 077 && cat >/var/lib/kasten/cli/new-key.pub.asc'",
    );

    const keysSet = text.indexOf(
      "kasten-cli keys set --account you@example.com --key /etc/kasten/new-key.pub.asc",
    );

    const lock = text.indexOf(
      'kasten-cli lock --account you@example.com --user-fingerprint "6901 1711 8780 143A D3F6 6F72 08AB AF91 66E1 F51A"',
    );

    expect(write).toBeGreaterThan(-1);
    expect(keysSet).toBeGreaterThan(write);
    expect(lock).toBeGreaterThan(keysSet);
  });

  it("writes the whole public key through a here-document, before keys set", () => {
    const write = text.indexOf("new-key.pub.asc' <<'KASTEN_KEY'\n");
    const key = text.indexOf(`\n${PUBLIC_KEY.trim()}\nKASTEN_KEY\n`);
    const keysSet = text.indexOf("kasten-cli keys set");

    expect(write).toBeGreaterThan(-1);
    expect(key).toBeGreaterThan(write);
    expect(keysSet).toBeGreaterThan(key);
  });

  it("runs as one paste: after the here-document, every line is a command", () => {
    const block = text.slice(text.indexOf("setpriv"));
    const afterKey = block.slice(block.indexOf("KASTEN_KEY\n") + "KASTEN_KEY\n".length).trim();

    expect(afterKey.split("\n").every((line) => line.startsWith("kasten-cli "))).toBe(true);
  });
});

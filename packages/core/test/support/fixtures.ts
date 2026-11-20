import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PrivateKey, PublicKey } from "openpgp";

import { readPublicKeys, unlockKey } from "../../src/crypto/keys.ts";
import { JmapClient } from "../../src/jmap/client.ts";
import { FakeJmapServer, ORIGIN, TEST_AUTHORIZATION } from "./fake-jmap.ts";

const ROOT = join(import.meta.dirname, "..", "fixtures");

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, name)));
}

export function fixtureText(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

/** The real-Stalwart key pair: daily E651DBCB5C5CE7CB and recovery A13D9D3B334D2531. */
export const DAILY_SUBKEY = "E651DBCB5C5CE7CB";

export const RECOVERY_SUBKEY = "A13D9D3B334D2531";

export const EXPIRED_SUBKEY = "2EEFC581D615E2C5";

export async function fixtureSecretKey(name: "you-daily" | "you-recovery"): Promise<PrivateKey> {
  return unlockKey(fixtureText(`keys/${name}.sec.asc`), null);
}

export async function fixturePublicKeys(...names: string[]): Promise<PublicKey[]> {
  const keys: PublicKey[] = [];

  for (const name of names)
    keys.push(...(await readPublicKeys(fixtureText(`keys/${name}.pub.asc`))));

  return keys;
}

/** A fake server and a client wired to it. */
export interface FakeSetup {
  readonly server: FakeJmapServer;
  readonly client: JmapClient;
}

/** A JMAP client wired to a fresh fake server. */
export function fakeClient(): FakeSetup {
  const server = new FakeJmapServer();

  const client = new JmapClient({
    sessionUrl: `${ORIGIN}/jmap/session`,
    authorization: async () => TEST_AUTHORIZATION,
    transport: server.transport,
  });

  return { server, client };
}

/** A deterministic random source for reproducible builds. */
export function seededRandom(seed: number): (length: number) => Uint8Array {
  let state = seed >>> 0;

  return (length) => {
    const out = new Uint8Array(length);

    for (let index = 0; index < length; index += 1) {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      out[index] = state >>> 24;
    }

    return out;
  };
}

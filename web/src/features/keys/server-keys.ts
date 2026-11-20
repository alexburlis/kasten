// The account's key bundle on the server: x:AccountSettings.encryptionAtRest points at one
// x:PublicKey that holds every armored key (the user's first, then the operator keys).
//
// While the OAuth client is first-party the app's token may read and write these objects. After
// `kasten lock` they answer `forbidden`, and only the operator can change them.
import { CAPABILITY_CORE, KastenJmapError, type JmapClient } from "@kasten/core/jmap";
import { z } from "zod";

export const CAPABILITY_STALWART = "urn:stalwart:jmap";

const USING = [CAPABILITY_CORE, CAPABILITY_STALWART];

const encryptionAtRest = z.union([
  z.object({ "@type": z.literal("Disabled") }),
  z.object({
    "@type": z.string(),
    publicKey: z.string(),
    encryptOnAppend: z.boolean().optional(),
  }),
]);

const settingsGet = z.object({
  list: z.array(z.object({ id: z.string(), encryptionAtRest: encryptionAtRest.optional() })),
});

const publicKeyGet = z.object({
  list: z.array(z.object({ id: z.string(), key: z.string(), description: z.string().nullish() })),
});

const setResult = z.object({
  created: z.record(z.string(), z.object({ id: z.string() })).nullish(),
  updated: z.record(z.string(), z.unknown()).nullish(),
  notCreated: z
    .record(z.string(), z.object({ type: z.string(), description: z.string().nullish() }))
    .nullish(),
  notUpdated: z
    .record(z.string(), z.object({ type: z.string(), description: z.string().nullish() }))
    .nullish(),
});

export type ServerKeys =
  /** No bundle: new mail is stored as it arrives, unencrypted. */
  | { readonly kind: "none" }
  | { readonly kind: "set"; readonly publicKeyId: string; readonly bundleText: string }
  /** The server refuses this app's x:* calls: the client was locked by the operator. */
  | { readonly kind: "locked" };

export class KastenKeySetupError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "KastenKeySetupError";
  }
}

function isForbidden(error: unknown): error is KastenJmapError {
  return error instanceof KastenJmapError && error.type === "forbidden";
}

export async function readServerKeys(client: JmapClient, accountId: string): Promise<ServerKeys> {
  try {
    const response = await client.call(
      [
        ["x:AccountSettings/get", { accountId, ids: ["singleton"] }, "s"],
        ["x:PublicKey/get", { accountId, ids: null }, "k"],
      ],
      USING,
    );

    const settings = response.parse("s", "x:AccountSettings/get", settingsGet).list[0];
    const keys = response.parse("k", "x:PublicKey/get", publicKeyGet).list;
    const atRest = settings?.encryptionAtRest;

    if (atRest === undefined || !("publicKey" in atRest)) return { kind: "none" };

    const key = keys.find((item) => item.id === atRest.publicKey);

    if (key === undefined) return { kind: "none" };

    return { kind: "set", publicKeyId: key.id, bundleText: key.key };
  } catch (error) {
    if (isForbidden(error)) return { kind: "locked" };

    throw error;
  }
}

/**
 * Uploads the bundle as one x:PublicKey and points encryptionAtRest at it, in
 * one request, then reads both back. From then on Stalwart encrypts new mail
 * to the bundle.
 */
export async function uploadBundle(
  client: JmapClient,
  accountId: string,
  bundleText: string,
  description: string,
): Promise<string> {
  const response = await client.call(
    [
      ["x:PublicKey/set", { accountId, create: { k: { description, key: bundleText } } }, "p"],
      [
        "x:AccountSettings/set",
        {
          accountId,
          update: {
            singleton: {
              encryptionAtRest: {
                "@type": "Aes256",
                publicKey: "#k",
                encryptOnAppend: true,
                allowSpamTraining: false,
              },
            },
          },
        },
        "s",
      ],
    ],
    USING,
  );

  const created = response.parse("p", "x:PublicKey/set", setResult);
  const id = created.created?.["k"]?.id;

  if (id === undefined) {
    const refusal = created.notCreated?.["k"];

    throw new KastenKeySetupError(
      `Your server refused the key: ${refusal?.description ?? refusal?.type ?? "no reason given"}`,
    );
  }

  const settings = response.parse("s", "x:AccountSettings/set", setResult);

  if (settings.updated?.["singleton"] === undefined) {
    const refusal = settings.notUpdated?.["singleton"];

    throw new KastenKeySetupError(
      `Your server did not turn on encryption: ${refusal?.description ?? refusal?.type ?? "no reason given"}`,
    );
  }

  const readback = await readServerKeys(client, accountId);

  if (
    readback.kind !== "set" ||
    readback.publicKeyId !== id ||
    readback.bundleText.trim() !== bundleText.trim()
  ) {
    throw new KastenKeySetupError("Your server did not keep the key as sent. Try again.");
  }

  return id;
}

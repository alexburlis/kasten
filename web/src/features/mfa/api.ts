// Sign-in codes (TOTP) through x:AccountPassword, as docs/stalwart-v1.0.1.md section 7 describes.
// Every change needs the account password (currentSecret). Removal also needs a current code.
// After `kasten lock` these calls are forbidden: only the operator can change MFA then.
import { CAPABILITY_CORE, KastenJmapError, type JmapClient } from "@kasten/core/jmap";
import { z } from "zod";

import { CAPABILITY_STALWART } from "../keys/server-keys.ts";

const USING = [CAPABILITY_CORE, CAPABILITY_STALWART];

const passwordGet = z.object({
  list: z.array(
    z.object({ id: z.string(), otpAuth: z.object({ otpUrl: z.string().nullish() }).nullish() }),
  ),
});

const setResult = z.object({
  updated: z.record(z.string(), z.json().nullable()).nullish(),
  notUpdated: z
    .record(z.string(), z.object({ type: z.string(), description: z.string().nullish() }))
    .nullish(),
});

export type MfaStatus =
  | { readonly kind: "locked" }
  | { readonly kind: "ready"; readonly enabled: boolean };

export class KastenMfaError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "KastenMfaError";
  }
}

export async function readMfa(client: JmapClient, accountId: string): Promise<MfaStatus> {
  try {
    const response = await client.call(
      [["x:AccountPassword/get", { accountId, ids: ["singleton"] }, "0"]],
      USING,
    );

    const item = response.parse("0", "x:AccountPassword/get", passwordGet).list[0];
    const url = item?.otpAuth?.otpUrl;

    return { kind: "ready", enabled: url !== undefined && url !== null && url !== "" };
  } catch (error) {
    if (error instanceof KastenJmapError && error.type === "forbidden") return { kind: "locked" };

    throw error;
  }
}

async function update(
  client: JmapClient,
  accountId: string,
  currentSecret: string,
  otpAuth: { readonly otpUrl: string | null; readonly otpCode: string },
): Promise<void> {
  const response = await client.call(
    [
      [
        "x:AccountPassword/set",
        { accountId, update: { singleton: { currentSecret, otpAuth: { ...otpAuth } } } },
        "0",
      ],
    ],
    USING,
  );

  const result = response.parse("0", "x:AccountPassword/set", setResult);

  if (result.updated?.["singleton"] !== undefined) return;

  const refusal = result.notUpdated?.["singleton"];

  throw new KastenMfaError(
    refusal?.type === "forbidden"
      ? "Your server refused the change. Check your password and code."
      : `Your server refused the change: ${refusal?.description ?? refusal?.type ?? "no reason given"}`,
  );
}

/** Saves the secret. Call it only after verifyTotp accepted the user's first code. */
export function enrolTotp(
  client: JmapClient,
  accountId: string,
  password: string,
  otpUrl: string,
  code: string,
): Promise<void> {
  return update(client, accountId, password, { otpUrl, otpCode: code });
}

export function removeTotp(
  client: JmapClient,
  accountId: string,
  password: string,
  code: string,
): Promise<void> {
  return update(client, accountId, password, { otpUrl: null, otpCode: code });
}

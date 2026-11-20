import { createHmac } from "node:crypto";

import { CliError } from "./errors.ts";

const SES_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9]$/u;

/** The fixed inputs of AWS's documented SES SMTP password algorithm. */
const DATE = "11111111";

const SERVICE = "ses";

const TERMINAL = "aws4_request";

const MESSAGE = "SendRawEmail";

const VERSION = 0x04;

function sign(key: Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

/**
 * Derives the Amazon SES SMTP password from an IAM secret access key, with AWS's documented
 * SigV4 algorithm: HMAC-SHA256 over date, region, service, terminal and message, prefixed with
 * the version byte 0x04, then base64.
 */
export function sesSmtpPassword(secretAccessKey: string, region: string): string {
  if (!SES_REGION.test(region))
    throw new CliError(`${region} is not an AWS region such as eu-central-1`);

  if (secretAccessKey === "" || /\s/u.test(secretAccessKey)) {
    throw new CliError("the secret access key must be one line without spaces");
  }

  let signature = sign(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), DATE);

  for (const part of [region, SERVICE, TERMINAL, MESSAGE]) signature = sign(signature, part);

  return Buffer.concat([Buffer.from([VERSION]), signature]).toString("base64");
}

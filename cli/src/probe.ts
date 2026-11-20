// `kasten probe`: the daily end-to-end delivery check. The probe account sends one message a day
// to itself. Setup's route rule sends it out through the relay (SES) instead of delivering it
// locally, so it comes back through the public MX. The probe confirms it through JMAP, records
// when the relay accepted it and when it reached a mailbox, and pushes the result to Kuma. While
// it stays the probe, an account sends at most once per UTC day: an ambiguous outcome stays
// ambiguous until the next day. A newly configured probe account sends its own message; another
// account's result never stands in for it. The state file keeps only the latest account's
// attempt, so switching back to an earlier account on the same day sends again. SES replaces the
// Message-ID, so the probe knows the copy that comes back by a random marker in its subject.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import {
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  CAPABILITY_SUBMISSION,
  resultOf,
} from "@kasten/core/jmap";
import { buildMessage } from "@kasten/core/mime";

import { CliError } from "./errors.ts";
import { describeCause } from "./files.ts";
import { isArray, isRecord, isString } from "./json.ts";
import { kumaPush } from "./kuma.ts";
import { readStateFile, writeStateFile } from "./state.ts";
import { credentialFromFile, mailAccountId, userClient } from "./user-jmap.ts";
import { lockState } from "./imap/state.ts";
import type { StateLock } from "./imap/state.ts";

import type { JmapClient, JmapResponse } from "@kasten/core/jmap";

import type { KastenConfig } from "./config.ts";
import type { HttpTransport } from "./jmap-admin.ts";
import type { Json, JsonRecord } from "./json.ts";
import type { Output } from "./setup/setup.ts";

const USING = [CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION];

/** Where today's probe stands. */
export type ProbePhase =
  /** About to submit. Found at the next start, it means the submit may or may not have happened. */
  | "submitting"
  /** Stalwart queued it for the relay. */
  | "submitted"
  /** The relay (SES) accepted it. */
  | "relayAccepted"
  /** It arrived in the probe's mailbox. */
  | "received"
  /** It definitely failed; this probe account sends nothing again today. */
  | "failed"
  /** The outcome is unknown; this probe account does not send again on the same day. */
  | "uncertain";

export interface ProbeState {
  /** The UTC day, YYYY-MM-DD. */
  readonly day: string;
  /**
   * The probe account that made the day's attempt. Null in a state file written before the
   * account was recorded; such a state belongs to the account whose day's Message-ID it carries.
   */
  readonly account: string | null;
  readonly messageId: string;
  /**
   * The random marker in the subject, saved before the submit. SES replaces the Message-ID, so the
   * copy that comes back is known by this. Null in a state file written before the marker
   * existed; no copy is found for such a state.
   */
  readonly marker: string | null;
  readonly phase: ProbePhase;
  readonly submissionId: string | null;
  readonly submittedAt: string | null;
  readonly relayAcceptedAt: string | null;
  readonly receivedAt: string | null;
  /** The mailbox role it arrived in, such as inbox or junk. */
  readonly mailbox: string | null;
  readonly detail: string;
}

const PHASES: readonly ProbePhase[] = [
  "submitting",
  "submitted",
  "relayAccepted",
  "received",
  "failed",
  "uncertain",
];

export function probeStatePath(config: KastenConfig): string {
  return join(config.stateDir, "probe.json");
}

/** The day's Message-ID, which names the day's attempt. SES replaces it, so no copy is found by it. */
export function probeMessageId(account: string, day: string): string {
  return `kasten-probe-${day.replaceAll("-", "")}@${account.slice(account.lastIndexOf("@") + 1)}`;
}

function text(value: Json | undefined): string | null {
  return isString(value) ? value : null;
}

export function decodeProbeState(value: Json | null): ProbeState | null {
  if (value === null) return null;

  if (!isRecord(value) || value["version"] !== 1)
    throw new CliError("the probe state file is not version 1");

  const phase = PHASES.find((candidate) => candidate === value["phase"]);
  const day = text(value["day"]);
  const messageId = text(value["messageId"]);

  if (phase === undefined || day === null || messageId === null)
    throw new CliError("the probe state file is malformed");

  return {
    day,
    account: text(value["account"]),
    messageId,
    marker: text(value["marker"]),
    phase,
    submissionId: text(value["submissionId"]),
    submittedAt: text(value["submittedAt"]),
    relayAcceptedAt: text(value["relayAcceptedAt"]),
    receivedAt: text(value["receivedAt"]),
    mailbox: text(value["mailbox"]),
    detail: text(value["detail"]) ?? "",
  };
}

function encodeProbeState(state: ProbeState): Json {
  return { version: 1, ...state };
}

/** What a run does, given the state file and the day. */
export type ProbeAction = "send" | "follow" | "report";

/** Whether the state is this account's attempt; without a recorded account, its Message-ID says. */
function attemptOf(state: ProbeState, account: string): boolean {
  return state.account === null
    ? state.messageId === probeMessageId(account, state.day)
    : state.account === account;
}

export function nextAction(state: ProbeState | null, account: string, day: string): ProbeAction {
  // Another account's state says nothing about this one, so a switched probe proves itself.
  if (state === null || state.day !== day || !attemptOf(state, account)) return "send";

  if (state.phase === "submitted" || state.phase === "relayAccepted") return "follow";

  // received, failed, uncertain, or a submit that was cut off: never send again today.
  return "report";
}

/** The Kuma message: states and seconds only. */
export function probeMessage(state: ProbeState): string {
  const seconds = (from: string | null, to: string | null): string => {
    if (from === null || to === null) return "?";

    return String(Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)));
  };

  switch (state.phase) {
    case "received":
      return `received: relay ${seconds(state.submittedAt, state.relayAcceptedAt)}s, mailbox ${seconds(state.submittedAt, state.receivedAt)}s (${state.mailbox ?? "?"})`;
    case "relayAccepted":
      return "relay accepted, not in the mailbox yet";
    case "submitted":
      return "queued, relay has not accepted yet";
    case "submitting":
    case "uncertain":
      return "uncertain: the submit may have failed; no resend today";
    case "failed":
      // A relay reply can quote an address; it never reaches the monitor.
      return `failed: ${state.detail
        .replace(/[^\s<>"']+@[^\s<>"']+/gu, "(address)")
        .replace(/[^A-Za-z0-9 ,.;:()=/+%_-]/gu, " ")
        .slice(0, 120)}`;
  }
}

interface ProbeContext {
  readonly client: JmapClient;
  readonly accountId: string;
  readonly account: string;
  readonly save: (state: ProbeState) => void;
}

function created(response: JsonRecord, key: string): JsonRecord | null {
  const map = response["created"];
  const entry = isRecord(map) ? map[key] : undefined;

  return isRecord(entry) ? entry : null;
}

function refusal(response: JsonRecord, key: string): string | null {
  for (const field of ["notCreated", "notUpdated"]) {
    const map = response[field];
    const entry = isRecord(map) ? map[key] : undefined;

    if (isRecord(entry))
      return `${text(entry["type"]) ?? "refused"}: ${text(entry["description"]) ?? ""}`.trim();
  }

  return null;
}

async function mailboxIdByRole(context: ProbeContext, role: string): Promise<string> {
  const response = await context.client.call(
    [["Mailbox/get", { accountId: context.accountId, ids: null, properties: ["id", "role"] }, "0"]],
    USING,
  );

  const list = response.get("0", "Mailbox/get")["list"];

  for (const item of isArray(list) ? list : []) {
    if (isRecord(item) && item["role"] === role && isString(item["id"])) return item["id"];
  }

  throw new CliError(`the probe account has no ${role} mailbox`);
}

/** Submits today's message, the way the app does: a $draft import plus a submission that destroys it. */
async function submit(context: ProbeContext, day: string, now: Date): Promise<ProbeState> {
  const messageId = probeMessageId(context.account, day);
  const marker = randomBytes(8).toString("hex");

  const base: ProbeState = {
    day,
    account: context.account,
    messageId,
    marker,
    phase: "submitting",
    submissionId: null,
    submittedAt: now.toISOString(),
    relayAcceptedAt: null,
    receivedAt: null,
    mailbox: null,
    detail: "",
  };

  const message = buildMessage({
    from: { name: "Kasten probe", email: context.account },
    to: [{ email: context.account }],
    subject: `Kasten delivery probe ${day} ${marker}`,
    text: "An automated end-to-end delivery check. No action is needed.\n",
    messageId,
    date: now,
  });

  const drafts = await mailboxIdByRole(context, "drafts");

  const identities = await context.client.call(
    [["Identity/get", { accountId: context.accountId, ids: null }, "0"]],
    USING,
  );

  const identityList = identities.get("0", "Identity/get")["list"];

  const identity = (isArray(identityList) ? identityList : []).find(
    (item) => isRecord(item) && item["email"] === context.account,
  );

  const identityId = isRecord(identity) ? text(identity["id"]) : null;

  if (identityId === null)
    throw new CliError(`the probe account has no identity for ${context.account}`);

  const upload = await context.client.upload(
    context.accountId,
    message.transmitted,
    "message/rfc822",
  );

  // From here, a crash leaves "submitting", which the next run reports as uncertain.
  context.save(base);

  let response: JmapResponse;

  try {
    response = await context.client.call(
      [
        [
          "Email/import",
          {
            accountId: context.accountId,
            emails: {
              d: {
                blobId: upload.blobId,
                mailboxIds: { [drafts]: true },
                keywords: { $draft: true, $seen: true },
              },
            },
          },
          "i",
        ],
        [
          "EmailSubmission/set",
          {
            accountId: context.accountId,
            create: {
              s: {
                identityId,
                emailId: "#d",
                envelope: {
                  mailFrom: { email: context.account, parameters: null },
                  rcptTo: [{ email: context.account, parameters: null }],
                },
              },
            },
            onSuccessDestroyEmail: ["#s"],
          },
          "s",
        ],
      ],
      USING,
    );
  } catch (cause) {
    const uncertain = {
      ...base,
      phase: "uncertain" as const,
      detail: `the submit got no clear answer: ${describeCause(cause)}`,
    };

    context.save(uncertain);

    return uncertain;
  }

  const imported = response.get("i", "Email/import");
  const draftId = text(created(imported, "d")?.["id"]);
  const submission = response.get("s", "EmailSubmission/set");
  const submissionId = text(created(submission, "s")?.["id"]);

  if (submissionId === null) {
    const reason =
      refusal(submission, "s") ?? refusal(imported, "d") ?? "the server created no submission";

    if (draftId !== null) {
      await context.client.call(
        [["Email/set", { accountId: context.accountId, destroy: [draftId] }, "0"]],
        USING,
      );
    }

    const failed = { ...base, phase: "failed" as const, detail: reason };

    context.save(failed);

    return failed;
  }

  const submitted = { ...base, phase: "submitted" as const, submissionId };

  context.save(submitted);

  return submitted;
}

/** The relay's answer for the probe address: "yes", "no" or "queued". */
async function deliveryState(
  context: ProbeContext,
  submissionId: string,
): Promise<{ readonly delivered: string; readonly reply: string }> {
  const response = await context.client.call(
    [["EmailSubmission/get", { accountId: context.accountId, ids: [submissionId] }, "0"]],
    USING,
  );

  const list = response.get("0", "EmailSubmission/get")["list"];
  const [item] = isArray(list) ? list : [];
  const status = isRecord(item) ? item["deliveryStatus"] : undefined;
  const entry = isRecord(status) ? status[context.account] : undefined;

  return {
    delivered: isRecord(entry) ? (text(entry["delivered"]) ?? "queued") : "queued",
    reply: isRecord(entry) ? (text(entry["smtpReply"]) ?? "") : "",
  };
}

/** Finds today's message in any mailbox and returns its mailbox role and email id. */
async function findReceived(
  context: ProbeContext,
  state: ProbeState,
): Promise<{ readonly id: string; readonly receivedAt: string; readonly role: string } | null> {
  const after = new Date(Date.parse(state.submittedAt ?? state.day) - 60_000)
    .toISOString()
    .replace(/\.\d+Z$/u, "Z");

  const response = await context.client.call(
    [
      [
        "Email/query",
        {
          accountId: context.accountId,
          filter: { after, notKeyword: "$draft" },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: 50,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: context.accountId,
          "#ids": resultOf("q", "Email/query", "/ids"),
          properties: ["id", "subject", "mailboxIds", "receivedAt", "keywords"],
        },
        "g",
      ],
      ["Mailbox/get", { accountId: context.accountId, ids: null, properties: ["id", "role"] }, "m"],
    ],
    USING,
  );

  const list = response.get("g", "Email/get")["list"];
  const boxes = response.get("m", "Mailbox/get")["list"];

  for (const item of isArray(list) ? list : []) {
    if (!isRecord(item)) continue;

    const subject = item["subject"];
    const keywords = item["keywords"];

    // SES replaces the Message-ID, so only the subject's marker tells today's copy apart.
    if (state.marker === null || !isString(subject) || !subject.includes(state.marker)) continue;

    if (isRecord(keywords) && keywords["$draft"] === true) continue;

    const mailboxIds = isRecord(item["mailboxIds"]) ? Object.keys(item["mailboxIds"]) : [];

    const box = (isArray(boxes) ? boxes : []).find(
      (candidate) => isRecord(candidate) && mailboxIds.includes(String(candidate["id"])),
    );

    return {
      id: String(item["id"]),
      receivedAt: text(item["receivedAt"]) ?? new Date().toISOString(),
      role: isRecord(box) ? (text(box["role"]) ?? "no role") : "unknown",
    };
  }

  return null;
}

/** The next state of today's probe. */
function advance(state: ProbeState, change: Partial<ProbeState>): ProbeState {
  return { ...state, ...change };
}

/** Follows a submitted probe until it arrives, fails or the time runs out. */
async function follow(
  context: ProbeContext,
  start: ProbeState,
  deadline: number,
  pollMs: number,
): Promise<ProbeState> {
  let state = start;

  while (Date.now() < deadline) {
    if (state.phase === "submitted" && state.submissionId !== null) {
      const { delivered, reply } = await deliveryState(context, state.submissionId);

      if (delivered === "yes") {
        state = advance(state, {
          phase: "relayAccepted",
          relayAcceptedAt: new Date().toISOString(),
          detail: reply,
        });
        context.save(state);
      } else if (delivered === "no") {
        state = advance(state, { phase: "failed", detail: `the relay refused it: ${reply}` });
        context.save(state);

        return state;
      }
    }

    if (state.phase === "submitted" || state.phase === "relayAccepted") {
      const found = await findReceived(context, state);

      if (found !== null) {
        state = advance(state, {
          phase: "received",
          relayAcceptedAt: state.relayAcceptedAt ?? found.receivedAt,
          receivedAt: found.receivedAt,
          mailbox: found.role,
        });
        context.save(state);
        // The probe mailbox holds nothing else worth keeping.
        await context.client.call(
          [["Email/set", { accountId: context.accountId, destroy: [found.id] }, "0"]],
          USING,
        );

        return state;
      }
    }

    await sleep(pollMs);
  }

  return state;
}

export interface ProbeOptions {
  readonly url: string | null;
  readonly timeoutSeconds: number;
  readonly push: boolean;
  readonly pollMs: number;
}

/** `kasten probe`: 0 when the message arrived, 1 when it did not (yet), 2 on an error. */
export async function commandProbe(
  config: KastenConfig,
  transport: HttpTransport,
  options: ProbeOptions,
  out: Output,
  err: Output,
): Promise<number> {
  const probe = config.probe;

  // Without config.probe there is no probe push URL either, so nothing can be pushed.
  if (probe === null) {
    err.line("kasten: probe failed: kasten probe needs config.probe (account and passwordFile)");

    return 2;
  }

  const path = probeStatePath(config);
  let state: ProbeState | null = null;
  let lock: StateLock | null = null;

  const push = async (status: "up" | "down", message: string): Promise<void> => {
    if (!options.push || probe.kumaPushUrlFile === null) return;

    await kumaPush(transport, probe.kumaPushUrlFile, status, message);
    out.line(`pushed    Kuma: ${status}, "${message}"`);
  };

  try {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    lock = lockState(path, false, "probe");
    const now = new Date();
    const day = now.toISOString().slice(0, 10);

    const client = userClient(
      options.url ?? config.admin.apiUrl,
      credentialFromFile(probe.account, probe.passwordFile),
    );

    const accountId = await mailAccountId(client, probe.account);

    const context: ProbeContext = {
      client,
      accountId,
      account: probe.account,
      save: (next) => writeStateFile(path, encodeProbeState(next)),
    };

    state = decodeProbeState(readStateFile(path));

    const action = nextAction(state, probe.account, day);

    if (action === "send") {
      state = await submit(context, day, now);
      out.line(
        `submit    ${state.messageId}: ${state.phase}${state.detail === "" ? "" : ` (${state.detail})`}`,
      );
    } else {
      out.line(
        `today     ${state?.messageId ?? ""} is already ${state?.phase ?? ""}; this probe account does not send again today`,
      );
    }

    if (state !== null && (state.phase === "submitted" || state.phase === "relayAccepted")) {
      state = await follow(
        context,
        state,
        Date.now() + options.timeoutSeconds * 1000,
        options.pollMs,
      );
    }

    if (state === null) throw new CliError("no probe state");

    if (state.phase === "submitting") {
      state = { ...state, phase: "uncertain", detail: "an earlier run stopped during the submit" };
      context.save(state);
    }

    out.line(
      `relay     ${state.relayAcceptedAt === null ? "not accepted" : `accepted at ${state.relayAcceptedAt}`}`,
    );
    out.line(
      `mailbox   ${state.receivedAt === null ? "not received" : `received at ${state.receivedAt} in ${state.mailbox ?? "?"}`}`,
    );
    out.line(`result    ${probeMessage(state)}`);

    const ok = state.phase === "received";

    await push(ok ? "up" : "down", probeMessage(state));

    return ok ? 0 : 1;
  } catch (cause) {
    err.line(`kasten: probe failed: ${describeCause(cause)}`);

    if (lock === null) return 2;

    try {
      await push("down", "probe error, see the log");
    } catch (pushCause) {
      err.line(`kasten: ${describeCause(pushCause)}`);
    }

    return 2;
  } finally {
    lock?.release();
  }
}

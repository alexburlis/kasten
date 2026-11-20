// `commandProbe` builds its JMAP client with the default fetch transport (user-jmap.ts
// rebasedTransport), so these tests put the fake mail server behind the global fetch. Only Date
// is faked, which fixes the probe's day; timers stay real.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateConfig } from "../../src/config.ts";
import { CliError } from "../../src/errors.ts";
import { isArray, isRecord, parseJson } from "../../src/json.ts";
import { kumaUrl } from "../../src/kuma.ts";
import {
  commandProbe,
  decodeProbeState,
  nextAction,
  probeMessage,
  probeMessageId,
  probeStatePath,
} from "../../src/probe.ts";
import { basicAuthorization } from "../../src/user-jmap.ts";
import { devConfigJson, withField } from "./fixtures.ts";
import { FakeKuma, FakeMailServer, Lines, mime, ORIGIN, scratchDir } from "./read-probe-helpers.ts";

import type { KastenConfig } from "../../src/config.ts";
import type { Json, JsonRecord } from "../../src/json.ts";
import type { ProbeOptions, ProbePhase, ProbeState } from "../../src/probe.ts";

const PROBE = "probe@kasten.test";

/** An earlier probe account in the same domain, so its day's Message-ID is the same as PROBE's. */
const EARLIER = "probe2@kasten.test";

/** A probe account on a pilot domain, before the switch to the main domain. */
const PILOT = "probe@pilot.kasten.test";

const TODAY = "2026-11-04";

const NOW = new Date("2026-11-04T09:00:00.000Z");

const TODAY_ID = "kasten-probe-20261104@kasten.test";

/**
 * "If you provide a Message-ID header, Amazon SES overrides the header with its own value"
 * (docs.aws.amazon.com/ses/latest/dg/header-fields.html), so the copy that comes back has this.
 */
const SES_ID =
  "010f019a4c2b8d1e-5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c-000000@eu-north-1.amazonses.com";

/** A subject marker in planted state files; a real run makes its own. */
const MARKER = "0123456789abcdef";

/** What a run's own marker looks like: 8 random bytes in hex. */
const RUN_MARKER = /^[0-9a-f]{16}$/u;

const PHASES: readonly ProbePhase[] = [
  "submitting",
  "submitted",
  "relayAccepted",
  "received",
  "failed",
  "uncertain",
];

const OPTIONS: ProbeOptions = { url: ORIGIN, timeoutSeconds: 30, push: true, pollMs: 0 };

/** The calls that would send mail. */
const SENDING = ["Email/import", "EmailSubmission/set"];

function state(phase: ProbePhase, day = TODAY): ProbeState {
  return {
    day,
    account: PROBE,
    messageId: probeMessageId(PROBE, day),
    marker: MARKER,
    phase,
    submissionId: null,
    submittedAt: null,
    relayAcceptedAt: null,
    receivedAt: null,
    mailbox: null,
    detail: "",
  };
}

describe("probeMessageId", () => {
  it("is the same all day and different on any other day", () => {
    expect(probeMessageId(PROBE, TODAY)).toBe(TODAY_ID);
    expect(probeMessageId(PROBE, TODAY)).toBe(probeMessageId(PROBE, TODAY));
    expect(probeMessageId(PROBE, "2026-11-05")).toBe("kasten-probe-20261105@kasten.test");
    expect(probeMessageId(PROBE, "2027-11-04")).not.toBe(TODAY_ID);
  });

  it("uses the account's domain but not its local part", () => {
    expect(probeMessageId("someone.private@mail.example.test", TODAY)).toBe(
      "kasten-probe-20261104@mail.example.test",
    );
  });
});

describe("nextAction", () => {
  it("sends when there is no state", () => {
    expect(nextAction(null, PROBE, TODAY)).toBe("send");
  });

  it("sends on a new day, whatever happened the day before", () => {
    for (const phase of PHASES) {
      expect(nextAction(state(phase, "2026-11-03"), PROBE, TODAY)).toBe("send");
    }
  });

  it("follows a message that is on its way", () => {
    expect(nextAction(state("submitted"), PROBE, TODAY)).toBe("follow");
    expect(nextAction(state("relayAccepted"), PROBE, TODAY)).toBe("follow");
  });

  it("never sends again on the same day after a submit was attempted", () => {
    for (const phase of ["submitting", "received", "failed", "uncertain"] as const) {
      expect(nextAction(state(phase), PROBE, TODAY)).toBe("report");
    }
  });

  it("sends for a new probe account, whatever another account's state says today", () => {
    for (const phase of PHASES) {
      expect(nextAction({ ...state(phase), account: EARLIER }, PROBE, TODAY)).toBe("send");
    }
  });

  it("takes a state file from before the account was recorded as the account of its Message-ID", () => {
    for (const phase of ["received", "uncertain"] as const) {
      expect(nextAction({ ...state(phase), account: null }, PROBE, TODAY)).toBe("report");

      expect(
        nextAction(
          { ...state(phase), account: null, messageId: probeMessageId(PILOT, TODAY) },
          PROBE,
          TODAY,
        ),
      ).toBe("send");
    }
  });
});

describe("decodeProbeState", () => {
  it("reads a missing file as no state", () => {
    expect(decodeProbeState(null)).toBeNull();
  });

  it("rejects anything that is not a version 1 object", () => {
    for (const value of [[], "probe", 1, true, {}, { version: 2 }, { version: "1" }] as const) {
      expect(() => decodeProbeState(value)).toThrow("the probe state file is not version 1");
    }
  });

  it("rejects a version 1 file without a known phase, a day or a Message-ID", () => {
    const valid: JsonRecord = { version: 1, day: TODAY, messageId: TODAY_ID, phase: "received" };

    const noMessageId = Object.fromEntries(
      Object.entries(valid).flatMap(([key, value]) => (key === "messageId" ? [] : [[key, value]])),
    );

    for (const json of [
      { ...valid, phase: "sent" },
      { ...valid, phase: null },
      { ...valid, day: 20261104 },
      parseJson(JSON.stringify(noMessageId)),
    ]) {
      expect(() => decodeProbeState(json)).toThrow(CliError);
      expect(() => decodeProbeState(json)).toThrow("the probe state file is malformed");
    }
  });

  it("reads every field, with null for a missing or non-text value", () => {
    expect(
      decodeProbeState({
        version: 1,
        day: TODAY,
        account: PROBE,
        messageId: TODAY_ID,
        marker: MARKER,
        phase: "relayAccepted",
        submissionId: "sub-1",
        submittedAt: "2026-11-04T09:00:00.000Z",
        relayAcceptedAt: 1730710800,
        mailbox: null,
        detail: "250 Ok",
        unknownField: "ignored",
      }),
    ).toEqual({
      day: TODAY,
      account: PROBE,
      messageId: TODAY_ID,
      marker: MARKER,
      phase: "relayAccepted",
      submissionId: "sub-1",
      submittedAt: "2026-11-04T09:00:00.000Z",
      relayAcceptedAt: null,
      receivedAt: null,
      mailbox: null,
      detail: "250 Ok",
    });
  });

  it("reads a missing detail as empty", () => {
    expect(
      decodeProbeState({ version: 1, day: TODAY, messageId: TODAY_ID, phase: "failed" })?.detail,
    ).toBe("");
  });

  it("reads a file from before the subject marker, with no marker", () => {
    expect(
      decodeProbeState({ version: 1, day: TODAY, messageId: TODAY_ID, phase: "received" })?.marker,
    ).toBeNull();
  });

  it("reads a file from before the account was recorded, with no account", () => {
    expect(
      decodeProbeState({ version: 1, day: TODAY, messageId: TODAY_ID, phase: "received" })?.account,
    ).toBeNull();
  });
});

describe("probeMessage", () => {
  const received: ProbeState = {
    ...state("received"),
    submittedAt: "2026-11-04T09:00:00.000Z",
    relayAcceptedAt: "2026-11-04T09:00:12.400Z",
    receivedAt: "2026-11-04T09:00:40.000Z",
    mailbox: "inbox",
  };

  it("gives relay and mailbox seconds for a received message", () => {
    expect(probeMessage(received)).toBe("received: relay 12s, mailbox 40s (inbox)");
  });

  it("never reports negative seconds", () => {
    expect(probeMessage({ ...received, relayAcceptedAt: "2026-11-04T08:59:00.000Z" })).toBe(
      "received: relay 0s, mailbox 40s (inbox)",
    );
  });

  it("names every other phase in plain words", () => {
    expect(probeMessage(state("relayAccepted"))).toBe("relay accepted, not in the mailbox yet");
    expect(probeMessage(state("submitted"))).toBe("queued, relay has not accepted yet");
    expect(probeMessage(state("submitting"))).toBe(
      "uncertain: the submit may have failed; no resend today",
    );
    expect(probeMessage(state("uncertain"))).toBe(
      "uncertain: the submit may have failed; no resend today",
    );
    expect(probeMessage({ ...state("failed"), detail: "the relay refused it: 550 5.1.1" })).toBe(
      "failed: the relay refused it: 550 5.1.1",
    );
  });

  it("turns a failure detail into the characters Kuma accepts, at most 120 of them", () => {
    const detail = `550 <script>alert("x")</script>\r\n\u001b[31m "quoted" ünïcode ${"x".repeat(300)}`;
    const message = probeMessage({ ...state("failed"), detail });

    expect(message).toMatch(/^failed: [A-Za-z0-9 ,.;:()=/+%_-]{0,120}$/u);
    expect(message).not.toMatch(/[<>"\p{Cc}]/u);
    expect(() => kumaUrl("https://kuma.test/api/push/x", "down", message, null)).not.toThrow();
  });

  it("gives Kuma a message it accepts for every phase", () => {
    for (const phase of PHASES) {
      const message = probeMessage({ ...received, phase, detail: "421 try again later" });

      expect(() => kumaUrl("https://kuma.test/api/push/x", "up", message, null)).not.toThrow();
      expect(message).not.toContain(TODAY_ID);
      expect(message).not.toContain("Kasten delivery probe");
    }
  });

  it("never carries the probe address, even when the relay reply quotes it", () => {
    // A Postfix-style refusal quotes the recipient near the start, inside the 120 characters kept.
    const detail =
      "the relay refused it: 550 5.1.1 <probe@kasten.test>: Recipient address rejected: User unknown";

    const message = probeMessage({ ...state("failed"), detail });

    expect(message).not.toContain("kasten.test");
    expect(message).not.toMatch(/\bprobe\b/u);
  });
});

interface Bench {
  readonly dir: string;
  readonly config: KastenConfig;
  readonly server: FakeMailServer;
  readonly kuma: FakeKuma;
}

interface Run {
  readonly code: number;
  readonly out: Lines;
  readonly err: Lines;
}

const dirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();

  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configJson(): JsonRecord {
  const base = devConfigJson();
  const users = base["users"];

  const probeUser = {
    email: PROBE,
    description: "Delivery probe",
    aliases: [],
    passwordFile: "secrets/probe",
  };

  return withField(
    withField(withField(base, "users", [...(isArray(users) ? users : []), probeUser]), "probe", {
      account: PROBE,
      passwordFile: "secrets/probe",
      kumaPushUrlFile: "secrets/kuma-push-url",
    }),
    "stateDir",
    "state",
  );
}

/** A config in a fresh directory, the probe's secret files, the fake server and a Kuma. */
function bench(json: JsonRecord = configJson()): Bench {
  const dir = scratchDir();
  dirs.push(dir);
  mkdirSync(join(dir, "secrets"), { mode: 0o700 });

  // A random value made per run, not a credential.
  const password = crypto.randomUUID();
  writeFileSync(join(dir, "secrets", "probe"), `${password}\n`, { mode: 0o600 });
  writeFileSync(
    join(dir, "secrets", "kuma-push-url"),
    "https://kuma.kasten.test/api/push/probe\n",
    {
      mode: 0o600,
    },
  );

  const server = new FakeMailServer(basicAuthorization({ email: PROBE, secret: password }), PROBE);
  vi.stubGlobal("fetch", server.fetch);

  return { dir, config: validateConfig(json, dir), server, kuma: new FakeKuma() };
}

async function run(target: Bench, options: Partial<ProbeOptions> = {}): Promise<Run> {
  const out = new Lines();
  const err = new Lines();
  const code = await commandProbe(target.config, target.kuma, { ...OPTIONS, ...options }, out, err);

  return { code, out, err };
}

function savedState(target: Bench): JsonRecord {
  const value: Json = parseJson(readFileSync(probeStatePath(target.config), "utf8"));

  if (!isRecord(value)) throw new Error("the probe state is not an object");

  return value;
}

function writeState(target: Bench, value: ProbeState): void {
  mkdirSync(target.config.stateDir, { recursive: true });
  writeFileSync(probeStatePath(target.config), JSON.stringify({ version: 1, ...value }));
}

/** A state file from before the account was recorded: JSON.stringify leaves out the undefined. */
function writeStateWithoutAccount(target: Bench, value: ProbeState): void {
  mkdirSync(target.config.stateDir, { recursive: true });
  writeFileSync(
    probeStatePath(target.config),
    JSON.stringify({ version: 1, ...value, account: undefined }),
  );
}

function sendingCalls(target: Bench, from: number): string[] {
  return target.server.methodsSince(from).filter((name) => SENDING.includes(name));
}

describe("commandProbe", () => {
  it("admits only one overlapping probe for the same state file", async () => {
    const probe = bench();
    await Promise.all([
      run(probe, { timeoutSeconds: 0, push: false }),
      run(probe, { timeoutSeconds: 0, push: false }),
    ]);
    expect(probe.server.submissions.size).toBe(1);
  });

  it("sends today's message, sees it arrive in the inbox and pushes up", async () => {
    const probe = bench();
    probe.server.relay = "yes";
    probe.server.smtpReply = "250 Ok 0107019a";
    probe.server.deliverTo = "inbox";

    const { code, out, err } = await run(probe);

    expect(code).toBe(0);
    expect(err.lines).toEqual([]);
    expect(out.lines).toEqual([
      `submit    ${TODAY_ID}: submitted`,
      "relay     accepted at 2026-11-04T09:00:00.000Z",
      "mailbox   received at 2026-11-04T09:00:04.000Z in inbox",
      "result    received: relay 0s, mailbox 4s (inbox)",
      'pushed    Kuma: up, "received: relay 0s, mailbox 4s (inbox)"',
    ]);
    expect(probe.kuma.pushes).toEqual([
      { status: "up", message: "received: relay 0s, mailbox 4s (inbox)" },
    ]);
    expect(savedState(probe)).toMatchObject({
      version: 1,
      day: TODAY,
      account: PROBE,
      messageId: TODAY_ID,
      marker: expect.stringMatching(RUN_MARKER),
      phase: "received",
      submittedAt: "2026-11-04T09:00:00.000Z",
      relayAcceptedAt: "2026-11-04T09:00:00.000Z",
      receivedAt: "2026-11-04T09:00:04.000Z",
      mailbox: "inbox",
      detail: "250 Ok 0107019a",
    });
    expect(statSync(probeStatePath(probe.config)).mode & 0o777).toBe(0o600);
  });

  it("sends one message to itself with the day's Message-ID and marker and cleans up after it", async () => {
    const probe = bench();
    probe.server.relay = "yes";
    probe.server.deliverTo = "inbox";

    await run(probe);

    const [submission] = probe.server.submissions.values();
    const raw = new TextDecoder().decode(probe.server.blobs.get(submission?.email.blobId ?? ""));
    const marker = savedState(probe)["marker"];

    expect(probe.server.submissions.size).toBe(1);
    expect(submission?.recipients).toEqual([PROBE]);
    expect(raw).toContain(`Message-ID: <${TODAY_ID}>`);
    expect(marker).toMatch(RUN_MARKER);
    expect(raw).toContain(`\r\nSubject: Kasten delivery probe ${TODAY} ${String(marker)}\r\n`);
    expect(submission?.email.mailboxIds).toEqual({ "mb-drafts": true });
    expect(submission?.email.keywords).toEqual({ $draft: true, $seen: true });
    // The draft goes with onSuccessDestroyEmail and the received copy after the check.
    expect(probe.server.emails.size).toBe(0);
    expect(
      probe.server.paths.every((path) => / \/jmap\/(?:session|upload\/a1\/|$)/u.test(path)),
    ).toBe(true);
  });

  it("never sends twice on the same day", async () => {
    const probe = bench();
    probe.server.relay = "yes";
    probe.server.deliverTo = "inbox";
    await run(probe);

    const before = probe.server.calls.length;
    const paths = probe.server.paths.length;
    const second = await run(probe);

    expect(second.code).toBe(0);
    expect(second.out.lines[0]).toBe(
      `today     ${TODAY_ID} is already received; this probe account does not send again today`,
    );
    expect(sendingCalls(probe, before)).toEqual([]);
    expect(probe.server.paths.slice(paths)).toEqual(["GET /jmap/session"]);
    expect(probe.server.submissions.size).toBe(1);
  });

  it("records a submit whose answer was lost as uncertain, and sends nothing more that day", async () => {
    const probe = bench();
    // The worst case: the server queued it and the message went out, but the answer was lost.
    probe.server.breakAfter = "Email/import";
    probe.server.relay = "yes";
    probe.server.deliverTo = "inbox";

    const first = await run(probe);

    expect(first.code).toBe(1);
    expect(first.out.lines[0]).toBe(
      `submit    ${TODAY_ID}: uncertain (the submit got no clear answer: JMAP network (HTTP 0) in Email/import)`,
    );
    expect(savedState(probe)).toMatchObject({
      phase: "uncertain",
      detail: "the submit got no clear answer: JMAP network (HTTP 0) in Email/import",
    });
    expect(probe.kuma.pushes).toEqual([
      { status: "down", message: "uncertain: the submit may have failed; no resend today" },
    ]);

    probe.server.breakAfter = null;

    const before = probe.server.calls.length;
    const second = await run(probe);

    expect(second.code).toBe(1);
    expect(second.out.lines[0]).toBe(
      `today     ${TODAY_ID} is already uncertain; this probe account does not send again today`,
    );
    expect(sendingCalls(probe, before)).toEqual([]);
    expect(probe.server.submissions.size).toBe(1);
    expect(probe.kuma.pushes.at(-1)?.status).toBe("down");
  });

  it("sends again on the next day after an uncertain day", async () => {
    const probe = bench();
    writeState(probe, { ...state("uncertain"), submittedAt: NOW.toISOString() });
    vi.setSystemTime(new Date("2026-11-05T09:00:00.000Z"));
    probe.server.relay = "yes";
    probe.server.deliverTo = "inbox";

    const { code, out } = await run(probe);

    expect(code).toBe(0);
    expect(out.lines[0]).toBe("submit    kasten-probe-20261105@kasten.test: submitted");
    expect(savedState(probe)).toMatchObject({ day: "2026-11-05", phase: "received" });
    expect(savedState(probe)["marker"]).toMatch(RUN_MARKER);
    expect(savedState(probe)["marker"]).not.toBe(MARKER);
  });

  it("proves a newly configured probe account the same day, whatever the earlier account's state", async () => {
    for (const phase of ["received", "uncertain"] as const) {
      const probe = bench();
      writeState(probe, {
        ...state(phase),
        account: EARLIER,
        submittedAt: "2026-11-04T06:40:00.000Z",
        relayAcceptedAt: phase === "received" ? "2026-11-04T06:40:10.000Z" : null,
        receivedAt: phase === "received" ? "2026-11-04T06:40:20.000Z" : null,
        mailbox: phase === "received" ? "inbox" : null,
      });
      probe.server.relay = "yes";
      probe.server.deliverTo = "inbox";

      const { code, out } = await run(probe);

      expect(code, phase).toBe(0);
      expect(out.lines[0], phase).toBe(`submit    ${TODAY_ID}: submitted`);
      expect(sendingCalls(probe, 0), phase).toEqual(SENDING);
      expect(probe.server.submissions.size, phase).toBe(1);
      expect(probe.kuma.pushes, phase).toEqual([
        { status: "up", message: "received: relay 0s, mailbox 4s (inbox)" },
      ]);
      expect(savedState(probe), phase).toMatchObject({
        account: PROBE,
        phase: "received",
        submittedAt: NOW.toISOString(),
      });
    }
  });

  it("keeps a state file from before the account was recorded for the account of its Message-ID", async () => {
    const same = bench();
    writeStateWithoutAccount(same, { ...state("uncertain"), submittedAt: NOW.toISOString() });

    const report = await run(same);

    expect(report.code).toBe(1);
    expect(report.out.lines[0]).toBe(
      `today     ${TODAY_ID} is already uncertain; this probe account does not send again today`,
    );
    expect(sendingCalls(same, 0)).toEqual([]);

    const pilot = bench();
    writeStateWithoutAccount(pilot, {
      ...state("received"),
      messageId: probeMessageId(PILOT, TODAY),
      submittedAt: "2026-11-04T06:40:00.000Z",
      relayAcceptedAt: "2026-11-04T06:40:10.000Z",
      receivedAt: "2026-11-04T06:40:20.000Z",
      mailbox: "inbox",
    });
    pilot.server.relay = "yes";
    pilot.server.deliverTo = "inbox";

    const send = await run(pilot);

    expect(send.code).toBe(0);
    expect(send.out.lines[0]).toBe(`submit    ${TODAY_ID}: submitted`);
    expect(pilot.server.submissions.size).toBe(1);
    expect(savedState(pilot)).toMatchObject({ account: PROBE, phase: "received" });
  });

  it("reports a submit that a crash cut off as uncertain and sends nothing", async () => {
    const probe = bench();
    writeState(probe, { ...state("submitting"), submittedAt: NOW.toISOString() });

    const { code, out } = await run(probe);

    expect(code).toBe(1);
    expect(out.lines).toEqual([
      `today     ${TODAY_ID} is already submitting; this probe account does not send again today`,
      "relay     not accepted",
      "mailbox   not received",
      "result    uncertain: the submit may have failed; no resend today",
      'pushed    Kuma: down, "uncertain: the submit may have failed; no resend today"',
    ]);
    expect(savedState(probe)).toMatchObject({
      phase: "uncertain",
      detail: "an earlier run stopped during the submit",
    });
    expect(probe.server.calls).toEqual([]);
    expect(probe.server.paths).not.toContain("POST /jmap/upload/a1/");
  });

  it("records a relay refusal as failed and does not try again that day", async () => {
    const probe = bench();
    probe.server.relay = "no";
    probe.server.smtpReply = "550 5.7.1 Message rejected";

    const first = await run(probe);

    expect(first.code).toBe(1);
    expect(savedState(probe)).toMatchObject({
      phase: "failed",
      detail: "the relay refused it: 550 5.7.1 Message rejected",
    });
    expect(probe.kuma.pushes).toEqual([
      { status: "down", message: "failed: the relay refused it: 550 5.7.1 Message rejected" },
    ]);

    const before = probe.server.calls.length;
    const second = await run(probe);

    expect(second.code).toBe(1);
    expect(sendingCalls(probe, before)).toEqual([]);
    expect(probe.server.submissions.size).toBe(1);
  });

  it("records a submission the server refuses as failed and removes the draft", async () => {
    const probe = bench();
    probe.server.submissionRefusal = { type: "forbiddenFrom", description: "not allowed" };

    const { code } = await run(probe);

    expect(code).toBe(1);
    expect(savedState(probe)).toMatchObject({
      phase: "failed",
      detail: "forbiddenFrom: not allowed",
    });
    expect(probe.server.methodsSince(0)).toContain("Email/set");
    expect(probe.server.emailsIn("drafts")).toEqual([]);
    expect(probe.kuma.pushes).toEqual([
      { status: "down", message: "failed: forbiddenFrom: not allowed" },
    ]);
  });

  it("follows a queued message on the next run instead of sending another", async () => {
    const probe = bench();

    const first = await run(probe, { timeoutSeconds: 0 });

    expect(first.code).toBe(1);
    expect(savedState(probe)["phase"]).toBe("submitted");
    expect(probe.kuma.pushes).toEqual([
      { status: "down", message: "queued, relay has not accepted yet" },
    ]);

    probe.server.relay = "yes";
    probe.server.deliverTo = "inbox";

    const before = probe.server.calls.length;
    const second = await run(probe);

    expect(second.code).toBe(0);
    expect(second.out.lines[0]).toBe(
      `today     ${TODAY_ID} is already submitted; this probe account does not send again today`,
    );
    expect(sendingCalls(probe, before)).toEqual([]);
    expect(savedState(probe)["phase"]).toBe("received");
  });

  it("counts mail that lands in junk as received and names the mailbox", async () => {
    const probe = bench();
    probe.server.relay = "yes";
    probe.server.deliverTo = "junk";

    const { code } = await run(probe);

    expect(code).toBe(0);
    expect(probe.kuma.pushes).toEqual([
      { status: "up", message: "received: relay 0s, mailbox 4s (junk)" },
    ]);
  });

  it("recognises its message when the relay gives it a new Message-ID, as SES does", async () => {
    const probe = bench();
    probe.server.relay = "yes";
    probe.server.deliverTo = "inbox";
    probe.server.relayMessageId = SES_ID;

    const { code } = await run(probe);

    expect(code).toBe(0);
    expect(probe.kuma.pushes).toEqual([
      { status: "up", message: "received: relay 0s, mailbox 4s (inbox)" },
    ]);
    expect(savedState(probe)["phase"]).toBe("received");
    expect(probe.server.emails.size).toBe(0);
  });

  it("takes only the copy with today's token, not another message with the day's subject or Message-ID", async () => {
    const probe = bench();
    probe.server.relay = "yes";
    probe.server.deliverTo = "inbox";
    probe.server.relayMessageId = SES_ID;
    probe.server.addEmail({
      id: "lookalike",
      raw: mime([
        `Message-ID: <${TODAY_ID}>`,
        `Subject: Kasten delivery probe ${TODAY}`,
        "",
        "Not the probe's message.",
        "",
      ]),
      mailboxId: "mb-inbox",
      receivedAt: "2026-11-04T09:00:30.000Z",
      subject: `Kasten delivery probe ${TODAY}`,
    });

    const { code } = await run(probe);

    expect(code).toBe(0);
    expect(savedState(probe)["receivedAt"]).toBe("2026-11-04T09:00:04.000Z");
    expect([...probe.server.emails.keys()]).toEqual(["lookalike"]);
  });

  it("exits 2 and pushes a generic down when the server refuses the credential", async () => {
    const probe = bench();
    const refusing = new FakeMailServer("Basic not-the-probe-credential", PROBE);
    vi.stubGlobal("fetch", refusing.fetch);

    const { code, out, err } = await run(probe);

    expect(code).toBe(2);
    expect(err.lines).toEqual([
      `kasten: probe failed: ${PROBE}: the server refused the credential (HTTP 401)`,
    ]);
    expect(out.lines).toEqual(['pushed    Kuma: down, "probe error, see the log"']);
    expect(probe.kuma.pushes).toEqual([{ status: "down", message: "probe error, see the log" }]);
    expect(existsSync(probeStatePath(probe.config))).toBe(false);
  });

  it("exits 2 on a state file it cannot read, and sends nothing", async () => {
    for (const content of ["{not json", JSON.stringify({ version: 2, phase: "received" })]) {
      const probe = bench();
      mkdirSync(probe.config.stateDir, { recursive: true });
      writeFileSync(probeStatePath(probe.config), content);

      const { code, err } = await run(probe);

      expect(code).toBe(2);
      expect(err.lines[0]).toMatch(/^kasten: probe failed: .*(?:is not valid JSON|not version 1)/u);
      expect(probe.server.calls).toEqual([]);
      expect(probe.kuma.pushes).toEqual([{ status: "down", message: "probe error, see the log" }]);
    }
  });

  it("still exits 2 when the error push fails too", async () => {
    const probe = bench();
    probe.kuma.refuse = true;
    vi.stubGlobal("fetch", new FakeMailServer("Basic not-the-probe-credential", PROBE).fetch);

    const { code, err } = await run(probe);

    expect(code).toBe(2);
    expect(err.lines).toEqual([
      `kasten: probe failed: ${PROBE}: the server refused the credential (HTTP 401)`,
      "kasten: the Kuma push was refused (HTTP 404)",
    ]);
  });

  it("does not push with --no-push", async () => {
    const probe = bench();
    probe.server.relay = "yes";
    probe.server.deliverTo = "inbox";

    const { code, out } = await run(probe, { push: false });

    expect(code).toBe(0);
    expect(probe.kuma.pushes).toEqual([]);
    expect(out.lines.some((line) => line.startsWith("pushed"))).toBe(false);
  });

  it("does not push when the config names no push URL", async () => {
    const json = configJson();

    const probe = bench(
      withField(json, "probe", {
        account: PROBE,
        passwordFile: "secrets/probe",
        kumaPushUrlFile: null,
      }),
    );

    await run(probe, { timeoutSeconds: 0 });

    expect(probe.kuma.pushes).toEqual([]);
  });

  it("exits 2 without a probe section in the config, which names no push URL either", async () => {
    const probe = bench(withField(configJson(), "probe", null));
    const result = await run(probe);

    expect(result.code).toBe(2);
    expect(result.err.lines).toEqual([
      "kasten: probe failed: kasten probe needs config.probe (account and passwordFile)",
    ]);
    expect(result.out.lines).toEqual([]);
    expect(probe.server.methodsSince(0)).toEqual([]);
    expect(probe.kuma.pushes).toEqual([]);
  });
});

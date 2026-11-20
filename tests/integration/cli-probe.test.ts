// kasten probe and the offline first boot, on a fresh isolated stack: Compose project
// kasten-clitest, ports 7600-7604, subnets 10.76.x. This file creates the stack with
// ./kasten dev up and deletes it again with ./kasten dev reset. Its outbox (Mailpit, the SES
// stand-in) relays the probe account's mail back to Stalwart's port 25 (dev/stack/compose.dev.yaml),
// so the probe follows its message out through the relay and back in through the MX.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isArray, isRecord, isString, parseJson } from "../../cli/src/json.ts";
import { removeDir, runCli, runWrapper, tempDir } from "../../cli/test/integration/live.ts";
import { JmapClient, USING_MAIL } from "../../dev/lib/jmap.ts";
import { adminClient, docker, loadStack, waitFor } from "./lib/stack.ts";

import type { AddressInfo } from "node:net";

import type { JsonRecord } from "../../cli/src/json.ts";
import type { CliRun, IsolatedStack } from "../../cli/test/integration/live.ts";

const shared = loadStack();

const PROJECT = "kasten-clitest";

const API = "http://localhost:7601";

const OUTBOX_API = "http://localhost:7604/api/v1";

const PROBE = "probe@kasten.test";

let dir = "";

let env: IsolatedStack | null = null;

let config = "";

let stateFile = "";

const pushes: URLSearchParams[] = [];

const kuma = createServer((request, response) => {
  pushes.push(new URL(request.url ?? "/", "http://kuma.test").searchParams);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true }));
});

/** Output for an assertion message, without the dev login that `dev up` prints once. */
function shown(run: CliRun): string {
  return `${run.stdout}\n${run.stderr}`.replace(/(Sign in as[^\n]*\n)[^\n]*/gu, "$1    <password>");
}

function devFile(name: string): string {
  return join(dir, "dev", name);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function probeId(day: string): string {
  return `kasten-probe-${day.replaceAll("-", "")}@kasten.test`;
}

async function mailLog(): Promise<string> {
  const result = await docker(shared, ["logs", `${PROJECT}-mail-1`]);

  // Stalwart writes its log to stdout and the entrypoint to stderr.
  return `${result.stdout}\n${result.stderr}`;
}

/** The subjects of the outbox's messages to the probe account with this Message-ID. */
async function outboxSubjects(messageId: string): Promise<unknown[]> {
  const response = await fetch(`${OUTBOX_API}/messages?limit=500`);
  const body = parseJson(await response.text());
  const list = isRecord(body) ? body["messages"] : undefined;

  return (isArray(list) ? list : []).flatMap((item) =>
    isRecord(item) && item["MessageID"] === messageId ? [item["Subject"]] : [],
  );
}

/** How many of the outbox's messages to the probe account have this Message-ID. */
async function outboxCopies(messageId: string): Promise<number> {
  return (await outboxSubjects(messageId)).length;
}

function plantState(state: JsonRecord): void {
  writeFileSync(stateFile, `${JSON.stringify({ version: 1, ...state })}\n`, { mode: 0o600 });
}

function probe(): Promise<CliRun> {
  return runCli(["probe", "--config", config, "--timeout", "120"]);
}

/** Submits one message as the probe account, the way the app does, and returns the outcome. */
async function submitAsProbe(client: JmapClient, accountId: string, to: string): Promise<string> {
  const [identities] = await client.call([["Identity/get", { accountId, ids: null }, "0"]]);
  const list = identities?.[1]["list"];

  const identity = (isArray(list) ? list : []).find(
    (item) => isRecord(item) && item["email"] === PROBE,
  );

  const identityId = isRecord(identity) ? identity["id"] : undefined;

  if (!isString(identityId)) throw new Error("the probe account has no identity");

  const drafts = (await client.mailboxRoles(accountId)).get("drafts") ?? "";
  const messageId = `restriction-${randomBytes(4).toString("hex")}@kasten.test`;

  const blobId = await client.upload(
    accountId,
    new TextEncoder().encode(
      [
        `From: ${PROBE}`,
        `To: ${to}`,
        "Subject: restriction check",
        `Message-ID: <${messageId}>`,
        `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
        "",
        "Should the probe account send this?",
        "",
      ].join("\r\n"),
    ),
    "message/rfc822",
  );

  const [imported, submitted] = await client.call(
    [
      [
        "Email/import",
        {
          accountId,
          emails: {
            d: { blobId, mailboxIds: { [drafts]: true }, keywords: { $draft: true, $seen: true } },
          },
        },
        "i",
      ],
      [
        "EmailSubmission/set",
        {
          accountId,
          create: {
            s: {
              identityId,
              emailId: "#d",
              envelope: {
                mailFrom: { email: PROBE, parameters: null },
                rcptTo: [{ email: to, parameters: null }],
              },
            },
          },
          onSuccessDestroyEmail: ["#s"],
        },
        "s",
      ],
    ],
    USING_MAIL,
  );

  const created = submitted?.[1]["created"];
  const submissionId = isRecord(created) && isRecord(created["s"]) ? created["s"]["id"] : undefined;

  if (!isString(submissionId)) {
    const draft = imported?.[1]["created"];
    const draftId = isRecord(draft) && isRecord(draft["d"]) ? draft["d"]["id"] : undefined;

    if (isString(draftId)) await client.one("Email/set", { accountId, destroy: [draftId] });

    return `not created ${JSON.stringify(submitted?.[1]["notCreated"])}`;
  }

  // Stalwart creates the submission even when it refuses every recipient: the refusal is that
  // recipient's deliveryStatus, with `delivered: "no"` and the SMTP reply.
  const result = await client.one("EmailSubmission/get", { accountId, ids: [submissionId] });
  const submissions = result["list"];

  const status =
    isArray(submissions) && isRecord(submissions[0]) ? submissions[0]["deliveryStatus"] : undefined;

  const entry = isRecord(status) ? status[to] : undefined;

  if (!isRecord(entry)) return `no delivery status ${JSON.stringify(result)}`;

  return entry["delivered"] === "no" ? `refused: ${String(entry["smtpReply"])}` : "accepted";
}

beforeAll(async () => {
  const existing = await docker(shared, [
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${PROJECT}`,
  ]);

  if (existing.stdout.trim() !== "")
    throw new Error(
      `a ${PROJECT} stack already exists; remove it first, for example with KASTEN_DEV_PROJECT=${PROJECT} KASTEN_DEV_PORT_BASE=7600 KASTEN_DEV_NET=76 KASTEN_DEV_DIR=<its dir> ./kasten dev reset --yes`,
    );

  dir = tempDir(shared, "cli-probe");
  env = {
    project: PROJECT,
    portBase: 7600,
    net: 76,
    devDir: join(dir, "dev"),
    dockerContext: shared.dockerContext,
  };

  const up = await runWrapper(["dev", "up"], env);

  if (up.code !== 0) throw new Error(`./kasten dev up failed:\n${shown(up)}`);

  await new Promise<void>((done) => kuma.listen(0, "127.0.0.1", done));

  // SAFETY: a listening TCP server's address() is an AddressInfo, never a pipe name or null.
  const port = (kuma.address() as AddressInfo).port;
  const kumaFile = join(dir, "probe-kuma-url");

  writeFileSync(kumaFile, `http://127.0.0.1:${port}/api/push/PR0BE?status=up&msg=OK&ping=\n`, {
    mode: 0o600,
  });
  mkdirSync(join(dir, "state"), { mode: 0o700 });
  stateFile = join(dir, "state", "probe.json");
  config = join(dir, "kasten.json");
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        serverHostname: "mx.kasten.test",
        mailApiHostname: "localhost",
        domains: [{ name: "kasten.test", catchAll: null }],
        users: [{ email: PROBE, description: null, aliases: [] }],
        webApp: {
          origin: "http://localhost:7600",
          redirectPath: "/oauth/callback",
          oauthClientId: "kasten-web",
        },
        http: { mode: "dev", bind: "0.0.0.0:8080" },
        relays: [
          {
            domain: "kasten.test",
            host: "outbox",
            port: 587,
            usernameFile: "unused-relay-user",
            passwordFile: "unused-relay-password",
          },
        ],
        operatorPublicKeyFile: devFile("operator/pub.asc"),
        admin: {
          apiUrl: API,
          apiKeyFile: devFile("admin-api-key"),
          account: "kasten-admin",
          allowedIps: ["10.76.81.0/28", "10.76.80.1"],
        },
        kumaPushUrlFile: null,
        stateDir: join(dir, "state"),
        probe: {
          account: PROBE,
          passwordFile: devFile("probe-password"),
          kumaPushUrlFile: kumaFile,
        },
        dns: { sesRegion: "eu-central-1" },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}, 600_000);

afterAll(async () => {
  kuma.close();

  if (env === null) return;

  const reset = await runWrapper(["dev", "reset", "--yes"], env);

  removeDir(dir);

  if (reset.code !== 0) throw new Error(`./kasten dev reset failed:\n${shown(reset)}`);
}, 180_000);

/** Kasten's sign-in page bundle in the server image (server/Dockerfile). */
const SIGNIN_BUNDLE = "/opt/kasten/kasten-signin.zip";

describe("the first boot of a fresh stack", () => {
  it("downloads nothing: the one recovery start has no network, and bootstrap turns every download off", async () => {
    const recovery = readFileSync(devFile("first-boot-recovery.log"), "utf8");
    const fetches = recovery.split("\n").filter((line) => line.includes("webui.zip"));

    // Stalwart inserts its web UI and starts the fetch before it reads any configuration
    // (defaults.rs:57-76). Without a network, that one attempt fails.
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain("Failed to fetch application bundle");
    expect(fetches[0]).toContain("error sending request");
    expect(recovery).not.toMatch(/application-(unpacked|updated)|ip-location-db/iu);

    const log = await mailLog();

    expect(log).toContain("Starting Stalwart Server");
    // The rules import found the four lists that bootstrap stored disabled: 0 added, 4 updated.
    expect(log).toContain('["HttpLookup", 0, 4, 0, 0]');

    // The one bundle Stalwart unpacks is Kasten's sign-in page, from a file in the server image.
    const others = log
      .split("\n")
      .filter((line) => !line.includes(SIGNIN_BUNDLE))
      .join("\n");

    expect(others).not.toMatch(
      /webui|ip-location-db|openphish|phishtank|disposable|http-store|application-(unpacked|updated)|resource\.error/iu,
    );

    const admin = adminClient({
      ...shared,
      apiUrl: API,
      adminApiKeyFile: devFile("admin-api-key"),
    });

    const applications = await admin.get("x:Application", null);
    const lookups = await admin.get("x:HttpLookup", null);

    const signIn = applications.filter((item) => item["description"] === "Kasten sign-in page");

    expect(signIn).toEqual([
      expect.objectContaining({ enable: true, resourceUrl: `file://${SIGNIN_BUNDLE}` }),
    ]);
    expect(applications.length).toBeGreaterThan(1);
    expect(
      applications
        .filter((item) => !signIn.includes(item))
        .every((item) => item["enable"] === false),
    ).toBe(true);
    expect((await admin.get("x:Asn", ["singleton"]))[0]?.["@type"]).toBe("Disabled");
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((item) => item["enable"] === false)).toBe(true);

    const tracers = await admin.get("x:Tracer", null);

    expect(
      tracers
        .filter((item) => item["enable"] === true)
        .map((item) => [item["@type"], item["level"]]),
    ).toEqual([["Stdout", "info"]]);
  });
});

describe("kasten probe", () => {
  it("sends today's message once, follows it through the relay and the MX, and reports to Kuma", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    plantState({
      day: yesterday,
      messageId: probeId(yesterday),
      phase: "received",
      submissionId: null,
      submittedAt: `${yesterday}T06:00:00.000Z`,
      relayAcceptedAt: `${yesterday}T06:00:02.000Z`,
      receivedAt: `${yesterday}T06:00:03Z`,
      mailbox: "inbox",
      detail: "",
    });

    const run = await probe();

    expect(run.code, shown(run)).toBe(0);
    expect(run.stdout).toContain(`submit    ${probeId(today())}: submitted`);
    expect(run.stdout).toMatch(/^relay {5}accepted at /mu);
    expect(run.stdout).toMatch(/^mailbox {3}received at \S+ in (inbox|junk)$/mu);
    expect(pushes.at(-1)?.get("status")).toBe("up");
    expect(pushes.at(-1)?.get("msg")).toMatch(
      /^received: relay \d+s, mailbox \d+s \((inbox|junk)\)$/u,
    );
    expect(probeId(today())).not.toBe(probeId(yesterday));

    const state = parseJson(readFileSync(stateFile, "utf8"));

    expect(isRecord(state) && state["phase"]).toBe("received");
    expect(isRecord(state) && state["day"]).toBe(today());
    expect(isRecord(state) && state["account"]).toBe(PROBE);

    const marker = isRecord(state) ? state["marker"] : null;

    expect(marker).toMatch(/^[0-9a-f]{16}$/u);

    // The outbox (SES) holds exactly one copy, which it relayed to Stalwart's port 25. The probe
    // knows that copy only by this subject marker, because SES replaces the Message-ID.
    expect(await outboxSubjects(probeId(today()))).toEqual([
      `Kasten delivery probe ${today()} ${String(marker)}`,
    ]);

    const log = await mailLog();

    expect(log).toMatch(/Message queued for delivery|queue\.message-queued/u);
    expect(log).toMatch(/message-ingest\.(ham|spam)/u);
  });

  it("never sends again on the same day", async () => {
    const run = await probe();

    expect(run.code, shown(run)).toBe(0);
    expect(run.stdout).toContain(`today     ${probeId(today())} is already received`);
    expect(await outboxCopies(probeId(today()))).toBe(1);
  });

  it("does not resend after an ambiguous outcome, and reports it down", async () => {
    plantState({
      day: today(),
      messageId: probeId(today()),
      phase: "submitting",
      submissionId: null,
      submittedAt: new Date().toISOString(),
      relayAcceptedAt: null,
      receivedAt: null,
      mailbox: null,
      detail: "",
    });

    for (const attempt of [1, 2]) {
      const run = await probe();

      expect(run.code, `attempt ${attempt}: ${shown(run)}`).toBe(1);
      expect(run.stdout).toContain(
        "result    uncertain: the submit may have failed; no resend today",
      );
      expect(pushes.at(-1)?.get("status")).toBe("down");
    }

    expect(await outboxCopies(probeId(today()))).toBe(1);

    const state = parseJson(readFileSync(stateFile, "utf8"));

    expect(isRecord(state) && state["phase"]).toBe("uncertain");
  });

  it("restricts the probe account: no mail to other domains; local addresses stay possible", async () => {
    const secret = readFileSync(devFile("probe-password"), "utf8").trim();
    const client = new JmapClient(API, { kind: "basic", user: PROBE, secret });
    const { accountId } = await client.session();

    expect(await submitAsProbe(client, accountId, "someone@example.test")).toMatch(
      /^refused: 550 5\.7\.1 Relay not allowed/u,
    );
    // v1.0.1 has no per-account recipient rule, so the probe account can still reach local
    // addresses (docs/stalwart-v1.0.1.md, "The probe account").
    expect(await submitAsProbe(client, accountId, "sam@kasten.test")).toBe("accepted");
  });
});

describe("the stdout tracer", () => {
  it("logs delivery at info without subjects or bodies", async () => {
    if (env === null) throw new Error("the stack is not up");

    const mail = await runWrapper(["dev", "mail"], env);

    expect(mail.code, shown(mail)).toBe(0);
    expect(mail.stdout).toContain("messages are in the Inbox of you@kasten.test");

    const log = await waitFor("the delivery log lines", 20_000, async () => {
      const text = await mailLog();

      return (text.match(/message-ingest\.ham/gu) ?? []).length >= 6 ? text : null;
    });

    for (const secret of [
      "ridge loop",
      "packing list",
      "This week on the trail",
      "Kasten delivery probe",
      "Shall we do",
      "restriction check",
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});

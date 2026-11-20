// kasten domain remove against the shared dev stack, on a throwaway pilot domain: an account in
// it, an alias of a kasten.test account in it, and the DKIM keys Stalwart generates for every new
// domain. The command refuses while the alias remains, lists everything and changes nothing
// without --yes, then destroys it all with --yes. Afterwards SMTP refuses the pilot address and
// the kasten.test account still works.
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeDir, runCli, tempDir, writeConfig } from "../../cli/test/integration/live.ts";
import { isString } from "../../cli/src/json.ts";
import { sendMailPatiently } from "../../dev/lib/smtp.ts";
import { adminClient, createAccount, destroyAccount, loadStack, waitFor } from "./lib/stack.ts";

import type { TestAccount } from "./lib/stack.ts";

const stack = loadStack();

const pilot = `it-pilot-${randomBytes(4).toString("hex")}.test`;

const target = { host: stack.smtpHost, port: stack.smtpPort, helo: "pilot-sender.example.test" };

let dir: string | undefined;

let config = "";

let owner: TestAccount | undefined;

let domainId = "";

let pilotAccountId = "";

function message(to: string): string {
  return [
    "From: Pilot Sender <sender@example.test>",
    `To: ${to}`,
    "Subject: Pilot domain test",
    `Message-ID: <pilot-${randomBytes(4).toString("hex")}@example.test>`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "A pilot domain test message.",
    "",
  ].join("\r\n");
}

function remove(...extra: string[]): ReturnType<typeof runCli> {
  return runCli(["domain", "remove", pilot, "--config", config, ...extra]);
}

beforeAll(async () => {
  dir = tempDir(stack, "domain-remove");
  config = writeConfig(stack, dir, {
    users: [],
    probe: null,
    kumaPushUrlFile: null,
    oauthClientId: stack.oauthClientId,
  });

  const admin = adminClient(stack);

  // As kasten setup creates a domain (specs.ts domainSpecs).
  const domain = await admin.set("x:Domain", {
    create: {
      d: {
        name: pilot,
        enable: true,
        catchAllAddress: null,
        certificateManagement: { "@type": "Manual" },
        dnsManagement: { "@type": "Manual" },
      },
    },
  });

  const id = domain.created["d"]?.["id"];

  if (!isString(id)) throw new Error("x:Domain/set created no domain");

  domainId = id;

  const account = await admin.set("x:Account", {
    create: {
      a: {
        "@type": "User",
        name: "pilot",
        domainId,
        description: "Integration test pilot account",
        roles: { "@type": "User" },
        credentials: {
          "0": { "@type": "Password", secret: `${randomBytes(18).toString("base64url")}-Kq7` },
        },
      },
    },
  });

  const accountId = account.created["a"]?.["id"];

  if (!isString(accountId)) throw new Error("x:Account/set created no account");

  pilotAccountId = accountId;
  owner = await createAccount(stack, "it-domain-owner");

  await admin.set("x:Account", {
    update: {
      [owner.principalId]: {
        aliases: { "0": { name: "hello", domainId, enable: true, description: null } },
      },
    },
  });
});

afterAll(async () => {
  // The owner goes first, with its alias, so a removal left over by a failed test can run.
  await destroyAccount(stack, owner);

  if ((await adminClient(stack).get("x:Domain", null)).some((d) => d["name"] === pilot)) {
    const cleanup = await remove("--yes");

    if (cleanup.code !== 0) throw new Error(`cleanup of ${pilot} failed: ${cleanup.stderr}`);
  }

  removeDir(dir);
});

describe("kasten domain remove", () => {
  it("removes a pilot domain with its account and DKIM keys, after which SMTP refuses it", async () => {
    const admin = adminClient(stack);
    const email = owner?.email ?? "";

    const keys = await waitFor(
      "the DKIM keys Stalwart generates for a new domain",
      30_000,
      async () => {
        const found = (await admin.get("x:DkimSignature", null)).filter(
          (key) => key["domainId"] === domainId,
        );

        return found.length > 0 ? found : null;
      },
    );

    const accepted = await sendMailPatiently(
      target,
      { from: "sender@example.test", to: [`pilot@${pilot}`] },
      message(`pilot@${pilot}`),
    );

    expect(accepted.code).toBe(250);

    const blocked = await remove("--yes");

    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain(`hello@${pilot} is an alias of ${email}`);

    await admin.set("x:Account", { update: { [owner?.principalId ?? ""]: { aliases: {} } } });

    const preview = await remove();

    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(
      `remove    x:Account pilot@${pilot} (id ${pilotAccountId}), with all its mail`,
    );

    for (const key of keys)
      expect(preview.stdout).toContain(`remove    x:DkimSignature ${String(key["selector"])}`);

    expect(preview.stdout).toContain(`remove    x:Domain ${pilot} (id ${domainId})`);
    expect(preview.stdout).toContain("nothing changed");
    expect(await admin.get("x:Domain", [domainId])).toHaveLength(1);

    const removed = await remove("--yes");

    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain(
      `verified  x:Domain ${pilot} and everything in it are gone from the server`,
    );

    expect((await admin.get("x:Domain", null)).filter((d) => d["name"] === pilot)).toEqual([]);
    expect((await admin.get("x:Account", null)).filter((a) => a["domainId"] === domainId)).toEqual(
      [],
    );
    expect(
      (await admin.get("x:DkimSignature", null)).filter((k) => k["domainId"] === domainId),
    ).toEqual([]);

    await expect(
      sendMailPatiently(
        target,
        { from: "sender@example.test", to: [`pilot@${pilot}`] },
        message(`pilot@${pilot}`),
      ),
    ).rejects.toThrow(/RCPT TO: 550/u);

    expect((await owner?.client.session())?.accountId).toBe(owner?.accountId);

    const again = await remove("--yes");

    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain(`absent    x:Domain ${pilot}: not on the server`);
  });
});

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateConfig } from "../../src/config.ts";
import { domainRemove } from "../../src/domains.ts";
import { AdminClient } from "../../src/jmap-admin.ts";
import { isRecord, parseJson } from "../../src/json.ts";
import { main } from "../../src/main.ts";
import { devConfigJson } from "./fixtures.ts";
import {
  FakeAdmin,
  Lines,
  adminClient,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./keys-lock-helpers.ts";

import type { KastenConfig } from "../../src/config.ts";
import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/jmap-admin.ts";

const PILOT = "pilot.kasten.test";

let config: KastenConfig;

beforeEach(() => {
  config = validateConfig(devConfigJson(), temporaryDirectory());
});

afterEach(() => {
  removeTemporaryDirectories();
});

/**
 * kasten.test (d1, in kasten.json) and the pilot domain (d2, no longer in it), as Stalwart has
 * them after kasten setup: the pilot's probe account and the leftover pilot account, a mailing
 * list, the two DKIM keys Stalwart generated for it, and kasten.test's own objects.
 */
function server(): FakeAdmin {
  const fake = new FakeAdmin();

  fake.put("x:Domain", [
    { id: "d1", name: "kasten.test" },
    { id: "d2", name: PILOT },
  ]);
  fake.put("x:Account", [
    {
      id: "a1",
      "@type": "User",
      name: "you",
      domainId: "d1",
      roles: { "@type": "User" },
      aliases: { "0": { name: "hello", domainId: "d1", enable: true, description: null } },
    },
    {
      id: "a0",
      "@type": "User",
      name: "kasten-admin",
      domainId: "d1",
      roles: { "@type": "Admin" },
    },
    { id: "a2", "@type": "User", name: "probe", domainId: "d2", roles: { "@type": "User" } },
    { id: "a3", "@type": "User", name: "old", domainId: "d2", roles: { "@type": "User" } },
  ]);
  fake.put("x:MailingList", [
    { id: "l1", name: "team", domainId: "d2" },
    { id: "l2", name: "news", domainId: "d1" },
  ]);
  fake.put("x:DkimSignature", [
    { id: "k1", "@type": "Dkim1Ed25519Sha256", domainId: "d1", selector: "v1-ed25519-20261101" },
    { id: "k2", "@type": "Dkim1Ed25519Sha256", domainId: "d2", selector: "v1-ed25519-20261104" },
    { id: "k3", "@type": "Dkim1RsaSha256", domainId: "d2", selector: "v1-rsa-20261104" },
  ]);
  fake.put("x:SystemSettings", [{ id: "singleton", defaultDomainId: "d1" }]);

  return fake;
}

function ids(fake: FakeAdmin, object: string): unknown[] {
  return fake.items(object).map((item) => item["id"]);
}

describe("kasten domain remove", () => {
  it("lists the domain and everything in it, and changes nothing without --yes", async () => {
    const fake = server();
    const out = new Lines();

    await domainRemove(adminClient(fake), config, PILOT, false, out);

    expect(fake.sets()).toEqual([]);
    expect(out.lines).toEqual([
      `remove    x:Account probe@${PILOT} (id a2), with all its mail`,
      `remove    x:Account old@${PILOT} (id a3), with all its mail`,
      `remove    x:MailingList team@${PILOT} (id l1)`,
      `remove    x:DkimSignature v1-ed25519-20261104 (id k2)`,
      `remove    x:DkimSignature v1-rsa-20261104 (id k3)`,
      `remove    x:Domain ${PILOT} (id d2)`,
      "note      nothing changed; run it again with --yes to destroy these 6 objects",
    ]);
  });

  it("with --yes destroys the contents, then the domain, and reads back that they are gone", async () => {
    const fake = server();
    const out = new Lines();

    await domainRemove(adminClient(fake), config, PILOT, true, out);

    expect(fake.sets().map((call) => [call.method, call.args["destroy"]])).toEqual([
      ["x:Account/set", ["a2", "a3"]],
      ["x:MailingList/set", ["l1"]],
      ["x:DkimSignature/set", ["k2", "k3"]],
      ["x:Domain/set", ["d2"]],
    ]);
    expect(ids(fake, "x:Domain")).toEqual(["d1"]);
    expect(ids(fake, "x:Account")).toEqual(["a1", "a0"]);
    expect(ids(fake, "x:MailingList")).toEqual(["l2"]);
    expect(ids(fake, "x:DkimSignature")).toEqual(["k1"]);
    expect(out.lines.slice(-5)).toEqual([
      "destroyed x:Account (2)",
      "destroyed x:MailingList (1)",
      "destroyed x:DkimSignature (2)",
      `destroyed x:Domain ${PILOT}`,
      `verified  x:Domain ${PILOT} and everything in it are gone from the server`,
    ]);
  });

  it("destroys only the domain when nothing is in it", async () => {
    const fake = new FakeAdmin();

    fake.put("x:Domain", [
      { id: "d1", name: "kasten.test" },
      { id: "d2", name: PILOT },
    ]);
    fake.put("x:SystemSettings", [{ id: "singleton", defaultDomainId: "d1" }]);

    await domainRemove(adminClient(fake), config, PILOT, true, new Lines());

    expect(fake.sets().map((call) => call.method)).toEqual(["x:Domain/set"]);
    expect(ids(fake, "x:Domain")).toEqual(["d1"]);
  });

  it("refuses a domain that kasten.json still lists, before any call", async () => {
    const fake = server();

    await expect(
      domainRemove(adminClient(fake), config, "kasten.test", true, new Lines()),
    ).rejects.toThrow(
      "kasten.test is still in kasten.json; remove it and every address in it from domains, users, relays, probe and dns.sesDkimTokens, run kasten setup, then run this again",
    );
    expect(fake.calls).toEqual([]);
  });

  it("refuses a domain whose address is still an alias of an account in another domain", async () => {
    const fake = server();

    fake.put("x:Account", [
      ...fake.items("x:Account"),
      {
        id: "a4",
        "@type": "User",
        name: "me",
        domainId: "d1",
        roles: { "@type": "User" },
        aliases: { "0": { name: "hi", domainId: "d2", enable: true, description: null } },
      },
    ]);

    await expect(domainRemove(adminClient(fake), config, PILOT, true, new Lines())).rejects.toThrow(
      `cannot remove ${PILOT}: hi@${PILOT} is an alias of me@kasten.test; kasten setup removes the aliases that kasten.json no longer lists`,
    );
    expect(fake.sets()).toEqual([]);
  });

  it("refuses the server's default domain", async () => {
    const fake = server();

    fake.put("x:SystemSettings", [{ id: "singleton", defaultDomainId: "d2" }]);

    await expect(domainRemove(adminClient(fake), config, PILOT, true, new Lines())).rejects.toThrow(
      /it is the server's default domain.*kasten setup/u,
    );
    expect(fake.sets()).toEqual([]);
  });

  it("refuses to destroy an admin account, which may own the admin API key", async () => {
    const fake = server();

    fake.put("x:Account", [
      ...fake.items("x:Account"),
      { id: "a5", "@type": "User", name: "admin", domainId: "d2", roles: { "@type": "Admin" } },
    ]);

    await expect(domainRemove(adminClient(fake), config, PILOT, true, new Lines())).rejects.toThrow(
      `cannot remove ${PILOT}: admin@${PILOT} holds the Admin role; Kasten never removes an admin account`,
    );
    expect(fake.sets()).toEqual([]);
  });

  it("reports a domain that is not on the server, so a second run succeeds", async () => {
    const fake = server();
    const out = new Lines();

    await domainRemove(adminClient(fake), config, "gone.kasten.test", true, out);

    expect(fake.sets()).toEqual([]);
    expect(out.lines).toEqual(["absent    x:Domain gone.kasten.test: not on the server"]);
  });

  it("fails when the readback still finds the domain", async () => {
    const fake = server();

    /** Acknowledges x:Domain/set destroy without doing it. */
    const forgetful: HttpTransport = {
      async send(request: HttpRequest): Promise<HttpResponse> {
        const body = parseJson(request.body ?? "null");
        const calls = isRecord(body) ? body["methodCalls"] : null;

        if (JSON.stringify(calls).includes('"x:Domain/set"')) {
          return {
            status: 200,
            body: JSON.stringify({
              methodResponses: [["x:Domain/set", { destroyed: ["d2"] }, "0"]],
            }),
          };
        }

        return fake.send(request);
      },
    };

    const lying = new AdminClient(forgetful, "http://admin.test", {
      kind: "apiKey",
      key: ["API", "unit"].join("_"),
    });

    await expect(domainRemove(lying, config, PILOT, true, new Lines())).rejects.toThrow(
      `readback: still on the server: x:Domain ${PILOT} (id d2)`,
    );
  });

  it("is wired into the command line", async () => {
    const dir = temporaryDirectory();

    mkdirSync(join(dir, "secrets"));
    writeFileSync(join(dir, "secrets", "admin-api-key"), `${["API", "unit"].join("_")}\n`, {
      mode: 0o600,
    });
    writeFileSync(join(dir, "kasten.json"), JSON.stringify(devConfigJson()));

    const fake = server();
    const path = join(dir, "kasten.json");

    expect(await main(["domain", "remove", PILOT, "--config", path], fake)).toBe(0);
    expect(fake.sets()).toEqual([]);
    expect(await main(["domain", "remove", PILOT, "--config", path, "--yes"], fake)).toBe(0);
    expect(ids(fake, "x:Domain")).toEqual(["d1"]);
    expect(await main(["domain", "remove", "--config", path], fake)).toBe(2);
    expect(await main(["domain", "delete", PILOT, "--config", path], fake)).toBe(2);
  });
});

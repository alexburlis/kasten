// kasten config export against the shared dev stack: every configuration type of the live
// schema, masked secrets, every spam rule across pages, and a changed setting that shows up as
// exactly that one difference. Other test files create accounts and OAuth clients at the same
// time, so comparisons leave out x:Account and x:OAuthClient.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeDir, runCli, tempDir, writeConfig } from "../../cli/test/integration/live.ts";
import { NOT_CONFIGURATION } from "../../cli/src/config-export.ts";
import { isArray, isNumber, isRecord, parseJson } from "../../cli/src/json.ts";
import { adminClient, loadStack } from "./lib/stack.ts";

import type { JsonRecord } from "../../cli/src/json.ts";

const stack = loadStack();

const SHARED = new Set(["x:Account", "x:OAuthClient"]);

let dir: string | undefined;

let config = "";

let pyzorBlockCount: number | undefined;

async function exportTo(name: string): Promise<{ path: string; text: string; file: JsonRecord }> {
  const path = join(dir ?? "", name);
  let run = await runCli(["config", "export", "--config", config, "--out", path]);

  // The export refuses a type that changed while it read it. Other test files create accounts and
  // OAuth clients meanwhile, so that refusal is theirs: export again, a bounded number of times.
  for (let attempt = 1; attempt < 5 && /changed while export/u.test(run.stderr); attempt += 1)
    run = await runCli(["config", "export", "--config", config, "--out", path]);

  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  expect(run.stdout).toMatch(/^exported \d+ objects of \d+ configuration types to /u);

  const text = readFileSync(path, "utf8");
  const file = parseJson(text);

  if (!isRecord(file)) throw new Error(`${name} is not a JSON object`);

  return { path, text, file };
}

function objects(file: JsonRecord): JsonRecord {
  const value = file["objects"];

  if (!isRecord(value)) throw new Error("the export has no objects");

  return value;
}

/** The export without the types that concurrent test files change. */
function stable(file: JsonRecord): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(objects(file)).filter(([type]) => !SHARED.has(type))),
  );
}

async function pyzor(): Promise<JsonRecord> {
  const [singleton] = await adminClient(stack).get("x:SpamPyzor", ["singleton"]);

  if (singleton === undefined) throw new Error("no x:SpamPyzor singleton");

  return singleton;
}

function pyzorOf(file: JsonRecord): JsonRecord {
  const type = objects(file)["x:SpamPyzor"];
  const singleton = isRecord(type) ? type["singleton"] : undefined;

  if (!isRecord(singleton)) throw new Error("the export has no x:SpamPyzor singleton");

  return singleton;
}

beforeAll(() => {
  dir = tempDir(stack, "cli-config-export");
  config = writeConfig(stack, dir, {
    users: [],
    probe: null,
    kumaPushUrlFile: null,
    oauthClientId: "kasten-web",
  });
});

afterAll(async () => {
  if (pyzorBlockCount !== undefined) {
    await adminClient(stack).set("x:SpamPyzor", {
      update: { singleton: { blockCount: pyzorBlockCount } },
    });
  }

  removeDir(dir);
});

describe("kasten config export", () => {
  it("exports every configuration type of the live schema, with secrets masked", async () => {
    const { path, text, file } = await exportTo("complete.json");
    const { hash, schema } = await adminClient(stack).schema();
    const listed = isRecord(schema["objects"]) ? schema["objects"] : {};

    const expected = Object.entries(listed)
      .filter(
        ([name, entry]) => name.startsWith("x:") && isRecord(entry) && entry["type"] !== "view",
      )
      .map(([name]) => name)
      .filter((name) => !NOT_CONFIGURATION.has(name))
      .sort();

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(file["format"]).toBe("kasten-config-export/1");
    expect(file["schema"]).toBe(hash);
    expect(Object.keys(objects(file)).sort()).toEqual(expected);
    expect(expected).toContain("x:OidcProvider");
    expect(objects(file)["x:Asn"]).toEqual({ singleton: { "@type": "Disabled", id: "singleton" } });

    // Kasten's setup never writes x:SpamPyzor; the export holds Stalwart's own readback of it.
    expect(pyzorOf(file)["enable"]).toBe(false);

    // The relay route's SMTP secret and the OAuth key are stored; readback masks them.
    expect(text).toContain('"****"');
    expect(text.includes(readFileSync(stack.adminApiKeyFile, "utf8").trim())).toBe(false);

    const rules = objects(file)["x:SpamRule"];
    const ruleIds = (await adminClient(stack).one("x:SpamRule/query", {}))["ids"];

    expect(isArray(ruleIds)).toBe(true);
    expect(Object.keys(isRecord(rules) ? rules : {})).toHaveLength(
      isArray(ruleIds) ? ruleIds.length : -1,
    );
  });

  it("gives the same configuration twice, and shows one changed setting as that difference", async () => {
    const first = await exportTo("first.json");
    const second = await exportTo("second.json");

    expect(stable(second.file)).toBe(stable(first.file));

    const before = await pyzor();
    const current = before["blockCount"];

    if (!isNumber(current)) throw new Error("x:SpamPyzor has no blockCount");

    pyzorBlockCount = current;
    await adminClient(stack).set("x:SpamPyzor", {
      update: { singleton: { blockCount: current === 1000 ? 999 : current + 1 } },
    });

    const changed = await exportTo("changed.json");

    const changedTypes = Object.keys(objects(first.file)).filter(
      (type) =>
        !SHARED.has(type) &&
        JSON.stringify(objects(first.file)[type]) !== JSON.stringify(objects(changed.file)[type]),
    );

    const after = pyzorOf(changed.file);

    expect(changedTypes).toEqual(["x:SpamPyzor"]);
    expect(after["blockCount"]).not.toBe(current);
    expect({ ...after, blockCount: current }).toEqual(pyzorOf(first.file));

    await adminClient(stack).set("x:SpamPyzor", {
      update: { singleton: { blockCount: current } },
    });
    pyzorBlockCount = undefined;

    const restored = await exportTo("restored.json");

    expect(stable(restored.file)).toBe(stable(first.file));
  });

  it("refuses to replace an existing export", async () => {
    await exportTo("once.json");

    const again = await runCli([
      "config",
      "export",
      "--config",
      config,
      "--out",
      join(dir ?? "", "once.json"),
    ]);

    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already exists; refusing to replace it/u);
  });
});

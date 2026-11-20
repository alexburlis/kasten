// kasten config export: every server configuration object that Stalwart's admin API reads back,
// as canonical JSON with sorted keys and one property per line, so that `diff` of two exports
// shows exactly which setting changed. The types come from the running release's own schema, so a
// type that a new release adds is exported too. A setting that is not stored reads back as the
// release's built-in default, so a default that a new release changes shows up as well; the
// complete-store export cannot show that. Stalwart masks every secret as "****" in readback.
import { CliError } from "./errors.ts";
import { writeSecretFile } from "./files.ts";
import { isArray, isRecord, isString } from "./json.ts";

import type { AdminClient, MethodCall } from "./jmap-admin.ts";
import type { Json, JsonRecord } from "./json.ts";
import type { Output } from "./setup/setup.ts";

const FORMAT = "kasten-config-export/1";

/**
 * Schema types that hold no server configuration: account credentials and per-account data (the
 * key set has its own check), received and generated reports, the queue, tasks, automatic IP bans,
 * logs and telemetry, and the first-boot and action endpoints. Every other x:* type is exported.
 */
export const NOT_CONFIGURATION: ReadonlySet<string> = new Set([
  "x:AccountPassword",
  "x:AccountSettings",
  "x:Action",
  "x:ApiKey",
  "x:AppPassword",
  "x:ArchivedItem",
  "x:ArfExternalReport",
  "x:BlockedIp",
  "x:Bootstrap",
  "x:ClusterNode",
  "x:DmarcExternalReport",
  "x:DmarcInternalReport",
  "x:IndexQueueStatus",
  "x:Log",
  "x:MaskedEmail",
  "x:Metric",
  "x:OAuthGrant",
  "x:PublicKey",
  "x:QueuedMessage",
  "x:SpamTrainingSample",
  "x:Task",
  "x:TlsExternalReport",
  "x:TlsInternalReport",
  "x:Trace",
]);

/** Server-computed usage counters, which change with every message. */
const USAGE_COUNTERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["x:Account", ["usedDiskQuota"]],
  ["x:Tenant", ["usedDiskQuota"]],
]);

/** Stalwart's maxObjectsInGet is 500; /query pages use the same size. */
const PAGE = 500;

interface ConfigTypes {
  readonly singletons: readonly string[];
  readonly collections: readonly string[];
  readonly skipped: readonly string[];
}

function configTypes(schema: JsonRecord): ConfigTypes {
  const objects = schema["objects"];

  if (!isRecord(objects)) throw new CliError("the server's schema has no object list");

  const singletons: string[] = [];
  const collections: string[] = [];
  const skipped: string[] = [];

  for (const [name, entry] of Object.entries(objects)) {
    if (!name.startsWith("x:")) continue;

    const kind = isRecord(entry) ? entry["type"] : undefined;

    if (kind === "view") continue;

    if (kind !== "singleton" && kind !== "object") {
      const shown = isString(kind) ? kind : JSON.stringify(kind ?? null);

      throw new CliError(
        `the server's schema: ${name} has the unknown object kind ${shown}, which this kasten version cannot export`,
      );
    }

    if (NOT_CONFIGURATION.has(name)) skipped.push(name);
    else if (kind === "singleton") singletons.push(name);
    else collections.push(name);
  }

  if (singletons.length + collections.length === 0)
    throw new CliError("the server's schema lists no x:* configuration types");

  return {
    singletons: singletons.sort(),
    collections: collections.sort(),
    skipped: skipped.sort(),
  };
}

/** Runs the calls, 16 to a request, and returns each method's arguments. Any error throws. */
async function answers(client: AdminClient, calls: readonly MethodCall[]): Promise<JsonRecord[]> {
  const responses = await client.call(calls);

  return responses.map(([name, args], index) => {
    const method = calls[index]?.[0] ?? "";

    if (name === "error") {
      const type = isString(args["type"]) ? args["type"] : "an unknown error";
      const detail = isString(args["description"]) ? `: ${args["description"]}` : "";

      throw new CliError(`${method} failed with ${type}${detail}`);
    }

    if (name !== method) throw new CliError(`${method} was answered with ${name}`);

    return args;
  });
}

function changed(type: string): CliError {
  return new CliError(`${type} changed while exporting; run the export again`);
}

/** Every id of each collection type: all first pages in one go, then the next pages. */
async function collectionIds(
  client: AdminClient,
  types: readonly string[],
): Promise<Map<string, string[]>> {
  const ids = new Map<string, string[]>(types.map((type) => [type, []]));
  let pending = [...types];

  while (pending.length > 0) {
    const calls = pending.map((type, index): MethodCall => [
      `${type}/query`,
      { position: ids.get(type)?.length ?? 0, limit: PAGE },
      String(index),
    ]);

    const results = await answers(client, calls);
    const next: string[] = [];

    for (const [index, result] of results.entries()) {
      const type = pending[index] ?? "";
      const page = result["ids"];
      const list = ids.get(type) ?? [];

      if (!isArray(page) || !page.every(isString))
        throw new CliError(`${type}/query returned no id list`);

      list.push(...page);

      if (page.length === PAGE) next.push(type);
    }

    pending = next;
  }

  for (const [type, list] of ids) if (new Set(list).size !== list.length) throw changed(type);

  return ids;
}

function withoutCounters(type: string, item: JsonRecord): JsonRecord {
  const counters = USAGE_COUNTERS.get(type) ?? [];

  return Object.fromEntries(Object.entries(item).filter(([key]) => !counters.includes(key)));
}

/** Reads the objects of every type, singletons by their fixed id. Throws on any gap. */
async function readObjects(
  client: AdminClient,
  types: ConfigTypes,
): Promise<Map<string, Map<string, JsonRecord>>> {
  const ids = await collectionIds(client, types.collections);

  const wanted: [string, readonly string[]][] = types.singletons.map((type) => [
    type,
    ["singleton"],
  ]);

  for (const [type, list] of ids) {
    for (let start = 0; start < list.length; start += PAGE)
      wanted.push([type, list.slice(start, start + PAGE)]);
  }

  const results = await answers(
    client,
    wanted.map(([type, list], index): MethodCall => [
      `${type}/get`,
      { ids: [...list] },
      String(index),
    ]),
  );

  const objects = new Map<string, Map<string, JsonRecord>>(
    [...types.singletons, ...types.collections].map((type) => [type, new Map()]),
  );

  for (const [index, result] of results.entries()) {
    const [type, requested] = wanted[index] ?? ["", []];
    const list = result["list"];
    const notFound = result["notFound"];
    const found = objects.get(type) ?? new Map<string, JsonRecord>();

    if (!isArray(list)) throw new CliError(`${type}/get returned no object list`);

    if (isArray(notFound) && notFound.length > 0) throw changed(type);

    for (const item of list) {
      const id = isRecord(item) ? item["id"] : undefined;

      if (!isRecord(item) || !isString(id) || !requested.includes(id))
        throw new CliError(`${type}/get returned an object that was not asked for`);

      found.set(id, withoutCounters(type, item));
    }

    if (!requested.every((id) => found.has(id))) throw changed(type);
  }

  return objects;
}

/** Stalwart masks secrets in readback only while x:SystemSettings.includeSecrets is false. */
function assertMasked(objects: ReadonlyMap<string, ReadonlyMap<string, JsonRecord>>): void {
  const settings = objects.get("x:SystemSettings")?.get("singleton");

  if (settings?.["includeSecrets"] !== false) {
    throw new CliError(
      "x:SystemSettings.includeSecrets is not false, so Stalwart's readback can hold unmasked secrets; no export was written",
    );
  }
}

/** Sorts object keys at every depth, so equal configurations give equal bytes. */
function canonical(value: Json): Json {
  if (isArray(value)) return value.map(canonical);

  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key] ?? null)]),
  );
}

/** Writes the export to a new file with mode 0600. */
export async function configExport(
  client: AdminClient,
  out: string,
  output: Output,
): Promise<void> {
  const { hash, schema } = await client.schema();
  const types = configTypes(schema);
  const objects = await readObjects(client, types);

  assertMasked(objects);

  const count = [...objects.values()].reduce((total, found) => total + found.size, 0);

  const body: JsonRecord = Object.fromEntries(
    [...objects].map(([type, found]) => [type, Object.fromEntries(found)]),
  );

  const text = JSON.stringify(
    canonical({
      format: FORMAT,
      schema: hash,
      notConfiguration: [...types.skipped],
      objects: body,
    }),
    null,
    2,
  );

  writeSecretFile(out, text);
  output.line(
    `exported ${count} objects of ${objects.size} configuration types to ${out} (mode 0600; Stalwart masks secrets as ****)`,
  );
}

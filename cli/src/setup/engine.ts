import { CliError } from "../errors.ts";
import { isRecord, isString, jsonEqual } from "../json.ts";

import type { AdminClient } from "../jmap-admin.ts";
import type { JsonRecord } from "../json.ts";

/** Picks the objects a spec is about from all objects of its type. */
export type Finder = (items: readonly JsonRecord[]) => readonly JsonRecord[];

/** One piece of desired server state. Only the listed properties are compared and written. */
export type Spec = SingletonSpec | ItemSpec | EverySpec | AbsentSpec;

interface SpecBase {
  /** The management object, such as "x:Email". */
  readonly object: string;
  /** What setup prints, such as "x:MtaRoute ses". */
  readonly label: string;
  /** The account that owns the objects; null for server-wide objects. */
  readonly accountId: string | null;
  /** Stalwart applies a change to this object only after a restart. */
  readonly restart: boolean;
}

export interface SingletonSpec extends SpecBase {
  readonly kind: "singleton";
  readonly desired: JsonRecord;
}

/** Exactly one matching object must exist with these properties. */
export interface ItemSpec extends SpecBase {
  readonly kind: "item";
  readonly find: Finder;
  readonly desired: JsonRecord;
  /** Sent together with `desired` on create; null means the object must already exist. */
  readonly createExtra: JsonRecord | null;
  /** Sent with every update, for example a secret that the readback masks. */
  readonly updateExtra: JsonRecord;
  /** Why the object cannot be created, when `createExtra` is null. */
  readonly missingHint: string;
}

/** Every matching object, possibly none, must have these properties. */
export interface EverySpec extends SpecBase {
  readonly kind: "every";
  readonly find: Finder;
  readonly desired: JsonRecord;
}

/** No matching object may exist. */
export interface AbsentSpec extends SpecBase {
  readonly kind: "absent";
  readonly find: Finder;
}

/** What setup did, or would do, for one spec. */
export interface Outcome {
  readonly label: string;
  readonly action: "ok" | "created" | "updated" | "destroyed";
  /** Names of changed properties. Values are never printed, so secrets stay out of the output. */
  readonly properties: readonly string[];
}

interface Step {
  readonly spec: Spec;
  readonly action: "create" | "update" | "destroy";
  readonly id: string | null;
  readonly properties: readonly string[];
  readonly payload: JsonRecord;
}

const SINGLETON = "singleton";

function idOf(item: JsonRecord): string {
  const id = item["id"];

  if (!isString(id)) throw new CliError("the server returned an object without an id");

  return id;
}

/** Properties of `desired` whose value differs from `actual`. */
export function changedProperties(desired: JsonRecord, actual: JsonRecord): string[] {
  return Object.keys(desired).filter((key) => !jsonEqual(desired[key], actual[key]));
}

function pick(record: JsonRecord, keys: readonly string[]): JsonRecord {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = record[key];

      return value === undefined ? [] : [[key, value]];
    }),
  );
}

/** Reads the current objects for every spec, sharing one /get per object type and account. */
async function readState(
  client: AdminClient,
  specs: readonly Spec[],
): Promise<Map<string, JsonRecord[]>> {
  const keys = new Map<string, Spec>();

  for (const spec of specs) keys.set(`${spec.object}|${spec.accountId ?? ""}`, spec);

  const state = new Map<string, JsonRecord[]>();
  const entries = [...keys.entries()];

  const responses = await client.call(
    entries.map(([, spec], index) => {
      const ids = spec.kind === "singleton" ? [SINGLETON] : null;
      const args = spec.accountId === null ? { ids } : { ids, accountId: spec.accountId };

      return [`${spec.object}/get`, args, String(index)] as const;
    }),
  );

  responses.forEach(([name, result], index) => {
    const entry = entries[index];

    if (entry === undefined) return;

    if (name === "error") {
      const type = isString(result["type"]) ? result["type"] : "error";
      const description = isString(result["description"]) ? `: ${result["description"]}` : "";
      throw new CliError(`${entry[1].object}/get failed with ${type}${description}`);
    }

    const list = result["list"];
    state.set(entry[0], Array.isArray(list) ? list.filter(isRecord) : []);
  });

  return state;
}

/** Works out the steps that bring the server to the desired state. */
export function plan(
  specs: readonly Spec[],
  state: ReadonlyMap<string, readonly JsonRecord[]>,
): Step[] {
  const steps: Step[] = [];

  for (const spec of specs) {
    const items = state.get(`${spec.object}|${spec.accountId ?? ""}`) ?? [];

    if (spec.kind === "singleton") {
      const actual = items[0];

      if (actual === undefined) throw new CliError(`${spec.label}: the server has no singleton`);

      const properties = changedProperties(spec.desired, actual);

      if (properties.length > 0) {
        steps.push({
          spec,
          action: "update",
          id: SINGLETON,
          properties,
          payload: pick(spec.desired, properties),
        });
      }

      continue;
    }

    const matches = spec.find(items);

    if (spec.kind === "absent") {
      for (const item of matches)
        steps.push({ spec, action: "destroy", id: idOf(item), properties: [], payload: {} });
      continue;
    }

    if (spec.kind === "every") {
      for (const item of matches) {
        const properties = changedProperties(spec.desired, item);

        if (properties.length > 0) {
          steps.push({
            spec,
            action: "update",
            id: idOf(item),
            properties,
            payload: pick(spec.desired, properties),
          });
        }
      }

      continue;
    }

    if (matches.length > 1)
      throw new CliError(`${spec.label}: ${matches.length} objects match; expected one`);

    const [existing] = matches;

    if (existing === undefined) {
      if (spec.createExtra === null)
        throw new CliError(`${spec.label} does not exist. ${spec.missingHint}`);

      steps.push({
        spec,
        action: "create",
        id: null,
        properties: Object.keys(spec.desired),
        payload: { ...spec.createExtra, ...spec.desired },
      });
      continue;
    }

    const properties = changedProperties(spec.desired, existing);

    if (properties.length > 0) {
      steps.push({
        spec,
        action: "update",
        id: idOf(existing),
        properties,
        payload: { ...pick(spec.desired, properties), ...spec.updateExtra },
      });
    }
  }

  return steps;
}

async function apply(client: AdminClient, step: Step): Promise<string | null> {
  const { spec } = step;

  if (step.action === "create") {
    const result = await client.set(spec.object, { create: { new: step.payload } }, spec.accountId);
    const created = result.created["new"];

    return created === undefined ? null : idOf(created);
  }

  if (step.action === "update" && step.id !== null) {
    await client.set(spec.object, { update: { [step.id]: step.payload } }, spec.accountId);

    return step.id;
  }

  if (step.id !== null) await client.set(spec.object, { destroy: [step.id] }, spec.accountId);

  return step.id;
}

export interface RunResult {
  readonly outcomes: readonly Outcome[];
  /** Ids of objects created in this run, by spec label. */
  readonly createdIds: ReadonlyMap<string, string>;
}

/**
 * Brings the server to the desired state, then reads it back. Any difference left after
 * applying is an error: setup never reports success on a partial configuration.
 *
 * Before the first write, `onRestart` gets the labels of the restart-only objects that the run is
 * about to change, so that a run that fails after its writes still knows that a restart is due.
 */
export async function run(
  client: AdminClient,
  specs: readonly Spec[],
  onRestart?: (labels: readonly string[]) => void,
): Promise<RunResult> {
  const before = await readState(client, specs);
  const steps = plan(specs, before);
  const createdIds = new Map<string, string>();
  const restart = new Set(steps.flatMap((step) => (step.spec.restart ? [step.spec.label] : [])));

  if (restart.size > 0) onRestart?.([...restart]);

  for (const step of steps) {
    const id = await apply(client, step);

    if (step.action === "create" && id !== null) createdIds.set(step.spec.label, id);
  }

  const outcomes: Outcome[] = specs.map((spec) => {
    const own = steps.filter((step) => step.spec === spec);

    if (own.length === 0) return { label: spec.label, action: "ok", properties: [] };

    const action = own.some((s) => s.action === "create")
      ? "created"
      : own.some((s) => s.action === "destroy")
        ? "destroyed"
        : "updated";

    return {
      label: spec.label,
      action,
      properties: [...new Set(own.flatMap((s) => s.properties))],
    };
  });

  return { outcomes, createdIds };
}

/** Reads the server again and fails if anything still differs from the desired state. */
export async function verify(client: AdminClient, specs: readonly Spec[]): Promise<void> {
  const after = await readState(client, specs);
  const left = plan(specs, after);

  if (left.length > 0) {
    const lines = left.map((step) =>
      step.action === "update"
        ? `${step.spec.label}: ${step.properties.join(", ")} still differ`
        : `${step.spec.label}: still needs ${step.action}`,
    );

    throw new CliError(`readback mismatch after setup:\n  ${lines.join("\n  ")}`);
  }
}

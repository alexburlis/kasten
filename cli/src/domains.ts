import { checkHostname } from "./config.ts";
import { CliError } from "./errors.ts";
import { isRecord, isString } from "./json.ts";

import type { KastenConfig } from "./config.ts";
import type { AdminClient } from "./jmap-admin.ts";
import type { JsonRecord } from "./json.ts";
import type { Output } from "./setup/setup.ts";

/** The server objects that `kasten domain remove` reads. */
interface ServerState {
  readonly domains: readonly JsonRecord[];
  readonly accounts: readonly JsonRecord[];
  readonly lists: readonly JsonRecord[];
  readonly dkim: readonly JsonRecord[];
  readonly settings: JsonRecord | undefined;
}

async function readState(client: AdminClient): Promise<ServerState> {
  const [domains, accounts, lists, dkim, settings] = await Promise.all([
    client.get("x:Domain", null),
    client.get("x:Account", null),
    client.get("x:MailingList", null),
    client.get("x:DkimSignature", null),
    client.get("x:SystemSettings", ["singleton"]),
  ]);

  return { domains, accounts, lists, dkim, settings: settings[0] };
}

/** One kind of object in the domain, with a line for each item. */
interface Contents {
  readonly object: string;
  readonly items: readonly { readonly id: string; readonly line: string }[];
}

/**
 * The objects that name the domain in `domainId`, in destroy order. Stalwart v1.0.1 refuses to
 * destroy a domain while any of them remains (`objectIsLinked`). The DKIM keys are the ones
 * Stalwart generated for the domain itself.
 */
function contentsOf(state: ServerState, domainId: string, name: string): Contents[] {
  const inDomain = (item: JsonRecord): boolean => item["domainId"] === domainId;

  const describe = (
    object: string,
    items: readonly JsonRecord[],
    label: (item: JsonRecord) => string,
  ): Contents => ({
    object,
    items: items.filter(inDomain).flatMap((item) => {
      const id = item["id"];

      return isString(id) ? [{ id, line: `${object} ${label(item)} (id ${id})` }] : [];
    }),
  });

  return [
    describe("x:Account", state.accounts, (a) => `${String(a["name"])}@${name}`),
    describe("x:MailingList", state.lists, (l) => `${String(l["name"])}@${name}`),
    describe("x:DkimSignature", state.dkim, (k) => String(k["selector"])),
  ];
}

/** Why the domain cannot go yet: references from outside it, and admin accounts in it. */
function blockers(state: ServerState, domainId: string, name: string): string[] {
  const names = new Map<string, string>();

  for (const domain of state.domains) {
    if (isString(domain["id"]) && isString(domain["name"])) names.set(domain["id"], domain["name"]);
  }

  const problems: string[] = [];

  if (state.settings?.["defaultDomainId"] === domainId) {
    problems.push(
      "it is the server's default domain; kasten setup makes the first domain in kasten.json the default",
    );
  }

  for (const account of state.accounts) {
    const domain = account["domainId"];
    const email = `${String(account["name"])}@${isString(domain) ? (names.get(domain) ?? domain) : "?"}`;
    const roles = account["roles"];

    if (domain === domainId) {
      if (isRecord(roles) && roles["@type"] === "Admin")
        problems.push(`${email} holds the Admin role; Kasten never removes an admin account`);
      continue;
    }

    const aliases = account["aliases"];

    for (const alias of isRecord(aliases) ? Object.values(aliases) : []) {
      if (isRecord(alias) && alias["domainId"] === domainId) {
        problems.push(
          `${String(alias["name"])}@${name} is an alias of ${email}; kasten setup removes the aliases that kasten.json no longer lists`,
        );
      }
    }
  }

  return problems;
}

/**
 * `kasten domain remove`: removes a domain that kasten.json no longer lists from the server,
 * such as a pilot domain after the overlap. kasten setup never destroys a domain or an account.
 * Without `yes` it lists what it would destroy and changes nothing. With `yes` it destroys the
 * domain's accounts (with their mail), mailing lists and DKIM keys, then the domain, and reads
 * back that all of them are gone.
 */
export async function domainRemove(
  client: AdminClient,
  config: KastenConfig,
  name: string,
  yes: boolean,
  out: Output,
): Promise<void> {
  const problem = checkHostname(name);

  if (problem !== null) throw new CliError(`${name} ${problem}`);

  if (config.domains.some((domain) => domain.name === name)) {
    throw new CliError(
      `${name} is still in kasten.json; remove it and every address in it from domains, users, relays, probe and dns.sesDkimTokens, run kasten setup, then run this again`,
    );
  }

  const state = await readState(client);
  const domainId = state.domains.find((domain) => domain["name"] === name)?.["id"];

  if (!isString(domainId)) {
    out.line(`absent    x:Domain ${name}: not on the server`);

    return;
  }

  const problems = blockers(state, domainId, name);

  if (problems.length > 0) throw new CliError(`cannot remove ${name}: ${problems.join("; ")}`);

  const contents = contentsOf(state, domainId, name);

  for (const { object, items } of contents) {
    for (const item of items)
      out.line(`remove    ${item.line}${object === "x:Account" ? ", with all its mail" : ""}`);
  }

  out.line(`remove    x:Domain ${name} (id ${domainId})`);

  if (!yes) {
    const count = contents.reduce((sum, group) => sum + group.items.length, 1);

    out.line(
      `note      nothing changed; run it again with --yes to destroy these ${count} objects`,
    );

    return;
  }

  // The domain goes last: Stalwart refuses to destroy it while anything names it.
  for (const { object, items } of contents) {
    if (items.length === 0) continue;

    await client.set(object, { destroy: items.map((item) => item.id) });
    out.line(`destroyed ${object} (${items.length})`);
  }

  await client.set("x:Domain", { destroy: [domainId] });
  out.line(`destroyed x:Domain ${name}`);

  const after = await readState(client);
  const left = contentsOf(after, domainId, name).flatMap((group) => group.items.map((i) => i.line));

  if (after.domains.some((domain) => domain["id"] === domainId || domain["name"] === name))
    left.push(`x:Domain ${name} (id ${domainId})`);

  if (left.length > 0) throw new CliError(`readback: still on the server: ${left.join(", ")}`);

  out.line(`verified  x:Domain ${name} and everything in it are gone from the server`);
}

// Development-only Stalwart settings that `kasten setup` does not own. `./kasten dev up` applies
// them after setup, through the admin API key, idempotently and with readback. Production sets
// neither.
//   1. Mail from the tools network (only containers that ./kasten runs, such as `dev mail`) skips
//      the spam filter. Its .test senders have no DNS, so the filter would put all of it in Junk.
//      Mail to localhost:7425 and from every other address is still filtered.
// `kasten setup` itself adds the console log (x:Tracer stdout at info).
// usage: node dev/stack/dev-settings.ts <kasten.json> <tools network CIDR>
import { loadConfig } from "../../cli/src/config.ts";
import { AdminClient, apiKeyAuth, fetchTransport } from "../../cli/src/jmap-admin.ts";
import { jsonEqual } from "../../cli/src/json.ts";
import { expression, when } from "../../cli/src/setup/specs.ts";

const [configPath, toolsNetwork] = process.argv.slice(2);

if (configPath === undefined || toolsNetwork === undefined || !/^[0-9./]+$/u.test(toolsNetwork)) {
  process.stderr.write(
    "usage: node dev/stack/dev-settings.ts <kasten.json> <tools network CIDR>\n",
  );
  process.exit(2);
}

const config = loadConfig(configPath);

const admin = new AdminClient(
  fetchTransport,
  config.admin.apiUrl,
  apiKeyAuth(config.admin.apiKeyFile),
);

// Stalwart's default is `is_empty(authenticated_as)`: filter every unauthenticated session.
const spamFilter = expression(
  [when(`is_ip_in_cidr(remote_ip, '${toolsNetwork}')`, "false")],
  "is_empty(authenticated_as)",
);

let changed = 0;

const [stage] = await admin.get("x:MtaStageData", ["singleton"]);

if (jsonEqual(stage?.["enableSpamFilter"], spamFilter)) {
  process.stdout.write("ok        dev only: x:MtaStageData.enableSpamFilter\n");
} else {
  await admin.set("x:MtaStageData", { update: { singleton: { enableSpamFilter: spamFilter } } });
  process.stdout.write(
    `updated   dev only: x:MtaStageData.enableSpamFilter skips ${toolsNetwork} (the tools network)\n`,
  );
  changed += 1;
}

if (changed > 0) {
  for (const warning of await admin.reloadSettings())
    process.stdout.write(`warning   ${warning}\n`);
}

const [after] = await admin.get("x:MtaStageData", ["singleton"]);

if (!jsonEqual(after?.["enableSpamFilter"], spamFilter)) {
  process.stderr.write("dev-settings: the readback does not match\n");
  process.exit(1);
}

process.stdout.write("readback  dev-only settings match\n");

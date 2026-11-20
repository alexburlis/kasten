// (g) The admin API key works only from its allowed addresses, and the running server has no
// recovery admin. A fair test: the same key, the same listener and the same request, sent from a
// container on the "admin" network (allowed) and from one on the stack's default network, where
// the mail and outbox services talk (not allowed).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { adminClient, docker, loadStack, waitFor } from "./lib/stack.ts";

import type { DevStack } from "./lib/stack.ts";

const stack = loadStack();

// Reads the key on stdin, so it never appears in an argument or the environment.
const PROBE = `
  const key = require("node:fs").readFileSync(0, "utf8").trim();
  const os = require("node:os");
  const address = Object.values(os.networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal).address;
  fetch("http://mail:8080/jmap/", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], methodCalls: [["x:Domain/get", { ids: null }, "0"]] }),
  }).then(async (r) => {
    const body = await r.text();
    let method = null;
    try { method = JSON.parse(body).methodResponses[0][0]; } catch {}
    console.log(JSON.stringify({ address, status: r.status, method }));
  });
`;

interface ProbeResult {
  readonly address: string;
  readonly status: number;
  readonly method: string | null;
}

async function probeFrom(dev: DevStack, network: string): Promise<ProbeResult> {
  const result = await docker(
    dev,
    ["run", "--rm", "-i", "--network", network, "--entrypoint", "node", dev.cliImage, "-e", PROBE],
    readFileSync(dev.adminApiKeyFile, "utf8"),
  );

  if (result.code !== 0) throw new Error(`the probe container failed: ${result.stderr}`);

  const parsed: ProbeResult = JSON.parse(result.stdout);

  return parsed;
}

describe("the admin API key", () => {
  it("is accepted from the admin network and this machine, and refused from the default network", async () => {
    const admin = await probeFrom(stack, stack.adminNetwork);
    const mail = await probeFrom(stack, stack.defaultNetwork);
    // The subnets are 10.<KASTEN_DEV_NET>.80.0/24 and .81.0/28: 74 for the shared stack.
    const net = process.env["KASTEN_DEV_NET"] ?? "74";

    expect(admin.address.startsWith(`10.${net}.81.`)).toBe(true);
    expect([admin.status, admin.method]).toEqual([200, "x:Domain/get"]);

    expect(mail.address.startsWith(`10.${net}.80.`)).toBe(true);
    expect(stack.adminAllowedIps).not.toContain(mail.address);
    expect([mail.status, mail.method]).toEqual([403, null]);

    // From this machine, through 127.0.0.1:7481, Stalwart sees the default network's gateway.
    expect((await adminClient(stack).get("x:Domain", null)).length).toBeGreaterThan(0);
  });
});

/**
 * The variable names of tini, kasten-server, Unbound and Stalwart in a container. Stalwart gets
 * its port capability from a file capability, so the kernel marks it non-dumpable and only a
 * privileged reader may open its /proc/<pid>/environ; the exec is privileged for that read only.
 * The script keeps only names, so values never leave the container. A process that cannot be
 * found or read makes the script fail.
 */
async function environmentNames(
  dev: DevStack,
  container: string,
  processes: readonly string[],
): Promise<Map<string, string[]>> {
  const script = [
    "set -eu",
    `for name in ${processes.join(" ")}; do`,
    '  pid=$(for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = "$name" ] && echo "${p#/proc/}"; done | head -n 1)',
    '  [ -n "$pid" ] || { echo "no $name process" >&2; exit 1; }',
    '  echo "== $name"',
    "  tr '\\0' '\\n' < \"/proc/$pid/environ\" | cut -d= -f1 | sort -u",
    "done",
  ].join("\n");

  const result = await docker(dev, [
    "exec",
    "--privileged",
    "--user",
    "0",
    container,
    "sh",
    "-c",
    script,
  ]);

  if (result.code !== 0 || result.stderr !== "") {
    throw new Error(`reading the environment of ${container} failed: ${result.stderr}`);
  }

  const sections = new Map<string, string[]>();
  let current: string[] = [];

  for (const line of result.stdout.split("\n").filter(Boolean)) {
    if (line.startsWith("== ")) {
      current = [];
      sections.set(line.slice(3), current);
    } else {
      current.push(line);
    }
  }

  return sections;
}

function recoveryNames(variables: readonly string[] | undefined): string[] {
  return (variables ?? []).filter((variable) => variable.startsWith("STALWART_RECOVERY"));
}

describe("the running mail server", () => {
  it("has no STALWART_RECOVERY_* variable in tini, kasten-server, Unbound or Stalwart", async () => {
    const processes = ["tini", "kasten-server", "unbound", "stalwart"];
    const sections = await environmentNames(stack, stack.mailContainer, processes);

    expect([...sections.keys()]).toEqual(processes);

    // The listings really hold each process's variables...
    expect(sections.get("tini")).toContain("KASTEN_VOLUME_ID");
    expect(sections.get("stalwart")).toContain("STALWART_PUBLIC_URL");
    expect(sections.get("stalwart")).toContain("SSL_CERT_FILE");

    // ...and none of them is a recovery setting.
    for (const [name, variables] of sections) expect(recoveryNames(variables), name).toEqual([]);
  });

  it("control: the same check finds STALWART_RECOVERY_ADMIN in a recovery-mode container", async () => {
    const suffix = randomBytes(4).toString("hex");
    const volume = `kasten-it-recovery-${suffix}`;
    const container = `kasten-it-recovery-${suffix}`;

    try {
      const init = await docker(stack, [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${volume}:/var/lib/kasten`,
        stack.mailImage,
        "init",
      ]);

      const volumeId = /"volumeId":"([0-9a-f]{32})"/u.exec(init.stdout)?.[1];

      if (init.code !== 0 || volumeId === undefined) throw new Error(`init failed: ${init.stderr}`);

      const started = await docker(stack, [
        "run",
        "-d",
        "--name",
        container,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_BIND_SERVICE",
        "-e",
        `KASTEN_VOLUME_ID=${volumeId}`,
        "-v",
        `${volume}:/var/lib/kasten`,
        stack.mailImage,
        "recovery",
      ]);

      if (started.code !== 0) throw new Error(`recovery did not start: ${started.stderr}`);

      const sections = await waitFor("Stalwart in recovery mode", 30_000, async () => {
        try {
          return await environmentNames(stack, container, ["stalwart"]);
        } catch {
          return null;
        }
      });

      expect(recoveryNames(sections.get("stalwart"))).toContain("STALWART_RECOVERY_ADMIN");
    } finally {
      await docker(stack, ["rm", "-f", container]);
      await docker(stack, ["volume", "rm", "-f", volume]);
    }
  });
});

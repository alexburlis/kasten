// (h) The fail-closed start: `kasten-server serve` against a volume that is not the dev stack's
// exits with code 3 and creates no database. Each case uses its own throwaway Docker volume.
import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { docker, loadStack } from "./lib/stack.ts";

const stack = loadStack();

const volumes: string[] = [];

async function newVolume(): Promise<string> {
  const name = `kasten-it-failclosed-${randomBytes(4).toString("hex")}`;
  const result = await docker(stack, ["volume", "create", name]);

  if (result.code !== 0) throw new Error(`docker volume create failed: ${result.stderr}`);

  volumes.push(name);

  return name;
}

function serve(volume: string, volumeId: string | null): Promise<{ code: number; stderr: string }> {
  return docker(stack, [
    "run",
    "--rm",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_BIND_SERVICE",
    ...(volumeId === null ? [] : ["-e", `KASTEN_VOLUME_ID=${volumeId}`]),
    "-v",
    `${volume}:/var/lib/kasten`,
    stack.mailImage,
    "serve",
  ]);
}

/** Every path in the volume with its size, so a later listing shows any change. */
async function listing(volume: string): Promise<string[]> {
  const result = await docker(stack, [
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "find",
    "-v",
    `${volume}:/var/lib/kasten`,
    stack.mailImage,
    "/var/lib/kasten",
    "-mindepth",
    "1",
    "-printf",
    "%P %s %T@\\n",
  ]);

  if (result.code !== 0) throw new Error(`listing the volume failed: ${result.stderr}`);

  return result.stdout.split("\n").filter(Boolean).sort();
}

describe("fail-closed start", () => {
  afterAll(async () => {
    for (const volume of volumes) await docker(stack, ["volume", "rm", "-f", volume]);
  });

  it("refuses an empty volume, with or without the expected id, and writes nothing", async () => {
    const volume = await newVolume();

    const withId = await serve(volume, stack.volumeId);

    expect(withId.code).toBe(3);
    expect(withId.stderr).toContain("has no Kasten marker");

    const withoutId = await serve(volume, null);

    expect(withoutId.code).toBe(3);
    expect(await listing(volume)).toEqual([]);
  });

  it("refuses another Kasten volume and creates no database in it", async () => {
    const volume = await newVolume();

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

    expect(init.code).toBe(0);

    const before = await listing(volume);
    const result = await serve(volume, stack.volumeId);

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Refusing to use a different volume");

    const after = await listing(volume);

    expect(after).toEqual(before);
    expect(after.some((line) => line.startsWith("stalwart/stalwart.sqlite"))).toBe(false);
  });
});

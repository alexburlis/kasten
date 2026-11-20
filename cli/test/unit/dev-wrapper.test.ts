// The repository's ./kasten wrapper adds --config /kasten-dev/kasten.json to the dev commands
// that take one. Its list must hold every command whose usage takes --config <file>, and
// dev/README.md must name the same list.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/main.ts";

/** The dev/README.md sentence that lists the commands the wrapper adds --config to. */
const README_LIST =
  /^For these CLI commands, the wrapper adds `--config \/kasten-dev\/kasten\.json` unless you give one: (?<list>.*)\.$/mu;

function repositoryFile(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

/** The commands in the wrapper's run_cli case that adds --config. */
function wrapperCommands(): string[] {
  const wrapper = repositoryFile("kasten");
  const body = /^run_cli\(\) \{\n(?<body>[\s\S]*?)\n\}$/mu.exec(wrapper)?.groups?.["body"] ?? "";
  const pattern = /^\s+(?<list>[a-z-]+(?: \| [a-z-]+)*)\)\n\s+has_config=false$/mu.exec(body);

  return (pattern?.groups?.["list"] ?? "").split(" | ").filter((name) => name !== "");
}

/** The commands whose `kasten help` entry takes --config <file>. */
async function configCommands(): Promise<string[]> {
  let usage = "";

  vi.spyOn(process.stdout, "write").mockImplementation((text) => {
    usage += String(text);

    return true;
  });

  expect(await main(["help"])).toBe(0);

  // An entry starts two spaces in; its continuation and description lines are indented more.
  const entries = usage.split(/\n(?= {2}[a-z])/u).filter((entry) => /^ {2}[a-z]/u.test(entry));

  return [
    ...new Set(
      entries
        .filter((entry) => entry.includes("--config <file>"))
        .map((entry) => entry.trim().split(" ")[0] ?? ""),
    ),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ./kasten dev wrapper", () => {
  it("adds --config to every command whose usage takes one", async () => {
    const commands = await configCommands();

    expect(commands).toContain("setup");
    expect(wrapperCommands()).toEqual(expect.arrayContaining(commands));
  });

  it("is described by the same list in dev/README.md", () => {
    const sentence = README_LIST.exec(repositoryFile("dev/README.md"))?.groups?.["list"] ?? "";

    const listed = [...sentence.matchAll(/`(?<name>[a-z-]+)`/gu)].map(
      (match) => match.groups?.["name"] ?? "",
    );

    expect(wrapperCommands().length).toBeGreaterThan(0);
    expect(listed.toSorted()).toEqual(wrapperCommands().toSorted());
  });
});

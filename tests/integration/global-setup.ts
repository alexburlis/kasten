// Runs once before the integration tests. It fails, with the reason, unless the dev stack is up:
// state.json exists, Stalwart answers, its container is healthy, the outbox answers and the admin
// key works. The tests never skip, so a missing stack can never look like a pass.
import { adminClient, docker, loadStack } from "./lib/stack.ts";

/** The HTTP status, waiting out Stalwart's rate limit (429) after an earlier run, as rate-limit.ts does. */
async function status(url: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    let code: string;

    try {
      code = String((await fetch(url, { signal: AbortSignal.timeout(5000) })).status);
    } catch (cause) {
      return cause instanceof Error ? cause.message : "unreachable";
    }

    if (code !== "429" || attempt === 6) return code;

    console.warn(`HTTP 429 from ${new URL(url).pathname}; Stalwart's rate limit, retrying in 15 s`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

export default async function setup(): Promise<void> {
  const stack = loadStack();
  const problems: string[] = [];

  const live = await status(`${stack.apiUrl}/healthz/live`);

  if (live !== "200") problems.push(`${stack.apiUrl}/healthz/live answered ${live}, not 200`);

  const outbox = await status(`${stack.outboxApiUrl}/info`);

  if (outbox !== "200")
    problems.push(`the outbox API ${stack.outboxApiUrl}/info answered ${outbox}`);

  const health = await docker(stack, [
    "inspect",
    "-f",
    "{{.State.Health.Status}}",
    stack.mailContainer,
  ]);

  if (health.code !== 0 || health.stdout.trim() !== "healthy") {
    problems.push(
      `the container ${stack.mailContainer} is not healthy (${health.stdout.trim() || health.stderr.trim()})`,
    );
  }

  if (problems.length === 0) {
    try {
      await adminClient(stack).get("x:Domain", null);
    } catch (cause) {
      problems.push(
        `the admin API key does not work: ${cause instanceof Error ? cause.message : ""}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `The Kasten dev stack is not up, so the integration tests cannot run:\n  - ${problems.join("\n  - ")}\nStart it with ./kasten dev up.`,
    );
  }
}

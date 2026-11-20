// Runs once before the live tests and fails, with the reason, unless the dev stack is up:
// state.json exists, Stalwart answers on HTTP, SMTP and IMAP, the outbox answers, and the admin
// key works. No test skips, so a missing stack never looks like a pass.
import { connect } from "node:net";

import { adminCall, loadStack } from "./support/stack.ts";

async function httpStatus(url: string): Promise<string> {
  try {
    return String((await fetch(url, { signal: AbortSignal.timeout(5000) })).status);
  } catch (cause) {
    return cause instanceof Error ? cause.message : "unreachable";
  }
}

/** The first line a TCP service sends, or the reason there was none. */
function greeting(host: string, port: number): Promise<string> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    socket.setTimeout(5000, () => {
      socket.destroy();
      done("no greeting within 5 s");
    });
    socket.once("data", (chunk: Buffer) => {
      socket.end();
      socket.destroy();
      done(chunk.toString("latin1").split("\r\n")[0] ?? "");
    });
    socket.once("error", (error) => done(error.message));
  });
}

export default async function setup(): Promise<void> {
  const stack = loadStack();
  const problems: string[] = [];

  const live = await httpStatus(`${stack.apiUrl}/healthz/live`);

  if (live !== "200") problems.push(`${stack.apiUrl}/healthz/live answered ${live}, not 200`);

  const outbox = await httpStatus(`${stack.outboxApiUrl}/info`);

  if (outbox !== "200")
    problems.push(`the outbox API ${stack.outboxApiUrl}/info answered ${outbox}`);

  const smtp = await greeting(stack.smtpHost, stack.smtpPort);

  if (!smtp.startsWith("220"))
    problems.push(`SMTP ${stack.smtpHost}:${stack.smtpPort} said: ${smtp}`);

  const imap = await greeting(stack.imapHost, stack.imapPort);

  if (!imap.startsWith("* OK"))
    problems.push(`IMAP ${stack.imapHost}:${stack.imapPort} said: ${imap}`);

  if (problems.length === 0) {
    try {
      await adminCall(stack, [["x:Domain/get", { ids: null, properties: ["id"] }, "0"]]);
    } catch (cause) {
      problems.push(
        `the admin API key does not work: ${cause instanceof Error ? cause.message : ""}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `The Kasten dev stack is not up, so the live tests cannot run:\n  - ${problems.join("\n  - ")}\nStart it with ./kasten dev up.`,
    );
  }
}

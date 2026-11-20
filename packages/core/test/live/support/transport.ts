// An HTTP transport for @kasten/core's JMAP client that records what it sends and can stage
// failures: a lost answer (the server ran the request, the client never hears back) or a crash
// (the request never returns). This is dependency injection through JmapClientOptions.transport.
import { z } from "zod";

import { jsonValue, type JsonValue } from "../../../src/json.ts";
import { JmapClient, type HttpTransport } from "../../../src/jmap/index.ts";
import type { MailAccount } from "../../../src/mail/index.ts";
import { basicHeader, type DevStack, type TestAccount } from "./stack.ts";

/** One request the transport saw. */
export interface SeenRequest {
  readonly url: string;
  readonly method: string;
  /** The JMAP method names of an API request; empty for uploads and downloads. */
  readonly methods: readonly string[];
  readonly body: Uint8Array;
  readonly json: JsonValue | null;
  readonly isUpload: boolean;
}

/**
 * What to do with a request. `loseAnswer` lets the server run it, then fails like a broken
 * connection; `hang` never sends it; `runThenHang` lets the server run it and never answers, like
 * a process that stopped.
 */
export type Fault = "pass" | "loseAnswer" | "hang" | "runThenHang";

const requestSchema = z.object({
  methodCalls: z.array(z.tuple([z.string(), jsonValue, z.string()])),
});

export class StagedTransport {
  readonly seen: SeenRequest[] = [];
  #rule: (request: SeenRequest) => Fault = () => "pass";

  /** Sets the rule for the requests that follow. */
  stage(rule: (request: SeenRequest) => Fault): void {
    this.#rule = rule;
  }

  readonly transport: HttpTransport = async (request) => {
    const body = new Uint8Array(await request.clone().arrayBuffer());
    const isUpload = new URL(request.url).pathname.includes("/upload/");
    let json: JsonValue | null = null;
    let methods: string[] = [];

    if (!isUpload && request.method === "POST" && body.length > 0) {
      json = jsonValue.parse(JSON.parse(new TextDecoder().decode(body)));

      const parsed = requestSchema.safeParse(json);

      if (parsed.success) methods = parsed.data.methodCalls.map((call) => call[0]);
    }

    const seen: SeenRequest = {
      url: request.url,
      method: request.method,
      methods,
      body,
      json,
      isUpload,
    };

    this.seen.push(seen);

    const fault = this.#rule(seen);

    if (fault === "hang") return new Promise<Response>(() => undefined);

    const response = await fetch(request);

    if (fault === "runThenHang") {
      await response.arrayBuffer();

      return new Promise<Response>(() => undefined);
    }

    if (fault === "loseAnswer") {
      await response.arrayBuffer();
      throw new TypeError("The connection broke before the answer arrived");
    }

    return response;
  };
}

/** The account's mail, through a client that uses `transport`. */
export function stagedAccount(
  stack: DevStack,
  account: TestAccount,
  transport: StagedTransport,
): MailAccount {
  return {
    accountId: account.mail.accountId,
    client: new JmapClient({
      sessionUrl: stack.sessionUrl,
      authorization: async () => basicHeader(account.email, account.password),
      transport: transport.transport,
    }),
  };
}

/** True when the request imports into `mailboxId`. */
export function importsInto(request: SeenRequest, mailboxId: string): boolean {
  return (
    request.methods.includes("Email/import") &&
    JSON.stringify(request.json).includes(`"${mailboxId}":true`)
  );
}

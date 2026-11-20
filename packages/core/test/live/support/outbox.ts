// The dev outbox (Mailpit), which stands in for SES: find what Stalwart relayed, read it raw, and
// delete it again so the shared outbox stays as the test found it.
import { z } from "zod";

const addressSchema = z.object({ Name: z.string(), Address: z.string() });

const summarySchema = z.object({
  ID: z.string(),
  MessageID: z.string(),
  To: z.array(addressSchema).nullable(),
  Cc: z.array(addressSchema).nullable(),
  Bcc: z.array(addressSchema).nullable(),
  Subject: z.string(),
});

/** One message as the Mailpit API lists it. */
export type OutboxSummary = z.infer<typeof summarySchema>;

const listSchema = z.object({ messages: z.array(summarySchema) });

export class Outbox {
  readonly #apiUrl: string;
  readonly #seen = new Set<string>();
  readonly #tracked = new Set<string>();

  constructor(apiUrl: string) {
    this.#apiUrl = apiUrl;
  }

  /** Every relayed message with this Message-ID (without angle brackets). */
  async find(messageId: string): Promise<OutboxSummary[]> {
    const url = new URL(`${this.#apiUrl}/search`);
    url.searchParams.set("query", `message-id:"${messageId}"`);
    url.searchParams.set("limit", "50");

    const response = await fetch(url);

    if (!response.ok) throw new Error(`The outbox search answered ${response.status}`);

    const found = listSchema
      .parse(await response.json())
      .messages.filter((item) => item.MessageID === messageId);

    for (const item of found) this.#seen.add(item.ID);

    return found;
  }

  async raw(id: string): Promise<Uint8Array> {
    const response = await fetch(`${this.#apiUrl}/message/${encodeURIComponent(id)}/raw`);

    if (!response.ok) throw new Error(`The outbox answered ${response.status} for message ${id}`);

    return new Uint8Array(await response.arrayBuffer());
  }

  /** Remembers a Message-ID, so {@link Outbox.cleanUp} removes its copies even after a failed test. */
  track(messageId: string): void {
    this.#tracked.add(messageId);
  }

  /** Deletes every message this instance found or was told to track. */
  async cleanUp(): Promise<void> {
    for (const messageId of this.#tracked) await this.find(messageId);

    if (this.#seen.size === 0) return;

    const response = await fetch(`${this.#apiUrl}/messages`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IDs: [...this.#seen] }),
    });

    if (!response.ok) throw new Error(`The outbox refused the clean-up: ${response.status}`);

    this.#seen.clear();
  }
}

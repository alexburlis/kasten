// The page's handle on the key worker. It also serves as the local store's record cipher.
import type { OutboxEntry } from "@kasten/core/mail";

import type { OpenRequest, RecordCipher, SealRequest } from "../store/local-store.ts";
import type { SealedRecord } from "../store/vault.ts";
import type {
  KeyWorkerMethod,
  PageMessage,
  ParamsOf,
  ResultOf,
  WorkerFailure,
  WorkerReply,
} from "./protocol.ts";

export class KeyWorkerError extends Error {
  readonly code: string;

  constructor(failure: WorkerFailure) {
    super(failure.message);
    this.name = "KeyWorkerError";
    this.code = failure.code;
  }
}

/** Saves an outbox entry the worker sent mid-call; see KeyWorkerApi.sendOutboxEntry. */
export type ProgressHandler = (entry: OutboxEntry) => Promise<void>;

interface Pending {
  readonly resolve: (result: ResultOf<KeyWorkerMethod>) => void;
  readonly reject: (error: KeyWorkerError) => void;
  readonly progress: ProgressHandler | null;
}

/** Something that can post to and terminate the worker; the browser Worker, or a fake in tests. */
export interface WorkerPort {
  postMessage(message: PageMessage, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export class KeyWorkerClient implements RecordCipher {
  readonly #port: WorkerPort;
  readonly #pending = new Map<number, Pending>();
  #next = 1;
  #dead = false;

  constructor(port: WorkerPort) {
    this.#port = port;
    port.onmessage = (event) => this.#answer(event.data);
    port.onerror = (event) => {
      event.preventDefault();
      this.#fail({ code: "crashed", message: "The key worker stopped" });
    };
  }

  /** Starts the worker that Vite bundles from key-worker.ts. */
  static start(): KeyWorkerClient {
    const worker = new Worker(new URL("./key-worker.ts", import.meta.url), {
      type: "module",
      name: "kasten-keys",
    });

    return new KeyWorkerClient(worker);
  }

  #answer(reply: WorkerReply): void {
    const pending = this.#pending.get(reply.id);

    if (pending === undefined) return;

    if ("progress" in reply) {
      const save = pending.progress;

      const ack = (ok: boolean): void => {
        if (!this.#dead) this.#port.postMessage({ ack: reply.progressId, ok }, []);
      };

      if (save === null) ack(false);
      else
        save(reply.progress).then(
          () => ack(true),
          () => ack(false),
        );

      return;
    }

    this.#pending.delete(reply.id);

    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new KeyWorkerError(reply.error));
  }

  #fail(failure: WorkerFailure): void {
    this.#dead = true;

    for (const pending of this.#pending.values()) pending.reject(new KeyWorkerError(failure));

    this.#pending.clear();
  }

  /**
   * Calls the worker. Byte arrays named in `transfer` move to the worker and
   * are empty here afterwards. `progress` saves the outbox entries a send reports mid-call.
   */
  call<M extends KeyWorkerMethod>(
    method: M,
    params: ParamsOf<M>,
    transfer: readonly ArrayBuffer[] = [],
    progress: ProgressHandler | null = null,
  ): Promise<ResultOf<M>> {
    if (this.#dead) {
      return Promise.reject(
        new KeyWorkerError({ code: "crashed", message: "The key worker stopped" }),
      );
    }

    const id = this.#next;

    this.#next += 1;

    return new Promise<ResultOf<M>>((resolve, reject) => {
      this.#pending.set(id, {
        // SAFETY: the worker answers request `id` with the result of `method`, which is ResultOf<M>.
        resolve: (result) => resolve(result as ResultOf<M>),
        reject,
        progress,
      });

      // SAFETY: `method` and `params` match by the type of call(); the union cannot express that link.
      const request = { id, method, params } as PageMessage;

      this.#port.postMessage(request, [...transfer]);
    });
  }

  seal(items: readonly SealRequest[]): Promise<SealedRecord[]> {
    return this.call(
      "sealRecords",
      { items },
      items.map((item) => item.plaintext.buffer),
    );
  }

  open(items: readonly OpenRequest[]): Promise<(Uint8Array<ArrayBuffer> | null)[]> {
    return this.call("openRecords", { items });
  }

  /** Ends the worker: the unlocked key and the data key go with it. */
  terminate(): void {
    this.#port.terminate();
    this.#fail({ code: "locked", message: "Kasten is locked" });
  }
}

// The key worker's entry point: one dedicated module worker per page. It answers the calls in
// protocol.ts and transfers the byte buffers it returns, so plaintext is not copied twice.
import "../lib/zod-config.ts";

import type { OutboxEntry } from "@kasten/core/mail";

import type { SealedRecord } from "../store/vault.ts";
import type {
  KeyWorkerMethod,
  PageMessage,
  ResultOf,
  WorkerReply,
  WorkerRequest,
} from "./protocol.ts";
import { createKeyService, KeyServiceError } from "./service.ts";

declare const self: DedicatedWorkerGlobalScope;

const service = createKeyService();

interface Answer {
  readonly result: ResultOf<KeyWorkerMethod>;
  readonly transfer: readonly ArrayBuffer[];
}

function sealedBuffers(records: readonly SealedRecord[]): ArrayBuffer[] {
  return records.flatMap((record) => [record.iv.buffer, record.data.buffer]);
}

function plain(result: ResultOf<KeyWorkerMethod>): Answer {
  return { result, transfer: [] };
}

/** Saves the page owes us for progress messages, by progress id. */
const waiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

let nextProgress = 1;

/** Asks the page to save an outbox entry and waits until it has. */
function persistThroughPage(callId: number, entry: OutboxEntry): Promise<void> {
  const progressId = nextProgress;

  nextProgress += 1;

  return new Promise((resolve, reject) => {
    waiting.set(progressId, { resolve, reject });

    const reply: WorkerReply = { id: callId, progressId, progress: entry };

    self.postMessage(reply);
  });
}

async function dispatch(request: WorkerRequest): Promise<Answer> {
  switch (request.method) {
    case "status":
      return plain(await service.status());
    case "createKey":
      return plain(await service.createKey(request.params));
    case "restoreKey":
      return plain(await service.restoreKey(request.params));
    case "unlock":
      return plain(await service.unlock(request.params));
    case "unlockWithDevice":
      return plain(await service.unlockWithDevice(request.params));
    case "unlockWithPasskey":
      return plain(await service.unlockWithPasskey(request.params));
    case "restoreWithPasskey":
      return plain(await service.restoreWithPasskey(request.params));
    case "sealPasskey":
      return plain(await service.sealPasskey(request.params));
    case "proveWithPasskey":
      return plain(await service.proveWithPasskey(request.params));
    case "provePassphrase":
      return plain(await service.provePassphrase(request.params));
    case "rememberUnlock":
      return plain(await service.rememberUnlock());
    case "lock":
      return plain(await service.lock());
    case "recoverySheet":
      return plain(await service.recoverySheet());
    case "escrowKey":
      return plain(await service.escrowKey());
    case "checkEscrow":
      return plain(await service.checkEscrow(request.params));
    case "restoreFromEscrow":
      return plain(await service.restoreFromEscrow(request.params));
    case "checkServerKey":
      return plain(await service.checkServerKey(request.params));
    case "setBundle":
      return plain(await service.setBundle(request.params));
    case "buildBundle":
      return plain(await service.buildBundle(request.params));
    case "decryptMessage": {
      const result = await service.decryptMessage(request.params);

      return { result, transfer: sealedBuffers([result.record]) };
    }

    case "readAttachment": {
      const result = await service.readAttachment(request.params);

      return { result, transfer: [result.content.buffer] };
    }

    case "readAttachments": {
      const result = await service.readAttachments(request.params);

      return { result, transfer: result.map((part) => part.content.buffer) };
    }

    case "encryptSentCopy": {
      const result = await service.encryptSentCopy(request.params);

      return { result, transfer: [result.buffer] };
    }

    case "prepareSend":
      return plain(await service.prepareSend(request.params));
    case "sendOutboxEntry":
      return plain(
        await service.sendOutboxEntry(request.params, (entry) =>
          persistThroughPage(request.id, entry),
        ),
      );
    case "sealRecords": {
      const result = await service.sealRecords(request.params);

      return { result, transfer: sealedBuffers(result) };
    }

    case "openRecords": {
      const result = await service.openRecords(request.params);

      return { result, transfer: result.flatMap((item) => (item === null ? [] : [item.buffer])) };
    }
  }
}

self.onmessage = (event: MessageEvent<PageMessage>) => {
  const message = event.data;

  if ("ack" in message) {
    const waiter = waiting.get(message.ack);

    waiting.delete(message.ack);

    if (message.ok) waiter?.resolve();
    else waiter?.reject(new KeyServiceError("persistFailed", "The outbox entry was not saved"));

    return;
  }

  const request = message;

  dispatch(request).then(
    (answer) => {
      const reply: WorkerReply = { id: request.id, ok: true, result: answer.result };

      self.postMessage(reply, [...answer.transfer]);
    },
    (cause: unknown) => {
      const error =
        cause instanceof KeyServiceError
          ? { code: cause.code, message: cause.message }
          : { code: "failed", message: cause instanceof Error ? cause.message : "Failed" };

      const reply: WorkerReply = { id: request.id, ok: false, error };

      self.postMessage(reply);
    },
  );
};

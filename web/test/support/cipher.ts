// The key worker's record cipher (worker/service.ts sealRecords and openRecords), run directly on
// a vault data key so store tests use real encryption without a worker.
import type { RecordCipher } from "../../src/store/local-store.ts";
import { KastenVaultError, openRecord, sealRecord } from "../../src/store/vault.ts";

export function vaultCipher(dataKey: CryptoKey): RecordCipher {
  return {
    seal: (items) =>
      Promise.all(items.map((item) => sealRecord(dataKey, item.slot, item.plaintext))),
    open: (items) =>
      Promise.all(
        items.map((item) =>
          openRecord(dataKey, item.slot, item.record).catch((cause: unknown) => {
            if (cause instanceof KastenVaultError) return null;

            throw cause;
          }),
        ),
      ),
  };
}

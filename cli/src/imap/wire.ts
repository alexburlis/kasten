// Bytes in and out of one IMAP connection. Reading pauses the socket while more than about a
// mebibyte is queued, so a large literal streams through without being held in memory.
import { ImapConnectionError, ImapProtocolError } from "./errors.ts";

import type { Duplex } from "node:stream";

const HIGH_WATER = 1024 * 1024;

const LOW_WATER = 256 * 1024;

const LF = 0x0a;

const CR = 0x0d;

export class Wire {
  readonly #stream: Duplex;
  readonly #idleMs: number;
  #chunks: Buffer[] = [];
  #queued = 0;
  #paused = false;
  #failure: Error | null = null;
  #wake: (() => void) | null = null;

  readonly #onData = (chunk: Buffer): void => {
    this.#chunks.push(chunk);
    this.#queued += chunk.length;

    if (this.#queued > HIGH_WATER && !this.#paused) {
      this.#paused = true;
      this.#stream.pause();
    }

    this.#wake?.();
  };

  readonly #onEnd = (): void => {
    this.#fail(new ImapConnectionError("the server closed the connection"));
  };

  readonly #onError = (cause: Error): void => {
    this.#fail(new ImapConnectionError(`connection failed: ${cause.message}`));
  };

  constructor(stream: Duplex, idleMs: number) {
    this.#stream = stream;
    this.#idleMs = idleMs;
    stream.on("data", this.#onData);
    stream.on("end", this.#onEnd);
    stream.on("close", this.#onEnd);
    stream.on("error", this.#onError);
  }

  /** True once the connection has failed or closed. */
  get closed(): boolean {
    return this.#failure !== null;
  }

  /**
   * Stops reading from the stream, for a STARTTLS upgrade. Bytes that arrived after the server's
   * STARTTLS reply would be unprotected plaintext, so their presence is an error.
   */
  detach(): Duplex {
    this.#stream.off("data", this.#onData);
    this.#stream.off("end", this.#onEnd);
    this.#stream.off("close", this.#onEnd);
    this.#stream.off("error", this.#onError);

    if (this.#paused) this.#stream.resume();

    if (this.#queued > 0)
      throw new ImapProtocolError("the server sent data after its STARTTLS reply");

    this.#failure = new ImapConnectionError("the connection was handed to TLS");

    return this.#stream;
  }

  /** Reads one line and returns it without its CRLF. */
  async readLine(maxLength: number): Promise<Buffer> {
    let scanned = 0;

    for (;;) {
      const end = this.#indexOfLineFeed(scanned);

      if (end !== -1) {
        const line = this.#take(end + 1);
        const stop = line.length >= 2 && line[line.length - 2] === CR ? 2 : 1;

        return line.subarray(0, line.length - stop);
      }

      scanned = this.#queued;

      if (scanned > maxLength)
        throw new ImapProtocolError(`a server line is longer than ${maxLength} bytes`);

      // A line longer than the high-water mark is still read whole, up to maxLength.
      if (this.#paused) {
        this.#paused = false;
        this.#stream.resume();
      }

      // Wait for more than the part of the line that is already here.
      await this.#waitForData(scanned + 1);
    }
  }

  /** Reads exactly `count` bytes into memory. Use only for small values. */
  async readBytes(count: number): Promise<Buffer> {
    const parts: Buffer[] = [];

    await this.pipeBytes(count, (chunk) => {
      parts.push(Buffer.from(chunk));

      return Promise.resolve();
    });

    return Buffer.concat(parts);
  }

  /** Passes exactly `count` bytes to `sink`, chunk by chunk, waiting for each write. */
  async pipeBytes(count: number, sink: (chunk: Buffer) => Promise<void>): Promise<void> {
    let remaining = count;

    while (remaining > 0) {
      if (this.#queued === 0) {
        await this.#waitForData(1);
        continue;
      }

      const chunk = this.#take(Math.min(remaining, this.#chunks[0]?.length ?? 0));

      remaining -= chunk.length;
      await sink(chunk);
    }
  }

  /** Writes bytes, waiting while the socket's buffer is full. */
  async write(data: Buffer | string): Promise<void> {
    if (this.#failure !== null) throw this.#failure;

    if (this.#stream.write(data)) return;

    await new Promise<void>((resolve, reject) => {
      const done = (error: Error | null): void => {
        clearTimeout(timer);
        this.#stream.off("drain", onDrain);
        this.#stream.off("close", onClose);

        if (error === null) resolve();
        else reject(error);
      };

      const onDrain = (): void => done(null);
      const onClose = (): void => done(new ImapConnectionError("the server closed the connection"));

      const timer = setTimeout(() => {
        const error = new ImapConnectionError(
          `the server stopped reading for ${this.#idleMs / 1000} s`,
        );

        this.#fail(error);
        done(error);
      }, this.#idleMs);

      this.#stream.on("drain", onDrain);
      this.#stream.on("close", onClose);
    });
  }

  /** Closes the connection at once. */
  destroy(): void {
    this.#fail(new ImapConnectionError("the connection was closed"));
  }

  #fail(error: Error): void {
    if (this.#failure === null) {
      this.#failure = error;
      this.#stream.destroy();
    }

    this.#wake?.();
  }

  #indexOfLineFeed(from: number): number {
    let base = 0;

    for (const chunk of this.#chunks) {
      if (from < base + chunk.length) {
        const index = chunk.indexOf(LF, Math.max(0, from - base));

        if (index !== -1) return base + index;
      }

      base += chunk.length;
    }

    return -1;
  }

  #take(count: number): Buffer {
    const parts: Buffer[] = [];
    let needed = count;

    while (needed > 0) {
      const chunk = this.#chunks[0];

      if (chunk === undefined) break;

      if (chunk.length <= needed) {
        parts.push(chunk);
        this.#chunks.shift();
        needed -= chunk.length;
      } else {
        parts.push(chunk.subarray(0, needed));
        this.#chunks[0] = chunk.subarray(needed);
        needed = 0;
      }
    }

    this.#queued -= count - needed;

    if (this.#paused && this.#queued < LOW_WATER) {
      this.#paused = false;
      this.#stream.resume();
    }

    return parts.length === 1 && parts[0] !== undefined ? parts[0] : Buffer.concat(parts);
  }

  /** Waits until at least `minimum` bytes are queued; throws when the connection fails first. */
  async #waitForData(minimum: number): Promise<void> {
    while (this.#queued < minimum) {
      if (this.#failure !== null) throw this.#failure;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#wake = null;

          const error = new ImapConnectionError(
            `the server sent nothing for ${this.#idleMs / 1000} s`,
          );

          this.#fail(error);
          reject(error);
        }, this.#idleMs);

        this.#wake = () => {
          clearTimeout(timer);
          this.#wake = null;
          resolve();
        };
      });
    }
  }
}

// Local canary servers for the hostile-mail tests: one over HTTP and one over HTTPS, both on
// 127.0.0.1 with ports the system picks. They answer every request with a 1×1 PNG and record every
// request and every TCP connection, so a request that Playwright's own events miss (a preconnect, a
// service-worker fetch) still shows. The HTTPS certificate is self-signed and made for this run
// only; the test's browser context ignores certificate errors so that remote images can load
// after "Show".
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { CanaryKind, CanaryOrigins } from "./hostile-corpus.ts";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export interface CanaryHit {
  readonly scheme: "http" | "https";
  readonly method: string;
  readonly path: string;
  /** The first path segment, such as "img" or "script". */
  readonly kind: CanaryKind | "other";
}

const KINDS: ReadonlyMap<string, CanaryKind> = new Map(
  (["script", "img", "style", "font", "frame", "nav", "form", "media", "prefetch"] as const).map(
    (kind) => [kind, kind],
  ),
);

const listening = z.object({ port: z.number().int().positive() });

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const parsed = listening.safeParse(server.address());

      if (parsed.success) resolve(parsed.data.port);
      else reject(new Error("The canary server has no port"));
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** A TLS key and certificate in PEM form. */
interface TlsIdentity {
  readonly key: Buffer;
  readonly cert: Buffer;
}

/** A throwaway key and certificate for 127.0.0.1, made with openssl in a private folder. */
function selfSignedCertificate(): TlsIdentity {
  const dir = mkdtempSync(join(tmpdir(), "kasten-canary-"));

  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        // RSA: LibreSSL writes EC keys with explicit curve parameters, which browsers refuse.
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-subj",
        "/CN=127.0.0.1",
        "-days",
        "1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );

    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class Canary {
  readonly hits: CanaryHit[] = [];
  readonly connections = { http: 0, https: 0 };
  readonly #http: Server;
  readonly #https: Server;
  #origins: CanaryOrigins | null = null;

  private constructor() {
    this.#http = createHttpServer((request, response) => this.#answer("http", request, response));
    this.#https = createHttpsServer(selfSignedCertificate(), (request, response) =>
      this.#answer("https", request, response),
    );
    this.#http.on("connection", () => {
      this.connections.http += 1;
    });
    this.#https.on("connection", () => {
      this.connections.https += 1;
    });
  }

  static async start(): Promise<Canary> {
    const canary = new Canary();
    const [http, https] = await Promise.all([listen(canary.#http), listen(canary.#https)]);

    canary.#origins = { http: `http://127.0.0.1:${http}`, https: `https://127.0.0.1:${https}` };

    return canary;
  }

  get origins(): CanaryOrigins {
    if (this.#origins === null) throw new Error("The canary servers are not listening");

    return this.#origins;
  }

  /** True when `url` is on one of the canary servers. */
  owns(url: string): boolean {
    return url.startsWith(`${this.origins.http}/`) || url.startsWith(`${this.origins.https}/`);
  }

  async stop(): Promise<void> {
    await Promise.all([close(this.#http), close(this.#https)]);
  }

  #answer(scheme: "http" | "https", request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? "/", "http://canary").pathname;

    this.hits.push({
      scheme,
      method: request.method ?? "GET",
      path,
      kind: KINDS.get(path.split("/")[1] ?? "") ?? "other",
    });
    request.resume();
    response.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "no-store",
      "content-length": PIXEL.length,
    });
    response.end(PIXEL);
  }
}

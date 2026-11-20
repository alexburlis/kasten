// Opens IMAP connections: TCP, implicit TLS, or a STARTTLS upgrade. Certificate checks always use
// Node's defaults (the system roots plus an optional extra CA) and are never turned off. Plain
// connections, which carry the password in the clear, go only to loopback or private addresses.
import { lookup } from "node:dns/promises";
import { BlockList, connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect, rootCertificates } from "node:tls";

import { ImapConnectionError, ImapTlsError } from "./errors.ts";

import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";

export type TlsMode = "implicit" | "starttls" | "none";

export interface ImapEndpoint {
  readonly host: string;
  readonly port: number;
  readonly tls: TlsMode;
  /** PEM certificates to trust in addition to the system roots, or null. */
  readonly ca: string | null;
}

/** Opens connections. Tests inject an in-memory transport; production uses `netTransport`. */
export interface ImapTransport {
  /** TCP, wrapped in TLS when `endpoint.tls` is "implicit". */
  connect(endpoint: ImapEndpoint): Promise<Duplex>;
  /** Wraps a connection in TLS after a successful STARTTLS. */
  upgrade(stream: Duplex, endpoint: ImapEndpoint): Promise<Duplex>;
}

const CONNECT_TIMEOUT_MS = 30_000;

const PRIVATE_RANGES = new BlockList();

PRIVATE_RANGES.addSubnet("127.0.0.0", 8, "ipv4");

PRIVATE_RANGES.addSubnet("10.0.0.0", 8, "ipv4");

PRIVATE_RANGES.addSubnet("172.16.0.0", 12, "ipv4");

PRIVATE_RANGES.addSubnet("192.168.0.0", 16, "ipv4");

PRIVATE_RANGES.addSubnet("100.64.0.0", 10, "ipv4");

PRIVATE_RANGES.addSubnet("169.254.0.0", 16, "ipv4");

PRIVATE_RANGES.addAddress("::1", "ipv6");

PRIVATE_RANGES.addSubnet("fc00::", 7, "ipv6");

PRIVATE_RANGES.addSubnet("fe80::", 10, "ipv6");

/**
 * True for loopback and private addresses: 127/8, 10/8, 172.16/12, 192.168/16, 100.64/10
 * (carrier-grade NAT, also Tailscale), 169.254/16, ::1, fc00::/7 and fe80::/10, including
 * IPv4-mapped IPv6 forms.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) return PRIVATE_RANGES.check(address, "ipv4");

  if (family !== 6) return false;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)?.[1];

  return mapped === undefined
    ? PRIVATE_RANGES.check(address, "ipv6")
    : PRIVATE_RANGES.check(mapped, "ipv4");
}

const CERTIFICATE_CODES = /^(CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_TLS_CERT_|HOSTNAME_)/u;

function errorCode(cause: Error): string {
  return "code" in cause ? String(cause.code) : "";
}

function describeTlsFailure(endpoint: ImapEndpoint, cause: Error): Error {
  const where = `${endpoint.host}:${endpoint.port}`;

  if (CERTIFICATE_CODES.test(errorCode(cause))) {
    const hint =
      endpoint.ca === null
        ? " If the server uses its own CA or a self-signed certificate (Proton Bridge does), pass it with --source-ca."
        : "";

    return new ImapTlsError(
      `the TLS certificate of ${where} is not trusted: ${cause.message}.${hint}`,
    );
  }

  return new ImapConnectionError(`TLS with ${where} failed: ${cause.message}`);
}

function waitFor<T extends Socket>(socket: T, event: string, endpoint: ImapEndpoint): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ImapConnectionError(`${endpoint.host}:${endpoint.port} did not answer in time`));
    }, CONNECT_TIMEOUT_MS);

    socket.once(event, () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(socket);
    });

    const onError = (cause: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(
        event === "secureConnect"
          ? describeTlsFailure(endpoint, cause)
          : new ImapConnectionError(
              `cannot connect to ${endpoint.host}:${endpoint.port}: ${cause.message}`,
            ),
      );
    };

    socket.once("error", onError);
  });
}

function trustedCas(endpoint: ImapEndpoint): string[] | undefined {
  return endpoint.ca === null ? undefined : [...rootCertificates, endpoint.ca];
}

function tlsOptions(endpoint: ImapEndpoint) {
  return {
    host: endpoint.host,
    servername: isIP(endpoint.host) === 0 ? endpoint.host : undefined,
    ca: trustedCas(endpoint),
    minVersion: "TLSv1.2" as const,
  };
}

/** Resolves `host` and refuses an address that is not loopback or private. */
async function plainTextAddress(host: string): Promise<string> {
  let address: string;

  try {
    address = isIP(host) === 0 ? (await lookup(host)).address : host;
  } catch (cause) {
    throw new ImapConnectionError(
      `cannot resolve ${host}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (!isPrivateAddress(address)) {
    throw new ImapTlsError(
      `refusing a plain-text IMAP login to ${host} (${address}): without TLS the password would cross the network in the clear. Plain IMAP is allowed only to loopback or private addresses.`,
    );
  }

  return address;
}

function configure(socket: Socket): void {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 60_000);
}

export const netTransport: ImapTransport = {
  async connect(endpoint) {
    if (endpoint.tls === "implicit") {
      const socket: TLSSocket = tlsConnect({ ...tlsOptions(endpoint), port: endpoint.port });

      configure(socket);

      return waitFor(socket, "secureConnect", endpoint);
    }

    const host = endpoint.tls === "none" ? await plainTextAddress(endpoint.host) : endpoint.host;

    const socket = netConnect({ host, port: endpoint.port });

    configure(socket);

    return waitFor(socket, "connect", endpoint);
  },

  async upgrade(stream, endpoint) {
    const socket: TLSSocket = tlsConnect({ ...tlsOptions(endpoint), socket: stream });

    return waitFor(socket, "secureConnect", endpoint);
  },
};

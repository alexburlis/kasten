import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";

import { CliError } from "./errors.ts";
import { describeCause, readTextFile } from "./files.ts";
import { isArray, isNumber, isRecord, isString, parseJson } from "./json.ts";

import type { Json, JsonRecord } from "./json.ts";

/** A validated kasten.json. Paths are absolute. The file holds no secrets, only paths to them. */
export interface KastenConfig {
  /** The MX host name and SMTP greeting, for example mx.example.com. */
  readonly serverHostname: string;
  /** The JMAP and sign-in host name, for example mail.example.com. */
  readonly mailApiHostname: string;
  readonly domains: readonly DomainConfig[];
  readonly users: readonly UserConfig[];
  readonly webApp: WebAppConfig;
  readonly http: HttpConfig;
  readonly smtpBind: string;
  readonly imapImportBind: string | null;
  readonly relays: readonly RelayConfig[];
  readonly operatorPublicKeyFile: string;
  readonly admin: AdminConfig;
  readonly limits: LimitsConfig;
  readonly dnsResolver: ResolverConfig;
  readonly spamRulesUrl: string;
  readonly kumaPushUrlFile: string | null;
  /**
   * The reviewed exceptions `kasten check` reads when `--exceptions` names no file, in the same
   * format, so the daily timer can use them. Null: none.
   */
  readonly checkExceptionsFile: string | null;
  /** Where lock, check, probe and import keep their state files. Default: `state` next to kasten.json. */
  readonly stateDir: string;
  readonly probe: ProbeConfig | null;
  readonly dns: DnsConfig;
}

/** The dedicated probe account for `kasten probe`, and the throwaway sign-in of `kasten lock`. */
export interface ProbeConfig {
  /** One of config.users. It sends only to itself, through the relay route. */
  readonly account: string;
  readonly passwordFile: string;
  /** The Uptime Kuma push URL of the delivery probe, or null for no push. */
  readonly kumaPushUrlFile: string | null;
}

export interface DomainConfig {
  readonly name: string;
  readonly catchAll: string | null;
}

export interface UserConfig {
  readonly email: string;
  readonly description: string | null;
  readonly aliases: readonly string[];
  readonly passwordFile: string | null;
}

export interface WebAppConfig {
  readonly origin: string;
  readonly redirectPath: string;
  readonly oauthClientId: string;
}

export type HttpConfig = DevHttpConfig | ProductionHttpConfig;

/** Development: one plain-HTTP listener for JMAP, sign-in and the admin API. */
export interface DevHttpConfig {
  readonly mode: "dev";
  readonly bind: string;
}

/** Production: public HTTPS on 443 with an ACME TLS-ALPN-01 certificate, admin API on a private plain-HTTP listener. */
export interface ProductionHttpConfig {
  readonly mode: "production";
  readonly publicBind: string;
  readonly adminBind: string;
  readonly acme: AcmeConfig;
}

export interface AcmeConfig {
  readonly directory: string;
  readonly contact: readonly string[];
}

export interface RelayConfig {
  readonly domain: string;
  readonly host: string;
  readonly port: number;
  readonly usernameFile: string;
  readonly passwordFile: string;
}

export interface AdminConfig {
  readonly apiUrl: string;
  readonly apiKeyFile: string;
  /** Local part of the key-only admin account that owns the API key. */
  readonly account: string;
  /** Normalised the way Stalwart stores them: a single address has no /32 or /128 suffix. */
  readonly allowedIps: readonly string[];
}

export interface LimitsConfig {
  readonly inboundMessageBytes: number;
  readonly sendMessageBytes: number;
  readonly uploadTtlSeconds: number;
  readonly maxBufferedMemoryBytes: number;
  readonly outboundRecipientsPerDay: number;
  readonly senderToRecipientPerHour: number;
}

export interface ResolverConfig {
  readonly address: string;
  readonly port: number;
}

export type DmarcPolicy = "none" | "quarantine" | "reject";

export interface DnsConfig {
  readonly ipv4: string | null;
  readonly ipv6: string | null;
  readonly sesRegion: string;
  readonly dmarcPolicy: DmarcPolicy;
  readonly dmarcReportAddress: string | null;
  readonly sesDkimTokens: Readonly<Record<string, readonly string[]>>;
  readonly customMailFrom: string | null;
  readonly tlsRptAddress: string | null;
  readonly ttl: number;
}

export const DEFAULT_LIMITS: LimitsConfig = {
  inboundMessageBytes: 41_943_040,
  sendMessageBytes: 38_000_000,
  uploadTtlSeconds: 300,
  maxBufferedMemoryBytes: 268_435_456,
  outboundRecipientsPerDay: 100,
  senderToRecipientPerHour: 100,
};

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/u;

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const SES_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9]$/u;

const DKIM_TOKEN = /^[a-z0-9]{16,64}$/u;

const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/u;

/** Collects every problem in one pass, so the operator fixes them all at once. */
class Issues {
  readonly list: string[] = [];

  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }
}

class Reader {
  readonly record: JsonRecord;
  readonly path: string;
  readonly issues: Issues;
  readonly baseDir: string;

  constructor(record: JsonRecord, path: string, issues: Issues, baseDir: string) {
    this.record = record;
    this.path = path;
    this.issues = issues;
    this.baseDir = baseDir;
  }

  at(key: string): string {
    return `${this.path}.${key}`;
  }

  /** Reports keys this reader does not know. Keys starting with "//" are comments. */
  allowOnly(keys: readonly string[]): void {
    for (const key of Object.keys(this.record)) {
      if (!key.startsWith("//") && !keys.includes(key))
        this.issues.add(this.at(key), "unknown field");
    }
  }

  value(key: string): Json | undefined {
    return this.record[key];
  }

  child(key: string): Reader | null {
    const value = this.record[key];

    if (!isRecord(value)) {
      this.issues.add(
        this.at(key),
        value === undefined ? "required object is missing" : "must be an object",
      );

      return null;
    }

    return new Reader(value, this.at(key), this.issues, this.baseDir);
  }

  optionalChild(key: string): Reader | null {
    return this.record[key] === undefined ? null : this.child(key);
  }

  string(key: string, check: (value: string) => string | null = () => null): string {
    const value = this.record[key];

    if (!isString(value)) {
      this.issues.add(
        this.at(key),
        value === undefined ? "required string is missing" : "must be a string",
      );

      return "";
    }

    const problem = check(value);

    if (problem !== null) this.issues.add(this.at(key), problem);

    return value;
  }

  nullableString(key: string, check: (value: string) => string | null = () => null): string | null {
    const value = this.record[key];

    if (value === undefined || value === null) return null;

    return this.string(key, check);
  }

  integer(key: string, min: number, max: number, fallback: number | null = null): number {
    const value = this.record[key];

    if (value === undefined && fallback !== null) return fallback;

    if (!isNumber(value) || !Number.isInteger(value) || value < min || value > max) {
      this.issues.add(this.at(key), `must be an integer from ${min} to ${max}`);

      return fallback ?? min;
    }

    return value;
  }

  strings(key: string, check: (value: string) => string | null, allowEmpty: boolean): string[] {
    const value = this.record[key];

    if (value === undefined && allowEmpty) return [];

    if (!isArray(value)) {
      this.issues.add(this.at(key), "must be a list of strings");

      return [];
    }

    if (!allowEmpty && value.length === 0) this.issues.add(this.at(key), "must not be empty");

    const out: string[] = [];

    value.forEach((item, index) => {
      if (!isString(item)) {
        this.issues.add(`${this.at(key)}[${index}]`, "must be a string");

        return;
      }

      const problem = check(item);

      if (problem !== null) this.issues.add(`${this.at(key)}[${index}]`, problem);

      out.push(item);
    });

    return out;
  }

  records(key: string, allowEmpty: boolean): Reader[] {
    const value = this.record[key];

    if (value === undefined && allowEmpty) return [];

    if (!isArray(value)) {
      this.issues.add(this.at(key), "must be a list of objects");

      return [];
    }

    if (!allowEmpty && value.length === 0) this.issues.add(this.at(key), "must not be empty");

    const out: Reader[] = [];

    value.forEach((item, index) => {
      if (isRecord(item)) {
        out.push(new Reader(item, `${this.at(key)}[${index}]`, this.issues, this.baseDir));
      } else {
        this.issues.add(`${this.at(key)}[${index}]`, "must be an object");
      }
    });

    return out;
  }

  filePath(key: string): string {
    const value = this.string(key, (v) => (v.trim() === "" ? "must not be empty" : null));

    return isAbsolute(value) ? value : resolve(this.baseDir, value);
  }

  nullablePath(key: string): string | null {
    const value = this.nullableString(key, (v) => (v.trim() === "" ? "must not be empty" : null));

    if (value === null) return null;

    return isAbsolute(value) ? value : resolve(this.baseDir, value);
  }
}

export function checkHostname(value: string): string | null {
  return HOSTNAME.test(value) ? null : "must be a lower-case host name such as mail.example.com";
}

export function checkEmail(value: string): string | null {
  const at = value.lastIndexOf("@");

  if (at <= 0) return "must be a lower-case email address such as you@example.com";

  return LOCAL_PART.test(value.slice(0, at)) && HOSTNAME.test(value.slice(at + 1))
    ? null
    : "must be a lower-case email address such as you@example.com";
}

/** Checks "host:port", "1.2.3.4:port" or "[v6]:port". */
export function checkSocketAddress(value: string): string | null {
  const match = /^(?:\[([0-9a-f:.]+)\]|([0-9.]+)):([0-9]{1,5})$/u.exec(value);
  const address = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);

  if (match === null || address === undefined || isIP(address) === 0 || port < 1 || port > 65_535) {
    return 'must be an IP address and port, such as "127.0.0.1:8080" or "[::]:443"';
  }

  return null;
}

/** Checks an IP address or CIDR range and returns Stalwart's stored form, or an error. */
export function normaliseIpNetwork(
  value: string,
): { readonly network: string } | { readonly error: string } {
  const [address = "", prefix, extra] = value.split("/");
  const family = isIP(address);

  if (family === 0 || extra !== undefined) return { error: "must be an IP address or CIDR range" };

  const max = family === 4 ? 32 : 128;

  if (prefix === undefined) return { network: address };

  const bits = Number(prefix);

  if (!/^[0-9]{1,3}$/u.test(prefix) || bits > max) return { error: `prefix must be 0 to ${max}` };

  return { network: bits === max ? address : `${address}/${bits}` };
}

function checkUrl(value: string, schemes: readonly string[]): string | null {
  try {
    const url = new URL(value);

    return schemes.includes(url.protocol) ? null : `must use ${schemes.join(" or ")}`;
  } catch {
    return "must be a URL";
  }
}

/** The origin of the web app: scheme, host and optional port, nothing else. */
function checkOrigin(value: string, production: boolean): string | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return "must be an origin such as https://app.example.com";
  }

  if (url.origin !== value)
    return "must be an origin without a path, such as https://app.example.com";

  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

  if (url.protocol === "https:") return null;

  if (url.protocol === "http:" && loopback && !production) return null;

  return production ? "must use https in production" : "must use https, or http on localhost";
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Finds the configured domain a host name belongs to: itself or a parent. */
export function zoneOf(hostname: string, domains: readonly string[]): string | null {
  const matches = domains.filter(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );

  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}

function readHttp(reader: Reader | null): HttpConfig {
  if (reader === null) return { mode: "dev", bind: "0.0.0.0:8080" };

  const mode = reader.string("mode", (v) =>
    v === "dev" || v === "production" ? null : 'must be "dev" or "production"',
  );

  if (mode === "production") {
    reader.allowOnly(["mode", "publicBind", "adminBind", "acme"]);
    const acme = reader.child("acme");
    acme?.allowOnly(["directory", "contact"]);

    return {
      mode: "production",
      publicBind: reader.string("publicBind", checkSocketAddress),
      adminBind: reader.string("adminBind", checkSocketAddress),
      acme: {
        directory: acme?.string("directory", (v) => checkUrl(v, ["https:"])) ?? "",
        contact: acme?.strings("contact", checkEmail, false) ?? [],
      },
    };
  }

  reader.allowOnly(["mode", "bind"]);

  return { mode: "dev", bind: reader.string("bind", checkSocketAddress) };
}

/** Validates parsed kasten.json content. Relative paths resolve against `baseDir`. */
export function validateConfig(json: Json, baseDir: string): KastenConfig {
  const issues = new Issues();

  if (!isRecord(json)) throw new CliError("kasten.json must contain a JSON object");

  const root = new Reader(json, "config", issues, baseDir);
  root.allowOnly([
    "serverHostname",
    "mailApiHostname",
    "domains",
    "users",
    "webApp",
    "http",
    "smtpBind",
    "imapImportBind",
    "relays",
    "operatorPublicKeyFile",
    "admin",
    "limits",
    "dnsResolver",
    "spamRulesUrl",
    "kumaPushUrlFile",
    "checkExceptionsFile",
    "stateDir",
    "probe",
    "dns",
  ]);

  const domains = root.records("domains", false).map((d): DomainConfig => {
    d.allowOnly(["name", "catchAll"]);

    return {
      name: d.string("name", checkHostname),
      catchAll: d.nullableString("catchAll", checkEmail),
    };
  });

  const domainNames = domains.map((d) => d.name);

  if (new Set(domainNames).size !== domainNames.length)
    issues.add("config.domains", "names must be unique");

  const inDomain = (email: string): string | null =>
    checkEmail(email) ??
    (domainNames.includes(domainOf(email)) ? null : "must be in one of config.domains");

  domains.forEach((d, index) => {
    if (d.catchAll !== null && inDomain(d.catchAll) !== null) {
      issues.add(
        `config.domains[${index}].catchAll`,
        "must be an address in one of config.domains",
      );
    }
  });

  const users = root.records("users", true).map((u): UserConfig => {
    u.allowOnly(["email", "description", "aliases", "passwordFile"]);

    return {
      email: u.string("email", inDomain),
      description: u.nullableString("description"),
      aliases: u.strings("aliases", inDomain, true),
      passwordFile: u.nullablePath("passwordFile"),
    };
  });

  const addresses = users.flatMap((u) => [u.email, ...u.aliases]);

  if (new Set(addresses).size !== addresses.length) {
    issues.add("config.users", "every email address and alias must be unique");
  }

  const http = readHttp(root.optionalChild("http"));
  const production = http.mode === "production";
  const serverHostname = root.string("serverHostname", checkHostname);
  const mailApiHostname = root.string("mailApiHostname", checkHostname);

  if (production) {
    for (const [key, host] of [
      ["serverHostname", serverHostname],
      ["mailApiHostname", mailApiHostname],
    ] as const) {
      if (zoneOf(host, domainNames) === null) {
        issues.add(
          `config.${key}`,
          "must be in one of config.domains, so its certificate can be managed",
        );
      }
    }
  }

  const web = root.child("webApp");
  web?.allowOnly(["origin", "redirectPath", "oauthClientId"]);

  const webApp: WebAppConfig = {
    origin: web?.string("origin", (v) => checkOrigin(v, production)) ?? "",
    redirectPath:
      web?.string("redirectPath", (v) =>
        /^\/[A-Za-z0-9._~/-]*$/u.test(v)
          ? null
          : "must be a path starting with /, without query or fragment",
      ) ?? "",
    oauthClientId:
      web?.string("oauthClientId", (v) =>
        CLIENT_ID.test(v) ? null : "must be 1 to 64 letters, digits, '.', '_' or '-'",
      ) ?? "",
  };

  const relays = root.records("relays", false).map((r): RelayConfig => {
    r.allowOnly(["domain", "host", "port", "usernameFile", "passwordFile"]);

    return {
      domain: r.string(
        "domain",
        (v) =>
          checkHostname(v) ?? (domainNames.includes(v) ? null : "must name one of config.domains"),
      ),
      host: r.string("host", checkHostname),
      port: r.integer("port", 1, 65_535, 587),
      usernameFile: r.filePath("usernameFile"),
      passwordFile: r.filePath("passwordFile"),
    };
  });

  if (new Set(relays.map((r) => r.domain)).size !== relays.length)
    issues.add("config.relays", "domain names must be unique");

  if (domainNames.some((domain) => !relays.some((r) => r.domain === domain)))
    issues.add("config.relays", "must supply credentials for every configured domain");

  const adminReader = root.child("admin");
  adminReader?.allowOnly(["apiUrl", "apiKeyFile", "account", "allowedIps"]);

  const allowedIps = (
    adminReader?.strings(
      "allowedIps",
      (v) => {
        const result = normaliseIpNetwork(v);

        return "error" in result ? result.error : null;
      },
      false,
    ) ?? []
  ).map((v) => {
    const result = normaliseIpNetwork(v);

    return "network" in result ? result.network : v;
  });

  const admin: AdminConfig = {
    apiUrl: adminReader?.string("apiUrl", (v) => checkUrl(v, ["http:", "https:"])) ?? "",
    apiKeyFile: adminReader?.filePath("apiKeyFile") ?? "",
    account:
      adminReader?.string("account", (v) =>
        LOCAL_PART.test(v) ? null : "must be a lower-case account name",
      ) ?? "",
    allowedIps,
  };

  const limitsReader = root.optionalChild("limits");
  limitsReader?.allowOnly(Object.keys(DEFAULT_LIMITS));

  const limit = (key: keyof LimitsConfig, min: number, max: number): number =>
    limitsReader?.integer(key, min, max, DEFAULT_LIMITS[key]) ?? DEFAULT_LIMITS[key];

  const limits: LimitsConfig = {
    inboundMessageBytes: limit("inboundMessageBytes", 1_048_576, 1_073_741_824),
    sendMessageBytes: limit("sendMessageBytes", 1_048_576, 1_073_741_824),
    uploadTtlSeconds: limit("uploadTtlSeconds", 60, 86_400),
    maxBufferedMemoryBytes: limit("maxBufferedMemoryBytes", 16_777_216, 17_179_869_184),
    outboundRecipientsPerDay: limit("outboundRecipientsPerDay", 1, 1_000_000),
    senderToRecipientPerHour: limit("senderToRecipientPerHour", 1, 1_000_000),
  };

  const resolverReader = root.optionalChild("dnsResolver");
  resolverReader?.allowOnly(["address", "port"]);

  const dnsResolver: ResolverConfig = {
    address:
      resolverReader === null || resolverReader.value("address") === undefined
        ? "127.0.0.1"
        : resolverReader.string("address", (v) => (isIP(v) === 0 ? "must be an IP address" : null)),
    port: resolverReader?.integer("port", 1, 65_535, 5335) ?? 5335,
  };

  const spamRulesUrl =
    root.value("spamRulesUrl") === undefined
      ? "file:///var/lib/kasten/stalwart/spam-filter-rules.json.gz"
      : root.string("spamRulesUrl", (v) =>
          v.startsWith("file:///")
            ? null
            : "must be a file:/// URL; Kasten never downloads rules at runtime",
        );

  const dns = readDns(root.optionalChild("dns"), domainNames, issues);

  const probe =
    root.value("probe") === null ? null : readProbe(root.optionalChild("probe"), users, issues);

  const config: KastenConfig = {
    serverHostname,
    mailApiHostname,
    domains,
    users,
    webApp,
    http,
    smtpBind:
      root.value("smtpBind") === undefined
        ? "[::]:25"
        : root.string("smtpBind", checkSocketAddress),
    imapImportBind: root.nullableString("imapImportBind", checkSocketAddress),
    relays,
    operatorPublicKeyFile: root.filePath("operatorPublicKeyFile"),
    admin,
    limits,
    dnsResolver,
    spamRulesUrl,
    kumaPushUrlFile: root.nullablePath("kumaPushUrlFile"),
    checkExceptionsFile: root.nullablePath("checkExceptionsFile"),
    stateDir:
      root.value("stateDir") === undefined ? resolve(baseDir, "state") : root.filePath("stateDir"),
    probe,
    dns,
  };

  if (issues.list.length > 0) {
    throw new CliError(
      `kasten.json has ${issues.list.length} problem(s):\n  ${issues.list.join("\n  ")}`,
    );
  }

  return config;
}

function readProbe(
  reader: Reader | null,
  users: readonly UserConfig[],
  issues: Issues,
): ProbeConfig | null {
  if (reader === null) return null;

  reader.allowOnly(["account", "passwordFile", "kumaPushUrlFile"]);

  const account = reader.string("account", checkEmail);

  if (account !== "" && !users.some((user) => user.email === account)) {
    issues.add("config.probe.account", "must be one of config.users, so setup creates it");
  }

  return {
    account,
    passwordFile: reader.filePath("passwordFile"),
    kumaPushUrlFile: reader.nullablePath("kumaPushUrlFile"),
  };
}

function readDns(reader: Reader | null, domainNames: readonly string[], issues: Issues): DnsConfig {
  reader?.allowOnly([
    "ipv4",
    "ipv6",
    "sesRegion",
    "dmarcPolicy",
    "dmarcReportAddress",
    "sesDkimTokens",
    "customMailFrom",
    "tlsRptAddress",
    "ttl",
  ]);

  const tokens: Record<string, readonly string[]> = {};
  const tokenValue = reader?.value("sesDkimTokens");

  if (tokenValue !== undefined) {
    if (isRecord(tokenValue)) {
      for (const [domain, list] of Object.entries(tokenValue)) {
        const path = `config.dns.sesDkimTokens.${domain}`;

        if (!domainNames.includes(domain)) issues.add(path, "must name one of config.domains");

        if (
          !isArray(list) ||
          list.length !== 3 ||
          !list.every((t) => isString(t) && DKIM_TOKEN.test(t))
        ) {
          issues.add(path, "must be the three DKIM tokens from the SES console");
          continue;
        }

        tokens[domain] = list.filter(isString);
      }
    } else {
      issues.add("config.dns.sesDkimTokens", "must be an object of domain to three tokens");
    }
  }

  return {
    ipv4:
      reader?.nullableString("ipv4", (v) => (isIP(v) === 4 ? null : "must be an IPv4 address")) ??
      null,
    ipv6:
      reader?.nullableString("ipv6", (v) => (isIP(v) === 6 ? null : "must be an IPv6 address")) ??
      null,
    sesRegion:
      reader?.string("sesRegion", (v) =>
        SES_REGION.test(v) ? null : "must be an AWS region such as eu-central-1",
      ) ?? "",
    dmarcPolicy: parseDmarcPolicy(reader),
    dmarcReportAddress: reader?.nullableString("dmarcReportAddress", checkEmail) ?? null,
    sesDkimTokens: tokens,
    customMailFrom:
      reader?.nullableString("customMailFrom", (v) =>
        DNS_LABEL.test(v) ? null : "must be one DNS label such as bounce",
      ) ?? null,
    tlsRptAddress: reader?.nullableString("tlsRptAddress", checkEmail) ?? null,
    ttl: reader?.integer("ttl", 60, 86_400, 3600) ?? 3600,
  };
}

function parseDmarcPolicy(reader: Reader | null): DmarcPolicy {
  const value = reader?.value("dmarcPolicy");

  if (value === undefined) return "quarantine";

  const text = reader?.string("dmarcPolicy", (v) =>
    v === "none" || v === "quarantine" || v === "reject"
      ? null
      : 'must be "none", "quarantine" or "reject"',
  );

  return text === "none" || text === "reject" ? text : "quarantine";
}

/** Reads and validates kasten.json. */
export function loadConfig(path: string): KastenConfig {
  const absolute = resolve(path);
  let json: Json;

  try {
    json = parseJson(readTextFile(absolute));
  } catch (cause) {
    if (cause instanceof CliError) throw cause;
    throw new CliError(`${absolute} is not valid JSON: ${describeCause(cause)}`);
  }

  return validateConfig(json, dirname(absolute));
}

/** The OAuth redirect URI the web app uses: origin plus redirect path. */
export function redirectUri(config: KastenConfig): string {
  return `${config.webApp.origin}${config.webApp.redirectPath}`;
}

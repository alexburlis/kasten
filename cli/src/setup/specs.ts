import { createHash } from "node:crypto";

import { maxSentCopyBytes } from "@kasten/core/mail";

import { redirectUri, zoneOf } from "../config.ts";
import { isRecord, isString, jsonList, jsonSet, parseJson } from "../json.ts";

import type { KastenConfig, UserConfig } from "../config.ts";
import type { JsonRecord } from "../json.ts";
import type { Finder, Spec } from "./engine.ts";

/**
 * One condition of a Stalwart expression: `{"if": ..., "then": ...}`. Stalwart names the result
 * key `then`, so this is built from JSON text: an object literal with that key reads as a promise
 * to linters and to `await`.
 */
export function when(condition: string, result: string): JsonRecord {
  const item = parseJson(`{"if":${JSON.stringify(condition)},"then":${JSON.stringify(result)}}`);

  if (!isRecord(item)) throw new Error("unreachable: a JSON object literal parsed to a non-object");

  return item;
}

/** A Stalwart expression: `{"match": {"0": when(...), ...}, "else": ...}`. */
export function expression(cases: readonly JsonRecord[], otherwise: string): JsonRecord {
  return { match: jsonList(cases), else: otherwise };
}

/** A Stalwart expression with no conditions. */
export function constant(value: string): JsonRecord {
  return expression([], value);
}

/** The description of Stalwart's default inbound throttle that Kasten changes in place. */
export const SENDER_TO_RECIPIENT_THROTTLE = "Sender address to recipient throttle";

export const SENDER_IP_THROTTLE = "Sender IP throttle";

export const OUTBOUND_CAP_DESCRIPTION = "Kasten: outbound recipients per day";

export const ADMIN_KEY_DESCRIPTION = "kasten admin api key";

/**
 * Kasten's sign-in page (server/signin/): an x:Application that Stalwart serves from the mail
 * server's image under /signin/, in place of its built-in /login page. It ships no
 * oauth-client.json and names no OAuth client, so it creates no client of its own.
 */
export const SIGNIN_DESCRIPTION = "Kasten sign-in page";

export const SIGNIN_PREFIX = "signin";

/** Where the server image puts the bundle (server/Dockerfile). */
export const SIGNIN_BUNDLE_URL = "file:///opt/kasten/kasten-signin.zip";

/** Stalwart unpacks the bundle here at each start: the mail container's tmpfs, not the volume. */
export const SIGNIN_UNPACK_DIRECTORY = "/run/kasten/apps";

export function relayRoute(domain: string): string {
  return `ses-${domain}`;
}

export const TLS_STRATEGY = "strict";

/**
 * The allowedEndpoints rule that refuses public client registration, device sign-in and Stalwart's
 * built-in /login page. Kasten's own page at /signin/ does the sign-in; /login would show Stalwart's logo.
 */
export const REFUSE_REGISTRATION: JsonRecord = expression(
  [
    when(
      "starts_with(path, '/auth/register') || starts_with(path, '/auth/device') || path == '/device' || starts_with(path, '/device/') || path == '/login' || starts_with(path, '/login/')",
      "403",
    ),
  ],
  "200",
);

function byProperty(key: string, value: string): Finder {
  return (items) => items.filter((item) => item[key] === value);
}

function singleton(object: string, desired: JsonRecord, restart = false): Spec {
  return { kind: "singleton", object, label: object, accountId: null, restart, desired };
}

function localPart(email: string): string {
  return email.slice(0, email.lastIndexOf("@"));
}

function domainPart(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Domain name to x:Domain id, read from the server after the domain step. */
export type DomainIds = ReadonlyMap<string, string>;

function domainId(ids: DomainIds, name: string): string {
  const id = ids.get(name);

  if (id === undefined) throw new Error(`domain ${name} has no id; the domain step must run first`);

  return id;
}

/** Step 1: the mail domains and their catch-all addresses. */
export function domainSpecs(config: KastenConfig): Spec[] {
  return config.domains.map((domain) => ({
    kind: "item",
    object: "x:Domain",
    label: `x:Domain ${domain.name}`,
    accountId: null,
    restart: false,
    find: byProperty("name", domain.name),
    desired: { name: domain.name, enable: true, catchAllAddress: domain.catchAll },
    createExtra: {
      certificateManagement: { "@type": "Manual" },
      dnsManagement: { "@type": "Manual" },
    },
    updateExtra: {},
    missingHint: "",
  }));
}

function listenerSpecs(config: KastenConfig): Spec[] {
  const listeners: {
    name: string;
    protocol: string;
    bind: string;
    tls: boolean;
    implicit: boolean;
  }[] = [];

  if (config.http.mode === "production") {
    listeners.push({
      name: "https",
      protocol: "http",
      bind: config.http.publicBind,
      tls: true,
      implicit: true,
    });
    listeners.push({
      name: "http",
      protocol: "http",
      bind: config.http.adminBind,
      tls: false,
      implicit: false,
    });
  } else {
    listeners.push({
      name: "http",
      protocol: "http",
      bind: config.http.bind,
      tls: false,
      implicit: false,
    });
  }

  // Inbound SMTP offers STARTTLS in production, where an ACME certificate exists.
  listeners.push({
    name: "smtp",
    protocol: "smtp",
    bind: config.smtpBind,
    tls: config.http.mode === "production",
    implicit: false,
  });

  if (config.imapImportBind !== null) {
    listeners.push({
      name: "imap",
      protocol: "imap",
      bind: config.imapImportBind,
      tls: false,
      implicit: false,
    });
  }

  const names = listeners.map((l) => l.name);

  return [
    ...listeners.map((l): Spec => ({
      kind: "item",
      object: "x:NetworkListener",
      label: `x:NetworkListener ${l.name}`,
      accountId: null,
      restart: true,
      find: byProperty("name", l.name),
      desired: {
        protocol: l.protocol,
        bind: jsonSet([l.bind]),
        useTls: l.tls,
        implicitTls: l.implicit,
      },
      createExtra: { name: l.name },
      updateExtra: {},
      missingHint: "",
    })),
    {
      kind: "absent",
      object: "x:NetworkListener",
      label: "x:NetworkListener (others)",
      accountId: null,
      restart: true,
      find: (items) =>
        items.filter((item) => !(isString(item["name"]) && names.includes(item["name"]))),
    },
  ];
}

/** A short fingerprint of a secret, so setup can tell whether a stored secret is current. */
export function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

/** Secrets setup sends to the server, read from their files by the caller. */
export interface SetupSecrets {
  readonly relays: ReadonlyMap<string, { readonly username: string; readonly password: string }>;
  /** Password per user email, for users that must be created. */
  readonly userPasswords: ReadonlyMap<string, string>;
}

/**
 * Local recipients get the local route, everyone else the relay of the sender's domain. One
 * exception: the probe account's own submissions to itself go out through the relay, so
 * `kasten probe` proves the whole path out and back in through the public MX.
 * `source == 'authenticated'` keeps the copy that comes back over SMTP on the local route, so it
 * is delivered instead of relayed again.
 *
 * Mail with an empty or unconfigured envelope sender, such as Stalwart's DSNs, takes the relay of
 * the first domain: Stalwart's default domain, whose MAILER-DAEMON address those DSNs come from.
 * A result that names no route would make Stalwart deliver direct to the recipient's MX.
 */
export function outboundRoute(config: KastenConfig): JsonRecord {
  const probe = config.probe?.account;
  const defaultDomain = config.domains[0]?.name ?? "";

  const cases =
    probe === undefined
      ? []
      : [
          when(
            `source == 'authenticated' && sender == '${probe}' && rcpt == '${probe}'`,
            `'${relayRoute(domainPart(probe))}'`,
          ),
        ];

  return expression(
    [
      ...cases,
      when("is_local_domain(rcpt_domain)", "'local'"),
      ...config.relays.map((r) =>
        when(`sender_domain == '${r.domain}'`, `'${relayRoute(r.domain)}'`),
      ),
    ],
    `'${relayRoute(defaultDomain)}'`,
  );
}

/**
 * Who may send to other domains: any signed-in account, as in Stalwart's default, except the
 * probe account. It may send only to local addresses, and its probe goes to itself.
 */
export function allowRelaying(config: KastenConfig): JsonRecord {
  const probe = config.probe?.account;
  const cases = probe === undefined ? [] : [when(`authenticated_as == '${probe}'`, "false")];

  return expression(cases, "!is_empty(authenticated_as)");
}

function relaySpecs(config: KastenConfig, secrets: SetupSecrets): Spec[] {
  return [
    {
      kind: "item",
      object: "x:MtaRoute",
      label: "x:MtaRoute local",
      accountId: null,
      restart: false,
      find: byProperty("name", "local"),
      desired: { "@type": "Local" },
      createExtra: { name: "local", description: "Local delivery route" },
      updateExtra: {},
      missingHint: "",
    },
    ...config.relays.map((relay): Spec => {
      const secret = secrets.relays.get(relay.domain);

      if (secret === undefined) throw new Error(`relay credentials missing for ${relay.domain}`);
      const name = relayRoute(relay.domain);

      return {
        kind: "item",
        object: "x:MtaRoute",
        label: `x:MtaRoute ${name}`,
        accountId: null,
        restart: false,
        find: byProperty("name", name),
        desired: {
          host: relay.host,
          port: relay.port,
          protocol: "smtp",
          implicitTls: false,
          allowInvalidCerts: false,
          authUsername: secret.username,
          description: `Kasten SES relay ${relay.domain}; password sha256:${fingerprint(secret.password)}`,
        },
        createExtra: {
          "@type": "Relay",
          name,
          authSecret: { "@type": "Value", secret: secret.password },
        },
        updateExtra: { authSecret: { "@type": "Value", secret: secret.password } },
        missingHint: "",
      };
    }),
    {
      kind: "absent",
      object: "x:MtaRoute",
      label: "x:MtaRoute obsolete Kasten relays",
      accountId: null,
      restart: false,
      find: (items) =>
        items.filter(
          (item) =>
            isString(item["description"]) &&
            item["description"].startsWith("Kasten SES relay") &&
            !config.relays.some((r) => item["name"] === relayRoute(r.domain)),
        ),
    },
    {
      kind: "item",
      object: "x:MtaTlsStrategy",
      label: `x:MtaTlsStrategy ${TLS_STRATEGY}`,
      accountId: null,
      restart: false,
      find: byProperty("name", TLS_STRATEGY),
      desired: {
        startTls: "require",
        allowInvalidCerts: false,
        dane: "disable",
        mtaSts: "disable",
        description: "Kasten: STARTTLS required, certificate verified",
      },
      createExtra: { name: TLS_STRATEGY },
      updateExtra: {},
      missingHint: "",
    },
    singleton("x:MtaOutboundStrategy", {
      route: outboundRoute(config),
      tls: constant(`'${TLS_STRATEGY}'`),
    }),
    {
      kind: "absent",
      object: "x:MtaTlsStrategy",
      label: "x:MtaTlsStrategy (allowInvalidCerts)",
      accountId: null,
      restart: false,
      find: (items) => items.filter((item) => item["allowInvalidCerts"] === true),
    },
  ];
}

function throttleSpecs(config: KastenConfig): Spec[] {
  return [
    {
      kind: "item",
      object: "x:MtaInboundThrottle",
      label: "x:MtaInboundThrottle sender IP",
      accountId: null,
      restart: false,
      find: byProperty("description", SENDER_IP_THROTTLE),
      desired: { enable: true, key: jsonSet(["remoteIp"]), rate: { count: 5, period: 1000 } },
      createExtra: { description: SENDER_IP_THROTTLE },
      updateExtra: {},
      missingHint: "",
    },
    {
      kind: "item",
      object: "x:MtaInboundThrottle",
      label: "x:MtaInboundThrottle sender to recipient",
      accountId: null,
      restart: false,
      find: byProperty("description", SENDER_TO_RECIPIENT_THROTTLE),
      desired: {
        enable: true,
        key: jsonSet(["remoteIp", "senderDomain", "rcpt"]),
        rate: { count: config.limits.senderToRecipientPerHour, period: 3_600_000 },
      },
      // Stalwart creates this default on its first normal start; setup changes it in place.
      createExtra: { description: SENDER_TO_RECIPIENT_THROTTLE },
      updateExtra: {},
      missingHint: "",
    },
    {
      kind: "item",
      object: "x:MtaInboundThrottle",
      label: "x:MtaInboundThrottle outbound recipients per day",
      accountId: null,
      restart: false,
      find: byProperty("description", OUTBOUND_CAP_DESCRIPTION),
      desired: {
        enable: true,
        key: {},
        match: expression(
          [when("!is_empty(authenticated_as) && !is_local_domain(rcpt_domain)", "true")],
          "false",
        ),
        rate: { count: config.limits.outboundRecipientsPerDay, period: 86_400_000 },
      },
      createExtra: { description: OUTBOUND_CAP_DESCRIPTION },
      updateExtra: {},
      missingHint: "",
    },
  ];
}

/**
 * Headers on every HTTP response: CORS for the web app, and no framing, which the sign-in page's
 * own policy (a meta element) cannot forbid. Stalwart's /login already sends the same
 * X-Frame-Options.
 */
export function responseHeaders(origin: string): JsonRecord {
  return { ...corsHeaders(origin), "X-Frame-Options": "DENY" };
}

/** CORS for exactly one origin: the web app's. */
export function corsHeaders(origin: string): JsonRecord {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    "Access-Control-Max-Age": "600",
  };
}

/** `bootstrap`: the first boot, before Stalwart's first normal start, when `kasten user add` cannot run. */
function userSpec(
  user: UserConfig,
  ids: DomainIds,
  secrets: SetupSecrets,
  bootstrap: boolean,
): Spec {
  const password = secrets.userPasswords.get(user.email);
  const id = domainId(ids, domainPart(user.email));

  return {
    kind: "item",
    object: "x:Account",
    label: `x:Account ${user.email}`,
    accountId: null,
    restart: false,
    find: (items) =>
      items.filter((item) => item["name"] === localPart(user.email) && item["domainId"] === id),
    desired: {
      description: user.description,
      roles: { "@type": "User" },
      aliases: jsonList(
        user.aliases.map((alias) => ({
          name: localPart(alias),
          domainId: domainId(ids, domainPart(alias)),
          enable: true,
          description: null,
        })),
      ),
    },
    createExtra:
      password === undefined
        ? null
        : {
            "@type": "User",
            name: localPart(user.email),
            domainId: id,
            credentials: { "0": { "@type": "Password", secret: password } },
          },
    updateExtra: {},
    missingHint: bootstrap
      ? "Give it a passwordFile in kasten.json, then run the first boot again (kasten-bootstrap): kasten user add needs Stalwart running normally."
      : "Add it with `kasten user add`, or give it a passwordFile in kasten.json.",
  };
}

/** The key-only admin account that owns the admin API key. */
export function adminAccountSpec(config: KastenConfig, ids: DomainIds): Spec {
  const firstDomain = config.domains[0]?.name ?? "";
  const id = domainId(ids, firstDomain);

  return {
    kind: "item",
    object: "x:Account",
    label: `x:Account ${config.admin.account} (admin)`,
    accountId: null,
    restart: false,
    find: (items) =>
      items.filter((item) => item["name"] === config.admin.account && item["domainId"] === id),
    desired: {
      roles: { "@type": "Admin" },
      description: "Kasten admin API (API key only, no password)",
    },
    createExtra: { "@type": "User", name: config.admin.account, domainId: id },
    updateExtra: {},
    missingHint: "",
  };
}

/** The admin API key's IP restriction. Runs only in normal mode, against the key's own account. */
export function adminKeySpec(config: KastenConfig, adminAccountId: string): Spec {
  return {
    kind: "every",
    object: "x:ApiKey",
    label: "x:ApiKey admin",
    accountId: adminAccountId,
    restart: false,
    find: byProperty("description", ADMIN_KEY_DESCRIPTION),
    desired: {
      allowedIps: jsonSet(config.admin.allowedIps),
      expiresAt: null,
      permissions: { "@type": "Inherit" },
    },
  };
}

/**
 * Settings that Stalwart owns defaults for. On its first normal start, Stalwart inserts the
 * default routes, TLS strategies, inbound throttles and the x:Jmap singleton with a new Web Push
 * (VAPID) key, but only for object types that are still empty. Bootstrap therefore leaves these
 * alone, and the first normal-mode setup applies them.
 */
export function afterFirstStartSpecs(config: KastenConfig, secrets: SetupSecrets): Spec[] {
  const { sendMessageBytes } = config.limits;
  // One send uploads the message, then its encrypted Sent copy, which is larger. Stalwart's
  // defaults, 50 MB per upload and per uploadTtl window (structs_impl.rs:39467-39469), refuse
  // the copy of a message near the 38 MB send limit.
  const maxUploadSize = maxSentCopyBytes(sendMessageBytes);

  return [
    singleton("x:Jmap", {
      uploadTtl: config.limits.uploadTtlSeconds * 1000,
      maxUploadSize,
      uploadQuota: sendMessageBytes + maxUploadSize,
    }),
    ...throttleSpecs(config),
    ...relaySpecs(config, secrets),
    // The spam rules bring remote lists (phishing feeds, disposable and free mail domains), which
    // Stalwart fetches from the internet at the first lookup. Every runtime download stays off.
    // A later rules update keeps each list's local `enable` (spam_classifier.rs:127-130).
    {
      kind: "every",
      object: "x:HttpLookup",
      label: "x:HttpLookup (remote lists)",
      accountId: null,
      restart: false,
      find: (items) => items,
      desired: { enable: false },
    },
  ];
}

/**
 * Logging: one console tracer at info, which the container log and the host's journal keep in
 * memory. File tracers stay off, so nothing is written to the container's disk.
 */
function tracerSpecs(): Spec[] {
  return [
    {
      kind: "item",
      object: "x:Tracer",
      label: "x:Tracer stdout",
      accountId: null,
      restart: false,
      find: (items) => items.filter((item) => item["@type"] === "Stdout"),
      desired: { enable: true, level: "info", ansi: false, multiline: false, buffered: false },
      createExtra: { "@type": "Stdout" },
      updateExtra: {},
      missingHint: "",
    },
    {
      kind: "every",
      object: "x:Tracer",
      label: "x:Tracer (log files)",
      accountId: null,
      restart: false,
      find: (items) => items.filter((item) => item["@type"] === "Log"),
      desired: { enable: false },
    },
  ];
}

/** The namespaces of the remote lists in the pinned spam rules (v3.0.3). */
export const SPAM_RULE_REMOTE_LISTS: readonly string[] = [
  "stwt_openphish",
  "stwt_phishtank",
  "stwt_disposable_domains",
  "stwt_free_domains",
];

/**
 * The spam rules' remote lists, stored disabled before the first normal start. That start
 * imports the rules and matches each list by its namespace; an update keeps the stored
 * `enable` (spam_classifier.rs:127-130, 286-306), so no list is ever fetched. The rules import
 * replaces the placeholder URL with the real one.
 */
function remoteListSpecs(): Spec[] {
  return SPAM_RULE_REMOTE_LISTS.map((namespace): Spec => ({
    kind: "item",
    object: "x:HttpLookup",
    label: `x:HttpLookup ${namespace}`,
    accountId: null,
    restart: false,
    find: (items) => items.filter((item) => item["namespace"] === namespace),
    desired: { enable: false },
    createExtra: {
      namespace,
      url: "https://kasten.invalid/disabled-until-the-spam-rules-import",
      format: { "@type": "List" },
    },
    updateExtra: {},
    missingHint: "",
  }));
}

/** What setup prints for the web app's OAuth client. */
export function oauthClientLabel(config: KastenConfig): string {
  return `x:OAuthClient ${config.webApp.oauthClientId}`;
}

/**
 * Step 2: server settings that are safe to write in recovery mode, before the first normal start.
 * `locked`: `kasten lock` has pinned at least one account. `bootstrap`: this is the first boot.
 */
export function serverSpecs(
  config: KastenConfig,
  ids: DomainIds,
  secrets: SetupSecrets,
  locked: boolean,
  bootstrap: boolean,
): Spec[] {
  const production = config.http.mode === "production";
  const firstDomain = config.domains[0]?.name ?? "";

  return [
    singleton("x:SystemSettings", {
      defaultHostname: config.serverHostname,
      defaultDomainId: domainId(ids, firstDomain),
      maxBufferedMemory: config.limits.maxBufferedMemoryBytes,
    }),
    ...listenerSpecs(config),
    singleton("x:DnsResolver", {
      "@type": "Custom",
      servers: {
        "0": {
          address: config.dnsResolver.address,
          port: config.dnsResolver.port,
          protocol: "udp",
        },
      },
      timeout: 5000,
      attempts: 2,
      maxConcurrentRequests: 2,
      enableEdns: true,
      preserveIntermediates: true,
      tcpOnError: true,
    }),
    singleton("x:Email", {
      encryptAtRest: true,
      encryptOnAppend: true,
      maxMessageSize: config.limits.sendMessageBytes,
    }),
    singleton("x:MtaStageData", {
      maxMessageSize: constant(String(config.limits.inboundMessageBytes)),
      dkimSignDomain: constant("false"),
    }),
    singleton("x:Asn", { "@type": "Disabled" }),
    singleton("x:MtaStageRcpt", { allowRelaying: allowRelaying(config) }),
    ...tracerSpecs(),
    singleton("x:SpamSettings", { spamFilterRulesUrl: config.spamRulesUrl, maxRedirectUrls: 0 }),
    ...remoteListSpecs(),
    singleton("x:SpamClassifier", { model: { "@type": "Disabled" } }),
    singleton(
      "x:DataRetention",
      {
        // Stalwart otherwise destroys every message 30 days after it lands in Deleted Items or
        // Junk Mail, imported Trash and Spam included (email/src/message/delete.rs:155-160).
        expungeTrashAfter: null,
        blobCleanupSchedule: { "@type": "Hourly", minute: 5 },
        dataCleanupSchedule: { "@type": "Hourly", minute: 6 },
        holdMtaReportsFor: null,
      },
      true,
    ),
    singleton("x:CalendarScheduling", { enable: false, httpRsvpEnable: false }),
    singleton("x:Imap", { allowPlainTextAuth: config.imapImportBind !== null }),
    {
      // Stalwart's web admin UI and any other bundle: never served, never downloaded.
      kind: "every",
      object: "x:Application",
      label: "x:Application (all but Kasten's sign-in page)",
      accountId: null,
      restart: true,
      find: (items) => items.filter((item) => item["description"] !== SIGNIN_DESCRIPTION),
      desired: { enable: false },
    },
    {
      kind: "item",
      object: "x:Application",
      label: `x:Application ${SIGNIN_DESCRIPTION}`,
      accountId: null,
      // UpdateApps, which every normal setup run sends, serves a new or changed bundle at once.
      restart: false,
      find: byProperty("description", SIGNIN_DESCRIPTION),
      desired: {
        enable: true,
        resourceUrl: SIGNIN_BUNDLE_URL,
        urlPrefix: jsonSet([SIGNIN_PREFIX]),
        unpackDirectory: SIGNIN_UNPACK_DIRECTORY,
        oauthClientId: null,
      },
      createExtra: { description: SIGNIN_DESCRIPTION },
      updateExtra: {},
      missingHint: "",
    },
    singleton("x:DmarcReportSettings", {
      aggregateSendFrequency: constant("disable"),
      failureSendFrequency: constant("false"),
    }),
    singleton("x:TlsReportSettings", { sendFrequency: constant("disable") }),
    singleton("x:DkimReportSettings", { sendFrequency: constant("false") }),
    singleton("x:SpfReportSettings", { sendFrequency: constant("false") }),
    singleton("x:Http", {
      allowedEndpoints: REFUSE_REGISTRATION,
      responseHeaders: responseHeaders(config.webApp.origin),
      usePermissiveCors: false,
      clientIpSource: "peer",
      enableHsts: production,
      redirectRoot: null,
    }),
    singleton("x:OidcProvider", { clientMetadataDocuments: "disabled" }),
    {
      kind: "item",
      object: "x:OAuthClient",
      label: oauthClientLabel(config),
      accountId: null,
      restart: false,
      find: byProperty("clientId", config.webApp.oauthClientId),
      desired: {
        description: "Kasten web app",
        redirectUris: jsonSet([redirectUri(config)]),
        postLogoutRedirectUris: {},
        scopes: jsonSet(["mail"]),
        grantTypes: jsonSet(["authorizationCode", "refreshToken"]),
        expiresAt: null,
      },
      // First-party until `kasten lock`: the app needs the account's own settings to upload
      // the key bundle and enrol MFA. Setup never changes firstParty after creating the client.
      // After a lock, a client that setup must create, under a new id or because it is gone, is
      // created locked: a first-party one would let every new sign-in change keys and MFA again.
      createExtra: { clientId: config.webApp.oauthClientId, firstParty: !locked },
      updateExtra: {},
      missingHint: "",
    },
    {
      kind: "absent",
      object: "x:OAuthClient",
      label: "x:OAuthClient (others)",
      accountId: null,
      restart: false,
      find: (items) => items.filter((item) => item["clientId"] !== config.webApp.oauthClientId),
    },
    adminAccountSpec(config, ids),
    ...config.users.map((user) => userSpec(user, ids, secrets, bootstrap)),
  ];
}

export const ACME_DESCRIPTION = "Kasten ACME (TLS-ALPN-01)";

/** Production step 3a: the ACME provider. Creating it registers an account with the CA. */
export function acmeProviderSpec(config: KastenConfig): Spec[] {
  if (config.http.mode !== "production") return [];

  return [
    {
      kind: "item",
      object: "x:AcmeProvider",
      label: "x:AcmeProvider",
      accountId: null,
      restart: false,
      find: byProperty("description", ACME_DESCRIPTION),
      desired: {
        challengeType: "TlsAlpn01",
        // Stalwart stores each contact as `mailto:` plus the address, so readback compares that
        // form. kasten.json addresses are already lower-case, as Stalwart's sanitizing makes them.
        contact: jsonSet(config.http.acme.contact.map((address) => `mailto:${address}`)),
        renewBefore: "R23",
        reuseKey: false,
      },
      createExtra: { description: ACME_DESCRIPTION, directory: config.http.acme.directory },
      updateExtra: {},
      missingHint: "",
    },
  ];
}

/** Production step 3b: automatic certificates for the MX and mail API host names. */
export function certificateSpecs(config: KastenConfig, providerId: string): Spec[] {
  if (config.http.mode !== "production") return [];

  const names = config.domains.map((d) => d.name);
  const byZone = new Map<string, string[]>();

  for (const host of [config.mailApiHostname, config.serverHostname]) {
    const zone = zoneOf(host, names);

    if (zone !== null) byZone.set(zone, [...new Set([...(byZone.get(zone) ?? []), host])]);
  }

  return [...byZone.entries()].map(([zone, hosts]) => ({
    kind: "item",
    object: "x:Domain",
    label: `x:Domain ${zone} certificate`,
    accountId: null,
    restart: false,
    find: byProperty("name", zone),
    desired: {
      certificateManagement: {
        "@type": "Automatic",
        acmeProviderId: providerId,
        subjectAlternativeNames: jsonSet(hosts),
      },
    },
    createExtra: null,
    updateExtra: {},
    missingHint: "The domain step creates it.",
  }));
}

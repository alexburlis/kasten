// The kasten-web image's start script (web/docker/kasten-web-start), run in the real image with
// `docker run`: /config.json written from the environment, a mounted config.json, the response
// headers, and every refusal. Needs Docker; see web/README.md, "The kasten-web image".
//
// The test builds the image from the current source as kasten-web:image-test, gives the script its
// files through a Docker volume (so it needs no host folder shared with the Docker engine), and
// removes the containers, the volume and the image tag at the end. Ports are ephemeral, on
// 127.0.0.1 only.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { devDir, dockerEnv, loadDevState, REPO_DIR } from "../scripts/dev-stack.ts";

const IMAGE = "kasten-web:image-test";

const RUN_ID = randomBytes(4).toString("hex");

const VOLUME = `kasten-web-image-test-${RUN_ID}`;

const API_URL = "https://mail.example.test";

/** The caller's DOCKER_CONTEXT, else the dev stack's (state.json), else Docker's default. */
const ENV = existsSync(join(devDir(), "state.json")) ? dockerEnv(loadDevState()) : process.env;

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function docker(args: readonly string[], input: string | null = null): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], { env: ENV, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.end(input ?? "");
  });
}

async function dockerOk(args: readonly string[], input: string | null = null): Promise<string> {
  const result = await docker(args, input);

  if (result.code !== 0)
    throw new Error(
      `docker ${args[0] ?? ""} failed (${result.code}): ${result.stderr.slice(-2000)}`,
    );

  return result.stdout;
}

/** Two armored public keys, with CRLF line ends and text around them, as an editor may save them. */
const FIRST_KEY = [
  "-----BEGIN PGP PUBLIC KEY BLOCK-----",
  "Comment: saved as C:\\keys\\operator.asc",
  "",
  "mDMEaQAAABYJKwYBBAHaRw8BAQdAoperatorkeyoneAAAAAAAAAAAAAAAAAAAAAAA",
  "=AAAA",
  "-----END PGP PUBLIC KEY BLOCK-----",
];

const SECOND_KEY = [
  "-----BEGIN PGP PUBLIC KEY BLOCK-----",
  "",
  "mDMEaQAAABYJKwYBBAHaRw8BAQdAoperatorkeytwoAAAAAAAAAAAAAAAAAAAAAAA",
  "=BBBB",
  "-----END PGP PUBLIC KEY BLOCK-----",
];

const OPERATOR_KEYS = ["Operator keys for Kasten", ...FIRST_KEY, "", ...SECOND_KEY, ""].join(
  "\r\n",
);

/** The armor header of a secret key; the script refuses any file that holds one. */
const SECRET_KEY_FILE = `${["-----BEGIN PGP", "PRIVATE KEY BLOCK-----"].join(" ")}\n\nAAAA\n`;

const MATCHING_CONFIG = `${JSON.stringify(
  {
    apiUrl: `${API_URL}/`,
    oauthClientId: "mounted-client",
    operatorKeys: [],
    appName: "Mounted",
  },
  null,
  2,
)}\n`;

const OTHER_CONFIG = JSON.stringify({
  apiUrl: "https://other.example.test",
  oauthClientId: "kasten-web",
  operatorKeys: [],
  appName: "Kasten",
});

/** The files the containers see under /files. */
const FILES = {
  "operator.asc": OPERATOR_KEYS,
  "secret.asc": SECRET_KEY_FILE,
  "empty.asc": "No keys in here.\n",
  "match.json": MATCHING_CONFIG,
  "other.json": OTHER_CONFIG,
} satisfies Readonly<Record<string, string>>;

function appCsp(api: string): string {
  return `default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; manifest-src 'self'; connect-src 'self' ${api}; img-src 'self' blob: data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
}

/** A message frame's policy, with the image sources it allows. */
function frameCsp(images: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; img-src ${images}; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
}

/** The hardening the dev and production compose files use. */
const HARDENED = [
  "--read-only",
  "--tmpfs",
  "/tmp",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
];

const containers: string[] = [];

/** Starts the image in the background with these variables; returns its base URL. */
async function serve(env: Readonly<Record<string, string>>): Promise<string> {
  const name = `kasten-web-image-test-${RUN_ID}-${containers.length + 1}`;

  containers.push(name);
  await dockerOk([
    "run",
    "-d",
    "--name",
    name,
    ...HARDENED,
    "-p",
    "127.0.0.1::8080",
    "-v",
    `${VOLUME}:/files:ro`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    IMAGE,
  ]);

  const port = (await dockerOk(["port", name, "8080/tcp"])).trim().split("\n")[0] ?? "";
  const base = `http://${port}`;
  const deadline = Date.now() + 30_000;

  for (;;) {
    const ready = await fetch(`${base}/index.html`).then(
      (response) => response.ok,
      () => false,
    );

    if (ready) return base;

    if (Date.now() > deadline) {
      const logs = await docker(["logs", name]);

      throw new Error(`kasten-web did not answer on ${base}: ${logs.stderr.slice(-2000)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Runs the start script in the foreground; it must refuse to start. */
function refuse(env: Readonly<Record<string, string>>): Promise<RunResult> {
  return docker([
    "run",
    "--rm",
    ...HARDENED,
    "-v",
    `${VOLUME}:/files:ro`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    IMAGE,
  ]);
}

const config = z.object({
  apiUrl: z.string(),
  oauthClientId: z.string(),
  operatorKeys: z.array(z.string()),
  appName: z.string(),
});

beforeAll(async () => {
  await dockerOk(["build", "-f", join(REPO_DIR, "web", "Dockerfile"), "-t", IMAGE, REPO_DIR]);
  await dockerOk(["volume", "create", VOLUME]);

  for (const [name, content] of Object.entries(FILES)) {
    await dockerOk(
      [
        "run",
        "--rm",
        "-i",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        "-v",
        `${VOLUME}:/files`,
        IMAGE,
        "-c",
        `cat > /files/${name} && chmod 0644 /files/${name}`,
      ],
      content,
    );
  }
});

afterAll(async () => {
  for (const name of containers) await docker(["rm", "-f", name]);

  await docker(["volume", "rm", VOLUME]);
  await docker(["image", "rm", IMAGE]);
});

describe("kasten-web-start", () => {
  it("writes /config.json from the environment when no file is mounted", async () => {
    const appName = 'Family "Post" \\ Box';

    const base = await serve({
      KASTEN_API_URL: `${API_URL}/`,
      KASTEN_OAUTH_CLIENT_ID: "kasten-web",
      KASTEN_OPERATOR_KEYS_FILE: "/files/operator.asc",
      KASTEN_APP_NAME: appName,
    });

    const response = await fetch(`${base}/config.json`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/u);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-security-policy")).toBe(appCsp(API_URL));
    // Each key is its armored block alone: no text around it, LF line ends, a final newline.
    expect(config.parse(await response.json())).toEqual({
      apiUrl: API_URL,
      oauthClientId: "kasten-web",
      operatorKeys: [`${FIRST_KEY.join("\n")}\n`, `${SECOND_KEY.join("\n")}\n`],
      appName,
    });

    const page = await fetch(`${base}/`);

    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(appCsp(API_URL));
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(page.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("writes an empty key list and the default name when those variables are unset", async () => {
    const base = await serve({
      KASTEN_API_URL: "http://localhost:7481",
      KASTEN_OAUTH_CLIENT_ID: "kasten-web",
    });

    expect(config.parse(await (await fetch(`${base}/config.json`)).json())).toEqual({
      apiUrl: "http://localhost:7481",
      oauthClientId: "kasten-web",
      operatorKeys: [],
      appName: "Kasten",
    });
    expect((await fetch(`${base}/`)).headers.get("content-security-policy")).toBe(
      appCsp("http://localhost:7481"),
    );
  });

  it("serves each message frame under its own policy", async () => {
    const base = await serve({ KASTEN_API_URL: API_URL, KASTEN_OAUTH_CLIENT_ID: "kasten-web" });

    for (const [path, images] of [
      ["/frame/message.html", "data: blob:"],
      ["/frame/message-remote.html", "data: blob: https:"],
    ] as const) {
      const response = await fetch(`${base}${path}`);

      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-security-policy"), path).toBe(frameCsp(images));
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      expect(response.headers.get("strict-transport-security"), path).toBe("max-age=31536000");
    }
  });

  it("serves a mounted config.json unchanged when its apiUrl matches", async () => {
    const base = await serve({
      KASTEN_API_URL: API_URL,
      KASTEN_WEB_CONFIG_FILE: "/files/match.json",
      // Ignored with a mounted file.
      KASTEN_OAUTH_CLIENT_ID: "unused",
    });

    const response = await fetch(`${base}/config.json`);

    expect(await response.text()).toBe(MATCHING_CONFIG);
    expect(response.headers.get("content-security-policy")).toBe(appCsp(API_URL));
  });

  it("serves /sw.js with a digest of the response headers, so a header change updates the app", async () => {
    const env = { KASTEN_API_URL: API_URL, KASTEN_OAUTH_CLIENT_ID: "kasten-web" };

    const [first, again, moved] = await Promise.all([
      serve(env),
      serve(env),
      serve({ ...env, KASTEN_API_URL: "https://moved.example.test" }),
    ]);

    const built = await dockerOk([
      "run",
      "--rm",
      "--entrypoint",
      "cat",
      IMAGE,
      "/usr/share/kasten-web/sw.js",
    ]);

    const response = await fetch(`${first}/sw.js`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^(?:application|text)\/javascript/u);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-security-policy")).toBe(appCsp(API_URL));
    // The built worker, unchanged, then one comment line with the digest.
    expect(body.startsWith(built)).toBe(true);
    expect(body.slice(built.length)).toMatch(/^\n\/\/ kasten-web headers [0-9a-f]{64}\n$/u);
    // A restart with the same settings serves the same bytes: no update for the browser to install.
    expect(await (await fetch(`${again}/sw.js`)).text()).toBe(body);
    // Another API origin changes connect-src, and so /sw.js: installed apps get the new worker,
    // which caches the page and the frames again with the new headers.
    expect(await (await fetch(`${moved}/sw.js`)).text()).not.toBe(body);
  });

  it("refuses a mounted config.json whose apiUrl differs from KASTEN_API_URL", async () => {
    const result = await refuse({
      KASTEN_API_URL: API_URL,
      KASTEN_WEB_CONFIG_FILE: "/files/other.json",
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `kasten-web: /files/other.json has apiUrl 'https://other.example.test', but KASTEN_API_URL is '${API_URL}'\n`,
    );
  });

  it.each([
    ["no KASTEN_API_URL", {}, "KASTEN_API_URL is not set"],
    [
      "an API URL with a path",
      { KASTEN_API_URL: `${API_URL}/jmap` },
      `KASTEN_API_URL must be an origin such as https://mail.example.com, not '${API_URL}/jmap'`,
    ],
    [
      "plain http to another host",
      { KASTEN_API_URL: "http://mail.example.test" },
      "KASTEN_API_URL must use https, except for localhost",
    ],
    [
      "no OAuth client ID without a mounted file",
      { KASTEN_API_URL: API_URL },
      "KASTEN_OAUTH_CLIENT_ID must be set to the OAuth client ID (letters, digits, . _ -)",
    ],
    [
      "a client ID with a quote",
      { KASTEN_API_URL: API_URL, KASTEN_OAUTH_CLIENT_ID: 'web"' },
      "KASTEN_OAUTH_CLIENT_ID must be set to the OAuth client ID (letters, digits, . _ -)",
    ],
    [
      "a key file that does not exist",
      {
        KASTEN_API_URL: API_URL,
        KASTEN_OAUTH_CLIENT_ID: "kasten-web",
        KASTEN_OPERATOR_KEYS_FILE: "/files/missing.asc",
      },
      "KASTEN_OPERATOR_KEYS_FILE /files/missing.asc is not readable",
    ],
    [
      "a key file with a secret key",
      {
        KASTEN_API_URL: API_URL,
        KASTEN_OAUTH_CLIENT_ID: "kasten-web",
        KASTEN_OPERATOR_KEYS_FILE: "/files/secret.asc",
      },
      "/files/secret.asc holds a private key; give public keys only",
    ],
    [
      "a key file without a public key",
      {
        KASTEN_API_URL: API_URL,
        KASTEN_OAUTH_CLIENT_ID: "kasten-web",
        KASTEN_OPERATOR_KEYS_FILE: "/files/empty.asc",
      },
      "/files/empty.asc holds no armored public key",
    ],
  ])("refuses to start with %s", async (_name, env, reason) => {
    const result = await refuse(env);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe(`kasten-web: ${reason}\n`);
  });
});

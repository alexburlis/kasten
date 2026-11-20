// Stalwart limits anonymous HTTP requests per address (100 a minute, then HTTP 429 with
// Retry-After), and every test file signs in from the same address, so a busy suite can get a 429.
// That answer is the limit, not the behaviour under test: wait out the window and send the request
// again, a bounded number of times, and say so. No test expects a 429.
//
// The suite loads this file in each test worker, and through NODE_OPTIONS in every Node process
// a test starts, so the CLI runs the same way. There each notice goes to stderr, and runCli
// (cli/test/integration/live.ts) moves it out of the CLI's own output.
import { pathToFileURL } from "node:url";

const ATTEMPTS = 6;

const DEFAULT_WAIT_MS = 15_000;

const PRELOAD = `--import=${pathToFileURL(import.meta.filename).href}`;

const options = process.env["NODE_OPTIONS"] ?? "";

if (!options.split(" ").includes(PRELOAD))
  process.env["NODE_OPTIONS"] = `${options} ${PRELOAD}`.trim();

const send = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  // A body can be sent once, so each attempt keeps a clone for the next. The caller's own request
  // goes first: copies made with new Request(request) changed Stalwart's answers in cli-read.
  let request = input instanceof Request ? input : new Request(input, init);

  for (let attempt = 1; ; attempt += 1) {
    const spare = request.clone();
    const response = await send(request);

    if (response.status !== 429 || attempt === ATTEMPTS) return response;

    const after = Number(response.headers.get("retry-after"));
    const wait = Number.isFinite(after) && after > 0 ? after * 1000 : DEFAULT_WAIT_MS;

    console.warn(
      `HTTP 429 from ${new URL(request.url).pathname}; Stalwart's rate limit, retrying in ${wait / 1000} s`,
    );
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, wait));
    request = spare;
  }
};

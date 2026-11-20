// Stalwart's own sign-in page, driven the way its script does it
// (resources/html-templates/login.html in Stalwart v1.0.1): the page reads the client with
// GET /api/auth/client?<query> (lines 714-724, 918-931), posts the login as JSON to /api/auth
// (726-750, 811-826), answers a consent request with authConsent (830-856), and follows the
// returned location (762-766). The password goes only in the POST body.
import { z } from "zod";

const clientSchema = z
  .object({ redirectHost: z.string().nullish(), name: z.string().nullish() })
  .loose();

const clientErrorSchema = z
  .object({ error: z.string(), description: z.string().nullish() })
  .loose();

const answerSchema = z.object({
  type: z.string(),
  location: z.string().optional(),
  token: z.string().optional(),
  description: z.string().nullish(),
});

/** What the sign-in page ended with. */
export interface SignInResult {
  /** The redirect back to the app, with code, state and iss. */
  readonly location: string;
  readonly consentAsked: boolean;
}

function origin(authorizeUrl: string): string {
  return new URL(authorizeUrl).origin;
}

function queryOf(authorizeUrl: string): string {
  return new URL(authorizeUrl).search.replace(/^\?/u, "");
}

/** GET /api/auth/client for the authorize URL's query: the client, or the refusal. */
export async function clientLookup(authorizeUrl: string): Promise<{
  readonly status: number;
  readonly error: string | null;
  readonly redirectHost: string | null;
}> {
  const response = await fetch(`${origin(authorizeUrl)}/api/auth/client?${queryOf(authorizeUrl)}`, {
    headers: { accept: "application/json" },
    redirect: "manual",
  });

  const body: unknown = await response.json();
  const refused = clientErrorSchema.safeParse(body);

  if (refused.success)
    return { status: response.status, error: refused.data.error, redirectHost: null };

  return {
    status: response.status,
    error: null,
    redirectHost: clientSchema.parse(body).redirectHost ?? null,
  };
}

async function post(
  authorizeUrl: string,
  body: Record<string, string | boolean>,
): Promise<z.infer<typeof answerSchema>> {
  const response = await fetch(`${origin(authorizeUrl)}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
  });

  if (response.status !== 200) throw new Error(`POST /api/auth answered ${response.status}`);

  return answerSchema.parse(await response.json());
}

/** Signs in on the real page and returns where it redirects. Throws on any other outcome. */
export async function signIn(
  authorizeUrl: string,
  email: string,
  password: string,
): Promise<SignInResult> {
  const page = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await page.text();

  if (page.status !== 200 || !html.includes('id="login-form"')) {
    throw new Error(`The sign-in page answered ${page.status} without its login form`);
  }

  const client = await clientLookup(authorizeUrl);

  if (client.error !== null)
    throw new Error(`The sign-in page refused the client: ${client.error}`);

  const query = queryOf(authorizeUrl);

  let answer = await post(authorizeUrl, {
    type: "authCode",
    accountName: email,
    accountSecret: password,
    query,
  });

  let consentAsked = false;

  if (answer.type === "consentRequired" && answer.token !== undefined) {
    consentAsked = true;
    answer = await post(authorizeUrl, {
      type: "authConsent",
      token: answer.token,
      query,
      consent: true,
    });
  }

  if (answer.type !== "authenticated" || answer.location === undefined) {
    throw new Error(`The sign-in page answered ${answer.type}: ${answer.description ?? ""}`);
  }

  return { location: answer.location, consentAsked };
}

/** Posts the login for an authorize URL and returns the answer type, for refusals. */
export async function loginAnswer(
  authorizeUrl: string,
  email: string,
  password: string,
): Promise<string> {
  return (
    await post(authorizeUrl, {
      type: "authCode",
      accountName: email,
      accountSecret: password,
      query: queryOf(authorizeUrl),
    })
  ).type;
}

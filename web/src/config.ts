// Runtime configuration from /config.json on the app's own origin (written by the kasten-web image).
import { z } from "zod";

export const appConfig = z.object({
  /** The mail API: the OAuth issuer and the JMAP server, for example https://mail.example.com. */
  apiUrl: z.url({ protocol: /^https?$/u }),
  oauthClientId: z.string().min(1),
  /** Armored public keys added to the user's key in the bundle, for example the agent reader's key. */
  operatorKeys: z.array(z.string()),
  appName: z.string().min(1),
});

export type AppConfig = z.infer<typeof appConfig>;

export class KastenConfigError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "KastenConfigError";
  }
}

/** Fetches and checks /config.json. The service worker answers it network-first. */
export async function loadConfig(fetcher: typeof fetch = fetch): Promise<AppConfig> {
  let response: Response;

  try {
    response = await fetcher("/config.json", { cache: "no-store", credentials: "omit" });
  } catch (cause) {
    throw new KastenConfigError("The app's settings could not be loaded", cause);
  }

  if (!response.ok) {
    throw new KastenConfigError(`The app's settings could not be loaded (HTTP ${response.status})`);
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (cause) {
    throw new KastenConfigError("config.json is not JSON", cause);
  }

  const parsed = appConfig.safeParse(body);

  if (!parsed.success)
    throw new KastenConfigError(`config.json is not valid: ${parsed.error.message}`);

  return { ...parsed.data, apiUrl: parsed.data.apiUrl.replace(/\/+$/u, "") };
}

/** The OAuth redirect URI: exactly one is registered for the client. */
export function redirectUri(origin: string = location.origin): string {
  return `${origin}/oauth/callback`;
}

export const OAUTH_SCOPE = "openid offline_access urn:ietf:params:oauth:scope:mail";

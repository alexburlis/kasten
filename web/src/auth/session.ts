// Sign-in with Stalwart's OAuth (authorization code with PKCE), through @kasten/core/auth.
//
// - The PKCE verifier and the state live in sessionStorage only for the round trip to the sign-in
//   page, which the mail server serves at /signin/ (server/signin/).
// - Tokens live in memory. The refresh token is handed to `persist`, which seals it in the local
//   store; nothing here writes to storage that outlives the tab.
import {
  buildAuthorizeUrl,
  createAuthRequest,
  discover,
  exchangeCode,
  KastenAuthError,
  readAuthorizationResponse,
  refresh,
  revoke,
  type AuthRequest,
  type OAuthMetadata,
  type TokenSet,
} from "@kasten/core/auth";
import type { HttpTransport } from "@kasten/core/jmap";
import { z } from "zod";

import { OAUTH_SCOPE, redirectUri, type AppConfig } from "../config.ts";

const PENDING_KEY = "kasten.oauth.pending";

/** The mail server's metadata with Kasten's sign-in page (server/signin/) as the login page. */
export function signInPage(metadata: OAuthMetadata): OAuthMetadata {
  return { ...metadata, authorizationEndpoint: new URL("/signin/", metadata.issuer).href };
}

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

const pendingSchema = z.object({
  verifier: z.string(),
  challenge: z.string(),
  method: z.literal("S256"),
  state: z.string(),
});

/** Where the round-trip state is kept; sessionStorage in the browser. */
export interface RoundTripStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthDependencies {
  readonly config: AppConfig;
  readonly origin: string;
  readonly storage: RoundTripStorage;
  readonly transport?: HttpTransport;
  readonly now?: () => number;
  readonly readRefreshState: () => Promise<RefreshState | null>;
  readonly withRefreshLock: <T>(account: string, run: () => Promise<T>) => Promise<T>;
  /** Seals the newest refresh token in the local store, or removes it (null). */
  readonly persist: (refreshToken: string | null) => Promise<void>;
  /** Called when the server no longer accepts the refresh token: the user must sign in again. */
  readonly onSignedOut: () => void;
}

/** The account identity and its newest token are read together from encrypted device state. */
export interface RefreshState {
  readonly account: string;
  readonly token: string;
}

export class AuthSession {
  readonly #deps: AuthDependencies;
  #metadata: OAuthMetadata | null = null;
  #tokens: TokenSet | null = null;
  #refreshing: Promise<TokenSet> | null = null;

  constructor(deps: AuthDependencies) {
    this.#deps = deps;
  }

  get signedIn(): boolean {
    return this.#tokens !== null;
  }

  /** A renewal is running; a reload now could lose the refresh token the server just rotated. */
  get refreshing(): boolean {
    return this.#refreshing !== null;
  }

  get username(): string | null {
    return this.#tokens?.username ?? null;
  }

  get sessionUrl(): string {
    return `${this.#deps.config.apiUrl}/jmap/session`;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  async metadata(): Promise<OAuthMetadata> {
    this.#metadata ??= await discover(this.#deps.config.apiUrl, this.#deps.transport);

    return this.#metadata;
  }

  /**
   * The URL of Kasten's sign-in page for a new sign-in; the round-trip state is saved first. The
   * mail server serves that page at /signin/ (server/signin/) in place of Stalwart's /login,
   * which its discovery document still names.
   */
  async authorizeUrl(): Promise<string> {
    const metadata = await this.metadata();
    const request = await createAuthRequest();

    this.#deps.storage.setItem(PENDING_KEY, JSON.stringify(request));

    return buildAuthorizeUrl(signInPage(metadata), {
      clientId: this.#deps.config.oauthClientId,
      redirectUri: redirectUri(this.#deps.origin),
      request,
      scope: OAUTH_SCOPE,
    });
  }

  /** Drops the round-trip state of a sign-in that never came back, such as after Back. */
  discardPending(): void {
    this.#deps.storage.removeItem(PENDING_KEY);
  }

  /** Handles the redirect to /oauth/callback: checks state and issuer, then exchanges the code. */
  async completeSignIn(callbackUrl: string): Promise<TokenSet> {
    const raw = this.#deps.storage.getItem(PENDING_KEY);

    // The verifier is single-use: remove it whatever happens next.
    this.#deps.storage.removeItem(PENDING_KEY);

    if (raw === null) {
      throw new KastenAuthError("stateMismatch", 0, "This sign-in was not started in this tab");
    }

    const pending: AuthRequest = pendingSchema.parse(JSON.parse(raw));
    const metadata = await this.metadata();
    const code = readAuthorizationResponse(callbackUrl, pending, metadata);

    const tokens = await exchangeCode(
      metadata,
      {
        clientId: this.#deps.config.oauthClientId,
        redirectUri: redirectUri(this.#deps.origin),
        code,
        request: pending,
      },
      this.#deps.transport,
    );

    await this.#adopt(tokens);

    return tokens;
  }

  /** Signs in again from a stored refresh token. */
  async resume(): Promise<TokenSet> {
    return this.#refresh();
  }

  async #adopt(tokens: TokenSet): Promise<void> {
    this.#tokens = tokens;

    if (tokens.refreshToken !== null) await this.#deps.persist(tokens.refreshToken);
  }

  #refresh(): Promise<TokenSet> {
    this.#refreshing ??= (async () => {
      let account: string | null = null;

      try {
        const initial = await this.#deps.readRefreshState();

        account = this.#tokens?.username ?? initial?.account ?? null;

        if (account === null || initial === null || initial.account !== account)
          throw new KastenAuthError("invalid_grant", 0, "Sign in again");

        const expectedAccount = account;

        return await this.#deps.withRefreshLock(expectedAccount, async () => {
          // Another tab may have rotated or removed it while this tab waited for the lock.
          const latest = await this.#deps.readRefreshState();

          if (latest === null || latest.account !== expectedAccount)
            throw new KastenAuthError("invalid_grant", 0, "Sign in again");

          const tokens = await refresh(
            await this.metadata(),
            this.#deps.config.oauthClientId,
            latest.token,
            this.#deps.transport,
          );

          if (tokens.username !== null && tokens.username !== expectedAccount)
            throw new KastenAuthError("invalid_grant", 0, "Sign in again");

          await this.#adopt(tokens);

          return tokens;
        });
      } catch (cause) {
        if (cause instanceof KastenAuthError && cause.code === "invalid_grant") {
          this.#tokens = null;
          const current = await this.#deps.readRefreshState();

          if (current === null || current.account === account) await this.#deps.persist(null);

          this.#deps.onSignedOut();
        }

        throw cause;
      } finally {
        this.#refreshing = null;
      }
    })();

    return this.#refreshing;
  }

  /** The Authorization header for JMAP, refreshing the access token when it is about to expire. */
  async authorization(): Promise<string> {
    let tokens = this.#tokens;

    if (tokens === null) throw new KastenAuthError("notSignedIn", 0, "Sign in first");

    if (tokens.expiresAt - this.#now() < REFRESH_MARGIN_MS && tokens.refreshToken !== null) {
      tokens = await this.#refresh();
    }

    return `Bearer ${tokens.accessToken}`;
  }

  /** After a 401: get a new access token now. */
  async forceRefresh(): Promise<void> {
    const token = this.#tokens?.refreshToken ?? null;

    if (token === null) throw new KastenAuthError("notSignedIn", 0, "Sign in first");

    await this.#refresh();
  }

  /**
   * Signs out: revokes the grant on the server (which ends every token of
   * this sign-in), then forgets the tokens here and in the local store.
   */
  async signOut(): Promise<void> {
    const token = this.#tokens?.refreshToken ?? this.#tokens?.accessToken ?? null;

    const account =
      this.#tokens?.username ?? (await this.#deps.readRefreshState())?.account ?? null;

    this.#tokens = null;

    const end = async (): Promise<void> => {
      const current = await this.#deps.readRefreshState();

      if (current !== null && current.account !== account) return;

      try {
        const latest = current?.token ?? token;

        if (latest !== null)
          await revoke(
            await this.metadata(),
            this.#deps.config.oauthClientId,
            latest,
            this.#deps.transport,
          );
      } finally {
        this.#tokens = null;
        await this.#deps.persist(null);
      }
    };

    if (account === null) await end();
    else await this.#deps.withRefreshLock(account, end);
  }

  /** Forgets the tokens in memory only, for example when the app locks. */
  forget(): void {
    this.#tokens = null;
  }
}

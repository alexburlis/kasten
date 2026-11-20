// A throwaway OAuth client for one test file, created and destroyed with the admin key, and a
// sign-in through the real login page that returns tokens. The dev client kasten-web is never
// touched.
import {
  buildAuthorizeUrl,
  createAuthRequest,
  discover,
  exchangeCode,
  readAuthorizationResponse,
  type OAuthMetadata,
  type TokenSet,
} from "../../../src/auth/index.ts";
import { JmapClient } from "../../../src/jmap/index.ts";
import { signIn } from "./login.ts";
import { adminCall, createdId, tag, type DevStack, type TestAccount } from "./stack.ts";

export const APP_SCOPE = "openid offline_access urn:ietf:params:oauth:scope:mail";

/** A JMAP client that presents an OAuth access token as a bearer token. */
export function tokenClient(stack: DevStack, accessToken: string): JmapClient {
  const authorization = async (): Promise<string> => ["Bearer", accessToken].join(" ");

  return new JmapClient({ sessionUrl: stack.sessionUrl, authorization });
}

export interface TestOAuthClient {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly metadata: OAuthMetadata;
  /** The x:OAuthClient id, for the admin API. */
  readonly objectId: string;
}

/** Creates a public client with one https redirect URI on a .test host that nothing serves. */
export async function createOAuthClient(stack: DevStack): Promise<TestOAuthClient> {
  const clientId = `core-live-${tag()}`;
  const redirectUri = `https://${clientId}.kasten.test/oauth/callback`;

  const response = await adminCall(stack, [
    [
      "x:OAuthClient/set",
      {
        create: {
          c: {
            clientId,
            description: "core live test client",
            redirectUris: { [redirectUri]: true },
            scopes: { mail: true },
            grantTypes: { authorizationCode: true, refreshToken: true },
            firstParty: false,
          },
        },
      },
      "0",
    ],
  ]);

  return {
    clientId,
    redirectUri,
    metadata: await discover(stack.issuer),
    objectId: createdId(response, "0", "x:OAuthClient/set", "c"),
  };
}

export async function destroyOAuthClient(
  stack: DevStack,
  client: TestOAuthClient | undefined,
): Promise<void> {
  if (client === undefined) return;

  await adminCall(stack, [["x:OAuthClient/set", { destroy: [client.objectId] }, "0"]]);
}

/** Signs `account` in on the real page and exchanges the code. */
export async function signInTokens(
  client: TestOAuthClient,
  account: TestAccount,
): Promise<{ readonly tokens: TokenSet; readonly consentAsked: boolean }> {
  const request = await createAuthRequest();

  const url = buildAuthorizeUrl(client.metadata, {
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    request,
    scope: APP_SCOPE,
  });

  const result = await signIn(url, account.email, account.password);
  const code = readAuthorizationResponse(result.location, request, client.metadata);

  return {
    tokens: await exchangeCode(client.metadata, {
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      code,
      request,
    }),
    consentAsked: result.consentAsked,
  };
}

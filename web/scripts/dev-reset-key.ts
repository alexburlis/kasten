// Development only: removes the dev user's key bundle from the local server, so the web app's
// first-run key setup can run again. Run from the repository root while the dev stack is up:
//   node web/scripts/dev-reset-key.ts
// It sets x:AccountSettings.encryptionAtRest to Disabled and destroys every x:PublicKey of
// you@kasten.test, with the dev admin key. Mail stored meanwhile stays encrypted to the old keys.
// Also clear the app's site data in the browser, or use "Clear this device" in Settings.
import { loadDevState, readServerBundle, resetServerKey } from "./dev-stack.ts";

const state = loadDevState();

const removed = await resetServerKey(state);

const after = await readServerBundle(state);

process.stdout.write(
  `${state.users.you.email}: removed ${removed} public key(s); encryptionAtRest is now ${after.type}.\n`,
);

# The README walkthrough

```sh
pnpm test:walkthrough
```

This test follows the [README](../../README.md)'s "Try it locally" exactly, with only the commands it names. It drives the web app in a real browser. It runs once in Chromium and then once in WebKit.

> **It deletes the dev stack's data.** Each run starts with `./kasten dev reset --yes`. The dev account, its key, its mail and `.kasten-dev/` are deleted. At the end the stack keeps running with the run's account, key, mail and lock: the dev OAuth client `kasten-web` is no longer first-party, and the web app's end-to-end tests need it first-party. Run `./kasten lock --undo --account you@kasten.test` to reverse the lock, or `./kasten dev reset --yes` and `./kasten dev up` for a fresh stack.

## What one run does

| Step                      | What the test does                                                                                                                             | What it checks                                                                                                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start from nothing        | `./kasten dev reset --yes`                                                                                                                     | Exit 0; `.kasten-dev/` is gone                                                                                                                                                                                                                                 |
| Start the stack           | `./kasten dev up`, timed                                                                                                                       | Exit 0; it prints the login: the account line, then the password. The test reads the password from that output and never prints it                                                                                                                             |
| 1. Sign in                | Opens <http://localhost:7480> and signs in on Stalwart's login page                                                                            | The app asks for a new key                                                                                                                                                                                                                                     |
| 2. Create the key         | Creates a key with a generated recovery code, saves the sheet with "Save as file", ticks the box, and skips passkey enrollment                 | The sheet shows the armored key, the first QR code's caption and a 40-hex-digit fingerprint; the saved file starts with the sheet title and holds the same recovery code, fingerprint and armored private key; Continue stays disabled until the box is ticked |
| 3. Test mail              | `./kasten dev mail`                                                                                                                            | All six messages land in the Inbox                                                                                                                                                                                                                             |
| 4. Read, search and reply | Opens the thread, searches for a body word, replies                                                                                            | Four conversations with decrypted text and no "Not encrypted" badge; the reply is in the outbox catcher's API (<http://localhost:7482>) and in Sent                                                                                                            |
| 5. Lock and check         | `./kasten lock`, `./kasten reader create` and `./kasten check`, each with `--account you@kasten.test`; then signs in again, as the README says | Each exits 0; after the new sign-in the mail still shows decrypted                                                                                                                                                                                             |
| Restart                   | `./kasten dev down`, then `./kasten dev up`, timed                                                                                             | `dev up` prints no new password; the app unlocks, the mail and the reply are still there, and `./kasten check` exits 0 again                                                                                                                                   |

The test prints the two `dev up` times, the printed login with the password masked, the key fingerprint and the end of the check's output.

## What it needs

- Docker with Compose v2, as the README says. `./kasten` uses the Docker engine that `DOCKER_CONTEXT` names, so set it when that is not your default, for example `DOCKER_CONTEXT=colima-kasten pnpm test:walkthrough`.
- Node 24, `pnpm install`, and the web package's Playwright browsers (`pnpm --filter @kasten/web exec playwright install chromium webkit`).
- Free ports 7480–7482, 7425 and 7414 on `127.0.0.1`.

One run of both browsers takes a few minutes once the images are built. The first `dev up` on a new machine builds the images and takes longer.

## Files

| File                   | What it is                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `walkthrough.spec.ts`  | The test. It reuses the sign-in, unlock and open-row steps of the web app's end-to-end tests (`web/e2e/support.ts`) |
| `playwright.config.ts` | One worker, Chromium then WebKit; no traces, because they would record the password and recovery code               |
| `tsconfig.json`        | Maps `@playwright/test` and `zod` to the web package's copies, for TypeScript and for Playwright's loader           |

Failure screenshots go to `test-results/walkthrough/` in the repository root, which git ignores.

To type-check the test: `pnpm exec tsc --noEmit -p tests/walkthrough/tsconfig.json`.

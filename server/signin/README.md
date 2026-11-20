# Kasten's sign-in page

The page where you type your account password and sign-in code. Stalwart serves it from the mail server at `/signin/`, in place of its built-in `/login` page, which shows Stalwart's logo and which Kasten's `allowedEndpoints` rule refuses with 403. The web app sends every sign-in here (`web/src/auth/session.ts`).

| File                | What it is                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `index.html`        | The page, with its Content Security Policy as a meta element                                                                   |
| `signin.js`         | The exchange with Stalwart's `/api/auth`, the same as `/login` runs: password, then the sign-in code or the consent when asked |
| `signin.css`        | The web app's task card, copied from `web/src/styles/app.css`; keep the two in step                                            |
| `stalwart-app.json` | The bundle manifest Stalwart requires                                                                                          |
| `build.sh`          | Packs the zip, with the script and stylesheet under content-hashed names                                                       |

The server image builds the zip and puts it at `/opt/kasten/kasten-signin.zip` (`server/Dockerfile`). `kasten setup` keeps the application `Kasten sign-in page` pointed at that file and runs `UpdateApps` on every normal run, so a new image's page is served after the next `kasten setup`. Until then, Stalwart serves the copy it cached. [docs/stalwart-v1.0.1.md](../../docs/stalwart-v1.0.1.md#kastens-sign-in-page) has the details and the evidence.

The bundle must never contain `oauth-client.json`: Stalwart would make it a first-party OAuth client that `kasten lock` cannot restrict.

Tests: `cli/test/integration/setup.test.ts` checks what the server serves, and `web/e2e/` signs in through the page in Chromium and WebKit.

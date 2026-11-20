// Kasten's sign-in page: the same exchange as Stalwart's built-in /login page, on the mail
// server's own origin, so the password never reaches the app host. It reads the authorization
// query the web app sent, asks /api/auth/client about it, then posts the email, password and,
// when asked, the sign-in code or the consent to /api/auth. Stalwart answers with the address to
// go back to, which carries the authorization code.
"use strict";

(function signInPage() {
  const FAILURE = "Couldn't reach your server. Try again.";
  const START_AGAIN = "This sign-in link has expired. Open Kasten and sign in again.";

  const $ = (id) => document.getElementById(id);
  const form = $("login-form");
  const consent = $("consent");
  const alertBox = $("alert");
  const submit = $("submit-btn");

  // The authorization request, byte for byte: Stalwart ties consent to a digest of it.
  const query = location.search.startsWith("?") ? location.search.slice(1) : location.search;

  /** The text of a reply field; "" when the reply lacks it. */
  const field = (value) => (value === undefined || value === null ? "" : String(value));

  /** The parts of a /api/auth reply this page uses (Stalwart's LoginResponse). */
  function readReply(json) {
    const reply = Object(json);

    return {
      type: field(reply.type),
      location: field(reply.location),
      token: field(reply.token),
      description: field(reply.description),
    };
  }

  /** The parts of a /api/auth/client reply this page uses (ClientInfo, or an error). */
  function readClient(json) {
    const info = Object(json);

    return {
      failed: field(info.error) !== "",
      redirect: info.redirect === true,
      location: field(info.location),
      description: field(info.description),
      name: field(info.name),
    };
  }

  let clientName = "Kasten";
  let credentials = null;
  let leaving = false;

  function showError(text) {
    alertBox.textContent = text;
    alertBox.hidden = false;
  }

  function clearError() {
    alertBox.hidden = true;
    alertBox.textContent = "";
  }

  /** Ends the page: nothing more can be done here. */
  function stop(text) {
    form.hidden = true;
    consent.hidden = true;
    $("title").textContent = "Can't sign in here";
    showError(text);
  }

  /** Goes back to the app. Only an http(s) address from the server is followed. */
  function navigate(target) {
    let url = null;

    try {
      url = new URL(target);
    } catch {
      url = null;
    }

    if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
      stop(FAILURE);

      return;
    }

    leaving = true;
    location.assign(url.href);
  }

  function askPassword() {
    credentials = null;
    $("field-username").hidden = false;
    $("field-password").hidden = false;
    $("field-otp").hidden = true;
    $("otp").value = "";
    $("password").value = "";
    submit.textContent = "Sign in";
    $("title").textContent = "Sign in";
    form.hidden = false;
    consent.hidden = true;
    ($("username").value === "" ? $("username") : $("password")).focus();
  }

  function askCode() {
    $("field-username").hidden = true;
    $("field-password").hidden = true;
    $("field-otp").hidden = false;
    submit.textContent = "Continue";
    $("title").textContent = "Enter your sign-in code";
    $("otp").focus();
  }

  function askConsent(token) {
    if (token === "") {
      stop(FAILURE);

      return;
    }

    credentials = null;
    $("password").value = "";
    $("otp").value = "";
    form.hidden = true;
    $("title").textContent = `Allow ${clientName}?`;
    $("consent-text").textContent = `${clientName} can then read and send your mail.`;
    consent.hidden = false;
    $("allow-btn").focus();

    const decide = (allow) => {
      $("allow-btn").disabled = true;
      $("deny-btn").disabled = true;
      void post({ type: "authConsent", token, query, consent: allow }).then(() => {
        if (leaving) return;

        $("allow-btn").disabled = false;
        $("deny-btn").disabled = false;
      });
    };

    $("allow-btn").onclick = () => decide(true);
    $("deny-btn").onclick = () => decide(false);
  }

  function handle(reply) {
    switch (reply.type) {
      case "authenticated":
      case "redirect":
        navigate(reply.location);

        return;
      case "mfaRequired":
        askCode();

        return;
      case "consentRequired":
        askConsent(reply.token);

        return;
      case "failure": {
        const hadCode = credentials !== null && !$("field-otp").hidden;

        askPassword();
        showError(
          hadCode
            ? "That code is not right. Sign in again."
            : "That email or password is not right.",
        );

        return;
      }

      case "expired":
        askPassword();
        showError("Your password has expired. Ask your operator for a new one.");

        return;
      case "invalid":
        stop(reply.description === "" ? START_AGAIN : reply.description);

        return;
      default:
        showError(FAILURE);
    }
  }

  async function post(body) {
    submit.disabled = true;

    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });

      if (response.status === 200) handle(readReply(await response.json()));
      else showError(FAILURE);
    } catch {
      showError(FAILURE);
    } finally {
      submit.disabled = false;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearError();

    if (credentials !== null && !$("field-otp").hidden) {
      const code = $("otp").value.replace(/\s/gu, "");

      if (code === "") {
        showError("Enter the code from your authenticator app.");

        return;
      }

      void post({ type: "authCode", ...credentials, mfaToken: code, query });

      return;
    }

    const accountName = $("username").value.trim();
    const accountSecret = $("password").value;

    if (accountName === "" || accountSecret === "") {
      showError("Enter your email and password.");

      return;
    }

    credentials = { accountName, accountSecret };
    void post({ type: "authCode", accountName, accountSecret, query });
  });

  async function start() {
    if (query === "") {
      stop("Open Kasten and sign in from there.");

      return;
    }

    const hint = new URLSearchParams(query).get("login_hint");

    if (hint !== null) $("username").value = hint;

    try {
      const response = await fetch(`/api/auth/client?${query}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });

      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);

      const client = readClient(await response.json());

      if (client.failed && client.redirect) {
        navigate(client.location);
      } else if (client.failed) {
        stop(client.description === "" ? START_AGAIN : client.description);
      } else {
        if (client.name !== "") clientName = client.name;

        askPassword();
      }
    } catch {
      stop(FAILURE);
    }
  }

  // Nothing here may be shown inside another site's frame.
  if (window.top !== window.self) {
    document.body.textContent = "";

    return;
  }

  void start();
})();

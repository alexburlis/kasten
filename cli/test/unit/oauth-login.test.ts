// How the scripted sign-in reports an answer other than "authenticated".
import { describe, expect, it } from "vitest";

import { signInEnd } from "../../src/oauth-login.ts";

describe("the scripted sign-in's end", () => {
  it("names the status and title of an HTTP problem, such as Stalwart's rate limit", () => {
    // The body Stalwart v1.0.1 answered to the 101st anonymous request in a minute.
    const limited = {
      type: "about:blank",
      status: 429,
      title: "Too Many Requests",
      detail: "Your request has been rate limited. Please try again in a few seconds.",
    };

    expect(signInEnd(limited)).toBe(
      "HTTP 429 Too Many Requests: Your request has been rate limited. Please try again in a few seconds.",
    );
    expect(signInEnd({ type: "about:blank", status: 401, title: "Unauthorized" })).toBe(
      "HTTP 401 Unauthorized",
    );
  });

  it("names the type of any other answer", () => {
    expect(signInEnd({ type: "failure" })).toBe("failure");
  });
});

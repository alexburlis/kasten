import { describe, expect, it } from "vitest";

import {
  forgetQueries,
  INBOX,
  isRouteState,
  parseRoute,
  queryOf,
  routePath,
  routeThread,
  stateOf,
  withThread,
  type Route,
} from "../src/state/route.ts";

/** Builds the route's path and history state, then reads them back the way the app does. */
function roundTrip(route: Route): Route {
  const url = new URL(routePath(route), "https://kasten.test");

  return parseRoute(url.pathname, url.search, queryOf(stateOf(route)));
}

const ROUTES: readonly (readonly [string, Route])[] = [
  ["the Inbox", INBOX],
  ["a conversation in the Inbox", { name: "mailbox", mailboxId: null, threadId: "T1" }],
  ["a mailbox", { name: "mailbox", mailboxId: "M1", threadId: null }],
  ["a conversation in a mailbox", { name: "mailbox", mailboxId: "M1", threadId: "T1" }],
  ["ids that need encoding", { name: "mailbox", mailboxId: "a/b c?é", threadId: "t#1/2%" }],
  ["Starred", { name: "starred", threadId: null }],
  ["a conversation in Starred", { name: "starred", threadId: "T/2" }],
  ["a search", { name: "search", query: 'from:"Priya Shah" & 10:30 #tag', threadId: null }],
  ["a conversation in a search", { name: "search", query: "café", threadId: "T3" }],
  ["an empty search", { name: "search", query: "", threadId: null }],
  ["Drafts", { name: "drafts" }],
  ["the Outbox", { name: "outbox" }],
  ["Settings", { name: "settings", section: "general" }],
  ["Security settings", { name: "settings", section: "security" }],
  ["the sign-in callback", { name: "callback" }],
];

describe("parseRoute and routePath", () => {
  it.each(ROUTES)("round-trips %s", (_name, route) => {
    expect(roundTrip(route)).toEqual(route);
  });

  it.each([
    [INBOX, "/"],
    [{ name: "mailbox", mailboxId: null, threadId: "T1" }, "/?thread=T1"],
    [{ name: "mailbox", mailboxId: "M1", threadId: "T1" }, "/mailbox/M1/thread/T1"],
    [{ name: "starred", threadId: "T1" }, "/starred/thread/T1"],
    [{ name: "search", query: "a b", threadId: "T1" }, "/search?thread=T1"],
    [{ name: "search", query: "secret words", threadId: null }, "/search"],
    [{ name: "settings", section: "general" }, "/settings"],
    [{ name: "settings", section: "security" }, "/settings/security"],
    [{ name: "callback" }, "/oauth/callback"],
  ] satisfies [Route, string][])("writes %j as %s", (route, path) => {
    expect(routePath(route)).toBe(path);
  });

  it("reads the callback with its query and ignores other oauth paths", () => {
    expect(parseRoute("/oauth/callback", "?code=abc&state=xyz")).toEqual({ name: "callback" });
    expect(parseRoute("/oauth/other")).toEqual(INBOX);
  });

  it("shows the Inbox for unknown paths", () => {
    expect(parseRoute("/nope")).toEqual(INBOX);
    expect(parseRoute("/mailbox")).toEqual(INBOX);
  });

  it("shows general settings for an unknown section", () => {
    expect(parseRoute("/settings/unknown")).toEqual({ name: "settings", section: "general" });
  });

  it("ignores empty path parts", () => {
    expect(parseRoute("//mailbox//M1//thread//T1/")).toEqual({
      name: "mailbox",
      mailboxId: "M1",
      threadId: "T1",
    });
  });

  it("ignores a thread part without an id, or a part that is not thread", () => {
    expect(parseRoute("/mailbox/M1/thread")).toEqual({
      name: "mailbox",
      mailboxId: "M1",
      threadId: null,
    });
    expect(parseRoute("/mailbox/M1/other/T1")).toEqual({
      name: "mailbox",
      mailboxId: "M1",
      threadId: null,
    });
  });

  it("treats bad percent-encoding as no id", () => {
    expect(parseRoute("/mailbox/%E0%A4%A")).toEqual(INBOX);
    expect(parseRoute("/mailbox/M1/thread/%")).toEqual({
      name: "mailbox",
      mailboxId: "M1",
      threadId: null,
    });
    expect(parseRoute("/starred/thread/%ZZ")).toEqual({ name: "starred", threadId: null });
  });
});

describe("routeThread and withThread", () => {
  it("reads the open thread of list routes only", () => {
    expect(routeThread({ name: "mailbox", mailboxId: "M1", threadId: "T1" })).toBe("T1");
    expect(routeThread({ name: "starred", threadId: "T2" })).toBe("T2");
    expect(routeThread({ name: "search", query: "x", threadId: "T3" })).toBe("T3");
    expect(routeThread(INBOX)).toBeNull();
    expect(routeThread({ name: "drafts" })).toBeNull();
    expect(routeThread({ name: "settings", section: "security" })).toBeNull();
  });

  it("opens and closes a thread, keeping the rest of the route", () => {
    const search: Route = { name: "search", query: "from:sam", threadId: null };

    expect(withThread(search, "T1")).toEqual({ name: "search", query: "from:sam", threadId: "T1" });
    expect(withThread({ name: "starred", threadId: "T1" }, null)).toEqual({
      name: "starred",
      threadId: null,
    });
    expect(withThread(INBOX, "T9")).toEqual({ name: "mailbox", mailboxId: null, threadId: "T9" });
  });

  it("returns routes without a thread unchanged", () => {
    const outbox: Route = { name: "outbox" };

    expect(withThread(outbox, "T1")).toBe(outbox);
    expect(withThread({ name: "callback" }, "T1")).toEqual({ name: "callback" });
  });
});

describe("search state", () => {
  it("keeps the query out of the URL and out of history.state", () => {
    const route: Route = { name: "search", query: "from:sam biopsy", threadId: null };
    const state = stateOf(route);

    expect(routePath(route)).not.toContain("biopsy");
    expect(JSON.stringify(state)).not.toContain("biopsy");
    expect(queryOf(state)).toEqual({ query: "from:sam biopsy" });
    expect(stateOf(INBOX)).toBeNull();
  });

  it("forgets the queries on lock: the history entry then reads as an empty search", () => {
    const state = stateOf({ name: "search", query: "biopsy", threadId: null });

    forgetQueries();
    expect(queryOf(state)).toEqual({ query: "" });
  });

  it("keeps only the newest 50 queries", () => {
    const first = stateOf({ name: "search", query: "first", threadId: null });

    for (let index = 0; index < 50; index += 1)
      stateOf({ name: "search", query: `q${index}`, threadId: null });

    expect(queryOf(first)).toEqual({ query: "" });
  });

  it("reads a search without its state as an empty query", () => {
    expect(parseRoute("/search")).toEqual({ name: "search", query: "", threadId: null });
  });

  it("checks history.state before using it", () => {
    expect(isRouteState({ search: "unknown" })).toBe(true);
    expect(queryOf({ search: "unknown" })).toEqual({ query: "" });
    expect(isRouteState({ search: 3 })).toBe(false);
    // The old shape, with the query itself, is not read.
    expect(isRouteState({ query: "x" })).toBe(false);
    expect(isRouteState(null)).toBe(false);
    expect(isRouteState("x")).toBe(false);
    expect(queryOf(null)).toBeNull();
  });

  it("treats an empty thread parameter as no thread", () => {
    expect(parseRoute("/", "?thread=")).toEqual(INBOX);
  });
});

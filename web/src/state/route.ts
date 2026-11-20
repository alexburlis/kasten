// Path routing with the History API. Every path serves index.html (the image's SPA fallback).
//
//   /, /?thread=<id>               the Inbox, and a conversation in it
//   /mailbox/<id>                  a mailbox
//   /mailbox/<id>/thread/<id>      a conversation in it
//   /starred, /starred/thread/<id>
//   /search[?thread=<id>]          the query stays in page memory; history.state holds only a
//                                  random reference to it, so search words stay out of the URL,
//                                  browser history, history sync and the browser's saved session
//   /drafts, /outbox               this device's drafts and unsent mail
//   /settings, /settings/security
import { z } from "zod";

export type SettingsSection = "general" | "security";

export type Route =
  | {
      readonly name: "mailbox";
      /** Null shows the Inbox. */
      readonly mailboxId: string | null;
      readonly threadId: string | null;
    }
  | { readonly name: "starred"; readonly threadId: string | null }
  | { readonly name: "search"; readonly query: string; readonly threadId: string | null }
  | { readonly name: "drafts" }
  | { readonly name: "outbox" }
  | { readonly name: "settings"; readonly section: SettingsSection }
  | { readonly name: "callback" };

function decode(part: string | null | undefined): string | null {
  if (part === undefined || part === null || part === "") return null;

  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** A search's query, as parseRoute takes it. */
export interface RouteQuery {
  readonly query: string;
}

/** What a route keeps in history.state: a random reference to its search query, never the query. */
const routeState = z.object({ search: z.string() });

export type RouteState = z.infer<typeof routeState>;

/** The queries history entries refer to, in page memory only: a reload or a lock forgets them. */
const queries = new Map<string, string>();

/** The most queries kept; older history entries come back as empty searches. */
const MAX_QUERIES = 50;

/** The history.state to push with a route. */
export function stateOf(route: Route): RouteState | null {
  if (route.name !== "search") return null;

  const search = crypto.randomUUID();

  queries.set(search, route.query);

  for (const oldest of queries.keys()) {
    if (queries.size <= MAX_QUERIES) break;

    queries.delete(oldest);
  }

  return { search };
}

/** history.state as a route left it, checked, since another page may have set it. */
export function isRouteState(value: unknown): value is RouteState {
  return routeState.safeParse(value).success;
}

/** The query a history entry refers to: empty when this page no longer knows it. */
export function queryOf(state: RouteState | null): RouteQuery | null {
  return state === null ? null : { query: queries.get(state.search) ?? "" };
}

/** Forgets every search query, as the app locks. */
export function forgetQueries(): void {
  queries.clear();
}

export function parseRoute(pathname: string, search = "", state: RouteQuery | null = null): Route {
  const parts = pathname.split("/").filter((part) => part !== "");
  const params = new URLSearchParams(search);

  const threadAt = (index: number): string | null =>
    parts[index] === "thread" ? decode(parts[index + 1]) : null;

  switch (parts[0]) {
    case undefined:
      return { name: "mailbox", mailboxId: null, threadId: decode(params.get("thread")) };
    case "oauth":
      return parts[1] === "callback" ? { name: "callback" } : INBOX;
    case "settings":
      return { name: "settings", section: parts[1] === "security" ? "security" : "general" };
    case "starred":
      return { name: "starred", threadId: threadAt(1) };
    case "search":
      return {
        name: "search",
        query: state?.query ?? "",
        threadId: decode(params.get("thread")),
      };
    case "drafts":
      return { name: "drafts" };
    case "outbox":
      return { name: "outbox" };
    case "mailbox": {
      const mailboxId = decode(parts[1]);

      return mailboxId === null ? INBOX : { name: "mailbox", mailboxId, threadId: threadAt(2) };
    }

    default:
      return INBOX;
  }
}

export const INBOX: Route = { name: "mailbox", mailboxId: null, threadId: null };

function threadPart(threadId: string | null): string {
  return threadId === null ? "" : `/thread/${encodeURIComponent(threadId)}`;
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "callback":
      return "/oauth/callback";
    case "settings":
      return route.section === "general" ? "/settings" : `/settings/${route.section}`;
    case "starred":
      return `/starred${threadPart(route.threadId)}`;
    case "search":
      return route.threadId === null
        ? "/search"
        : `/search?${new URLSearchParams({ thread: route.threadId }).toString()}`;

    case "drafts":
      return "/drafts";
    case "outbox":
      return "/outbox";
    case "mailbox":
      if (route.mailboxId === null) {
        return route.threadId === null
          ? "/"
          : `/?${new URLSearchParams({ thread: route.threadId }).toString()}`;
      }

      return `/mailbox/${encodeURIComponent(route.mailboxId)}${threadPart(route.threadId)}`;
  }
}

/** The open thread of a route, if it shows one. */
export function routeThread(route: Route): string | null {
  switch (route.name) {
    case "mailbox":
    case "starred":
    case "search":
      return route.threadId;
    default:
      return null;
  }
}

/** The same list with another thread open (or none). */
export function withThread(route: Route, threadId: string | null): Route {
  switch (route.name) {
    case "mailbox":
    case "starred":
    case "search":
      return { ...route, threadId };
    default:
      return route;
  }
}

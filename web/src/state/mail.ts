// Mail actions on threads: read, star, archive, move, delete, with optimistic updates that roll
// back on a refusal; selection and the keyboard cursor; threads, attachments and inline images.
import { KastenJmapError, type JsonObject } from "@kasten/core/jmap";
import {
  destroyEmails,
  MAIL_USING,
  setKeywords,
  updateEmails,
  type Mailbox,
} from "@kasten/core/mail";
import { z } from "zod";

import { isPreviewImage, safeFilename } from "../lib/files.ts";
import type { EmailRecord, MessageView } from "../store/records.ts";
import { mailboxView, starredView, type ListView } from "../sync/list.ts";
import type { AppContext } from "./context.ts";
import { isStarred, isUnread, withHidden, withKeyword, withoutKeyword } from "./overlay.ts";
import { routeThread, withThread, type Route } from "./route.ts";
import type { AppState } from "./store.ts";

const mailboxUpdated = z.object({
  notUpdated: z.record(z.string(), z.object({ type: z.string() })).nullish(),
});

const mailboxCreated = z.object({
  created: z.record(z.string(), z.object({ id: z.string() })).nullish(),
  notCreated: z.record(z.string(), z.object({ type: z.string() })).nullish(),
});

/** Raw stored messages kept in memory for attachments; small, because each may be large. */
const RAW_CACHE = 3;

export type MailboxPatch = Readonly<Record<string, true | null>>;

/**
 * Where the keyboard cursor goes when the threads in `leaving` leave the list `visible`: the next
 * thread that stays, else the nearest one before it. A cursor on a thread that stays does not move.
 */
export function cursorAfter(
  visible: readonly string[],
  leaving: ReadonlySet<string>,
  cursor: string | null,
): string | null {
  if (cursor === null || !leaving.has(cursor)) return cursor;

  const index = visible.indexOf(cursor);

  return (
    visible.slice(index + 1).find((id) => !leaving.has(id)) ??
    visible
      .slice(0, Math.max(0, index))
      .reverse()
      .find((id) => !leaving.has(id)) ??
    null
  );
}

export function mailboxByRole(mailboxes: readonly Mailbox[], role: string): Mailbox | null {
  return mailboxes.find((mailbox) => mailbox.role === role) ?? null;
}

/** The list a route shows, or null for screens without one (drafts, outbox, search, settings). */
export function listViewFor(route: Route, mailboxes: readonly Mailbox[]): ListView | null {
  if (route.name === "mailbox") {
    const id = route.mailboxId ?? mailboxByRole(mailboxes, "inbox")?.id ?? null;

    return id === null ? null : mailboxView(id);
  }

  if (route.name === "starred") {
    return starredView(
      ["trash", "junk"].flatMap((role) => mailboxByRole(mailboxes, role)?.id ?? []),
    );
  }

  return null;
}

/** The mailbox the visible list shows, or null for Starred and search. */
export function currentMailboxId(state: AppState): string | null {
  const { route } = state;

  if (route.name !== "mailbox") return null;

  return route.mailboxId ?? mailboxByRole(state.mailboxes, "inbox")?.id ?? null;
}

const OFFLINE = "Couldn't reach your server. Try again when you're back online.";

function isOffline(error: unknown): error is KastenJmapError {
  return error instanceof KastenJmapError && error.type === "network";
}

export class MailController {
  readonly #ctx: AppContext;
  /** Raw stored messages by email id, newest use last. */
  readonly #raw = new Map<string, Uint8Array<ArrayBuffer>>();
  /** Inline images (Content-ID to blob: URL) per email of the open thread. */
  readonly #inline = new Map<
    string,
    {
      readonly inline: ReadonlyMap<string, string>;
      readonly previews: ReadonlyMap<number, string>;
    }
  >();
  /** The Archive folder being made, shared by archives that start before it exists. */
  #archiveFolder: Promise<string> | null = null;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  get #state(): AppState {
    return this.#ctx.store.state;
  }

  #update(patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void {
    this.#ctx.store.update(patch);
  }

  // --- selection, cursor and navigation ----------------------------------------------------

  /** Visible thread ids of the current list, in order (hidden ones left out). */
  visibleThreads(): string[] {
    const state = this.#state;

    if (state.route.name === "search") {
      return [
        ...new Set(
          (state.search.items ?? []).flatMap((item) =>
            state.overlay.hidden.has(item.threadId) ? [] : [item.threadId],
          ),
        ),
      ];
    }

    return state.list.items.flatMap((item) =>
      state.overlay.hidden.has(item.row.threadId) ? [] : [item.row.threadId],
    );
  }

  toggleSelect(threadId: string): void {
    this.#update((state) => ({
      selection: state.selection.includes(threadId)
        ? state.selection.filter((id) => id !== threadId)
        : [...state.selection, threadId],
    }));
  }

  selectAll(): void {
    this.#update({ selection: this.visibleThreads() });
  }

  clearSelection(): void {
    if (this.#state.selection.length > 0) this.#update({ selection: [] });
  }

  setCursor(threadId: string | null): void {
    this.#update({ cursor: threadId });
  }

  /** j and k: moves the cursor in the list, or opens the next or previous thread. */
  step(direction: 1 | -1): void {
    const threads = this.visibleThreads();

    if (threads.length === 0) return;

    const open = routeThread(this.#state.route);
    const from = open ?? this.#state.cursor;
    const index = from === null ? -1 : threads.indexOf(from);

    const next =
      threads[
        index === -1
          ? direction === 1
            ? 0
            : threads.length - 1
          : Math.min(threads.length - 1, Math.max(0, index + direction))
      ] ?? null;

    if (next === null) return;

    this.#update({ cursor: next });

    if (open !== null && next !== open) this.openThread(next, true);
  }

  openThread(threadId: string, replace = false): void {
    this.#update({ cursor: threadId });
    this.#ctx.navigate(withThread(this.#state.route, threadId), replace);
  }

  closeThread(): void {
    const route = this.#state.route;

    if (routeThread(route) !== null) this.#ctx.navigate(withThread(route, null));
  }

  /** The thread a keyboard action means: the open one, else the selection, else the cursor. */
  targetThreads(): string[] {
    const state = this.#state;
    const open = routeThread(state.route);

    if (open !== null) return [open];

    // Only conversations on screen: a selection or cursor from another list never counts.
    const visible = new Set(this.visibleThreads());
    const selected = state.selection.filter((id) => visible.has(id));

    if (selected.length > 0) return selected;

    return state.cursor === null || !visible.has(state.cursor) ? [] : [state.cursor];
  }

  async loadMore(): Promise<void> {
    const engine = this.#ctx.engine();

    if (engine === null || !this.#state.list.more || this.#state.list.loadingMore) return;

    this.#update((state) => ({ list: { ...state.list, loadingMore: true } }));

    try {
      await engine.loadMore();
    } catch {
      this.#ctx.ui.toast("Couldn't load more messages.", { tone: "error" });
    } finally {
      this.#update((state) => ({ list: { ...state.list, loadingMore: false } }));
    }
  }

  // --- threads ------------------------------------------------------------------------------

  /** The email ids of threads, from the list or search when they show them, else the server. */
  async threadEmails(threadId: string): Promise<string[]> {
    const engine = this.#ctx.engine();

    if (engine === null) return [];

    const row = this.#state.list.items.find((item) => item.row.threadId === threadId)?.row;

    const fromSearch = (this.#state.search.items ?? []).flatMap((item) =>
      item.threadId === threadId ? [item.record.summary.id] : [],
    );

    const known = row?.emailIds ?? (fromSearch.length > 0 ? fromSearch : null);

    try {
      return await engine.threadEmailIds(threadId, known);
    } catch {
      return known === null ? [] : [...known];
    }
  }

  /** The saved records and decrypted messages of a thread's emails, oldest first. */
  async loadMessages(ids: readonly string[]): Promise<{
    readonly records: readonly EmailRecord[];
    readonly views: ReadonlyMap<string, MessageView>;
  }> {
    const engine = this.#ctx.engine();

    if (engine === null) return { records: [], views: new Map() };

    const records = (await engine.records(ids)).filter(
      (record): record is EmailRecord => record !== null,
    );

    records.sort((a, b) => a.summary.receivedAt.localeCompare(b.summary.receivedAt));

    const views = await engine.views(records.map((record) => record.summary.id));
    const byId = new Map<string, MessageView>();

    for (const view of views) if (view !== null) byId.set(view.emailId, view);

    return { records, views: byId };
  }

  /** Marks the unread emails of an open thread as read, without a message. */
  async markOpened(records: readonly EmailRecord[]): Promise<void> {
    const unread = records.flatMap((record) =>
      isUnread(record.summary, this.#state.overlay) ? [record.summary.id] : [],
    );

    if (unread.length > 0) await this.#keyword(unread, "$seen", true, null);
  }

  // --- flags --------------------------------------------------------------------------------

  async #emailsOf(threadIds: readonly string[]): Promise<EmailRecord[]> {
    const engine = this.#ctx.engine();

    if (engine === null) return [];

    const ids = (await Promise.all(threadIds.map((id) => this.threadEmails(id)))).flat();

    return (await engine.records(ids)).filter((record): record is EmailRecord => record !== null);
  }

  /** Read (true) or unread (false), for every email of the threads. */
  async setRead(threadIds: readonly string[], read: boolean): Promise<void> {
    const records = await this.#emailsOf(threadIds);

    // Unread marks the newest email only, as other mail apps do.
    const ids = read
      ? records.map((record) => record.summary.id)
      : this.#newest(records).map((record) => record.summary.id);

    await this.#keyword(
      ids,
      "$seen",
      read,
      read ? "Couldn't mark as read." : "Couldn't mark as unread.",
    );
  }

  async toggleRead(threadIds: readonly string[]): Promise<void> {
    const records = await this.#emailsOf(threadIds);
    const anyUnread = records.some((record) => isUnread(record.summary, this.#state.overlay));

    await this.setRead(threadIds, anyUnread);
  }

  /** Stars the newest email of each thread, or unstars every email when one is starred. */
  async toggleStar(threadIds: readonly string[]): Promise<void> {
    const records = await this.#emailsOf(threadIds);
    const starred = records.filter((record) => isStarred(record.summary, this.#state.overlay));

    if (starred.length > 0) {
      await this.#keyword(
        starred.map((record) => record.summary.id),
        "$flagged",
        false,
        "Couldn't remove the star.",
      );

      return;
    }

    await this.#keyword(
      this.#newest(records).map((record) => record.summary.id),
      "$flagged",
      true,
      "Couldn't star it.",
    );
  }

  #newest(records: readonly EmailRecord[]): EmailRecord[] {
    const byThread = new Map<string, EmailRecord>();

    for (const record of records) {
      const current = byThread.get(record.summary.threadId);

      if (current === undefined || record.summary.receivedAt > current.summary.receivedAt)
        byThread.set(record.summary.threadId, record);
    }

    return [...byThread.values()];
  }

  /** Shows the keyword change at once; the server's answer confirms it or rolls it back. */
  async #keyword(
    emailIds: readonly string[],
    keyword: string,
    on: boolean,
    failure: string | null,
  ): Promise<void> {
    const account = this.#ctx.account();
    const engine = this.#ctx.engine();

    if (account === null || engine === null || emailIds.length === 0) return;

    this.#update((state) => ({ overlay: withKeyword(state.overlay, emailIds, keyword, on) }));

    try {
      const outcome = await setKeywords(
        account,
        emailIds,
        on ? [keyword] : [],
        on ? [] : [keyword],
      );

      if (outcome.failed.size > 0) throw new Error("The server refused the change");

      // Keep the patch until the saved records show the server's new state.
      await engine.catchUp();
    } catch (error) {
      if (failure !== null)
        this.#ctx.ui.toast(isOffline(error) ? OFFLINE : failure, { tone: "error" });
    } finally {
      this.#update((state) => ({
        overlay: withoutKeyword(state.overlay, emailIds, keyword, on),
      }));
    }
  }

  // --- moves --------------------------------------------------------------------------------

  async #updateMailboxes(patches: ReadonlyMap<string, MailboxPatch>): Promise<void> {
    const account = this.#ctx.account();

    if (account === null) throw new Error("Not signed in");

    const update = new Map<string, JsonObject>();

    for (const [id, patch] of patches) {
      update.set(
        id,
        Object.fromEntries(
          Object.entries(patch).map(([mailboxId, on]) => [`mailboxIds/${mailboxId}`, on]),
        ),
      );
    }

    // A selection can hold more emails than one Email/set may name; updateEmails batches them.
    const outcome = await updateEmails(account, update);

    if (outcome.failed.size > 0) throw new Error("The server refused the move");
  }

  /**
   * Moves threads out of the visible list at once. `plan` gives each email's mailbox patch and its
   * inverse, for Undo. The server's refusal brings the threads back with a short error.
   */
  async #move(
    threadIds: readonly string[],
    plan: (record: EmailRecord) => { forward: MailboxPatch; back: MailboxPatch } | null,
    texts: { readonly done: string; readonly failed: string },
    undoable: boolean,
  ): Promise<void> {
    const engine = this.#ctx.engine();

    if (engine === null || threadIds.length === 0) return;

    // A mailbox lists only threads it holds, so they leave it: hide them before the stored mail is
    // read, which can take a few hundred milliseconds. Starred and search hide them once the plan
    // shows that they move.
    const early = currentMailboxId(this.#state) !== null;
    const visible = this.visibleThreads();

    const hide = (hidden: boolean): void =>
      this.#update((state) => ({ overlay: withHidden(state.overlay, threadIds, hidden) }));

    if (early) hide(true);

    try {
      const records = await this.#emailsOf(threadIds);
      const forward = new Map<string, MailboxPatch>();
      const back = new Map<string, MailboxPatch>();

      for (const record of records) {
        const step = plan(record);

        if (step === null) continue;

        forward.set(record.summary.id, step.forward);
        back.set(record.summary.id, step.back);
      }

      if (forward.size === 0) return;

      this.#leave(threadIds, visible);
      hide(true);
      await this.#updateMailboxes(forward);
      this.#ctx.ui.toast(
        texts.done,
        undoable
          ? {
              action: {
                label: "Undo",
                run: () => this.#undo(back, threadIds),
              },
            }
          : {},
      );
      await engine.catchUp();
    } catch (error) {
      this.#ctx.ui.toast(isOffline(error) ? OFFLINE : texts.failed, { tone: "error" });
    } finally {
      hide(false);
    }
  }

  async #undo(
    back: ReadonlyMap<string, MailboxPatch>,
    threadIds: readonly string[],
  ): Promise<void> {
    try {
      await this.#updateMailboxes(back);
      this.#ctx.ui.toast(threadIds.length === 1 ? "Moved back." : "Moved back.");
      await this.#ctx.engine()?.catchUp();
    } catch (error) {
      this.#ctx.ui.toast(isOffline(error) ? OFFLINE : "Couldn't undo that.", { tone: "error" });
    }
  }

  /**
   * Clears the selection of threads that leave, moves the cursor off them and closes the thread if
   * it is one of them. `visible` is the list as it was before they were hidden.
   */
  #leave(threadIds: readonly string[], visible: readonly string[] = this.visibleThreads()): void {
    const leaving = new Set(threadIds);
    const state = this.#state;
    const open = routeThread(state.route);

    this.#update({
      selection: state.selection.filter((id) => !leaving.has(id)),
      cursor: cursorAfter(visible, leaving, state.cursor),
    });

    if (open !== null && leaving.has(open)) this.#ctx.navigate(withThread(state.route, null));
  }

  /** The mailbox an action moves mail out of: the one shown, or the Inbox in Starred and search. */
  #source(): string | null {
    return (
      currentMailboxId(this.#state) ?? mailboxByRole(this.#state.mailboxes, "inbox")?.id ?? null
    );
  }

  async archive(threadIds: readonly string[]): Promise<void> {
    const from = this.#source();
    let archive: string;

    try {
      archive = await this.#ensureArchive();
    } catch (error) {
      this.#ctx.ui.toast(isOffline(error) ? OFFLINE : "Couldn't create the Archive folder.", {
        tone: "error",
      });

      return;
    }

    if (from === null || from === archive) return;

    await this.#move(
      threadIds,
      (record) =>
        record.summary.mailboxIds[from] === true
          ? { forward: { [from]: null, [archive]: true }, back: { [archive]: null, [from]: true } }
          : null,
      {
        done:
          threadIds.length === 1
            ? "Conversation archived."
            : `${threadIds.length} conversations archived.`,
        failed: "Couldn't archive.",
      },
      true,
    );
  }

  /** Moves threads to another mailbox. */
  async moveTo(threadIds: readonly string[], to: string): Promise<void> {
    const from = this.#source();
    const target = this.#state.mailboxes.find((mailbox) => mailbox.id === to);

    if (from === null || target === undefined || from === to) return;

    await this.#move(
      threadIds,
      (record) =>
        record.summary.mailboxIds[from] === true
          ? { forward: { [from]: null, [to]: true }, back: { [to]: null, [from]: true } }
          : null,
      {
        done: `Moved to ${target.role === "inbox" ? "Inbox" : target.name}.`,
        failed: "Couldn't move it.",
      },
      true,
    );
  }

  /** Moves whole threads to Trash; in Trash and Spam, deletes them for good after asking. */
  async trash(threadIds: readonly string[]): Promise<void> {
    const trash = mailboxByRole(this.#state.mailboxes, "trash");
    const current = currentMailboxId(this.#state);
    const currentRole = this.#state.mailboxes.find((mailbox) => mailbox.id === current)?.role;

    if (currentRole === "trash" || currentRole === "junk") {
      await this.deleteForever(threadIds);

      return;
    }

    if (trash === null) return;

    await this.#move(
      threadIds,
      (record) => {
        if (record.summary.mailboxIds[trash.id] === true) return null;

        const previous = Object.keys(record.summary.mailboxIds).filter(
          (id) => record.summary.mailboxIds[id] === true,
        );

        return {
          forward: {
            ...Object.fromEntries(previous.map((id) => [id, null] as const)),
            [trash.id]: true,
          },
          back: {
            [trash.id]: null,
            ...Object.fromEntries(previous.map((id) => [id, true] as const)),
          },
        };
      },
      {
        done:
          threadIds.length === 1
            ? "Conversation moved to Trash."
            : `${threadIds.length} conversations moved to Trash.`,
        failed: "Couldn't delete.",
      },
      true,
    );
  }

  /** Spam, or out of Spam into the Inbox. */
  async toggleSpam(threadIds: readonly string[]): Promise<void> {
    const junk = mailboxByRole(this.#state.mailboxes, "junk");
    const inbox = mailboxByRole(this.#state.mailboxes, "inbox");
    const current = currentMailboxId(this.#state);

    if (junk === null || inbox === null) return;

    if (current === junk.id) await this.moveTo(threadIds, inbox.id);
    else await this.moveTo(threadIds, junk.id);
  }

  async deleteForever(threadIds: readonly string[]): Promise<void> {
    const account = this.#ctx.account();
    const engine = this.#ctx.engine();

    if (account === null || engine === null || threadIds.length === 0) return;

    const ok = await this.#ctx.ui.confirm({
      title:
        threadIds.length === 1
          ? "Delete this conversation?"
          : `Delete ${threadIds.length} conversations?`,
      body: "They are removed from your server for good. You can't undo this.",
      confirm: "Delete for good",
      danger: true,
    });

    if (!ok) return;

    const current = currentMailboxId(this.#state);

    const ids = (await this.#emailsOf(threadIds))
      .filter((record) => current === null || record.summary.mailboxIds[current] === true)
      .map((record) => record.summary.id);

    this.#leave(threadIds);
    this.#update((state) => ({ overlay: withHidden(state.overlay, threadIds, true) }));

    try {
      const outcome = await destroyEmails(account, ids);

      if (outcome.failed.size > 0) throw new Error("The server refused to delete");

      this.#ctx.ui.toast("Deleted.");
      await engine.catchUp();
    } catch (error) {
      this.#ctx.ui.toast(isOffline(error) ? OFFLINE : "Couldn't delete.", { tone: "error" });
    } finally {
      this.#update((state) => ({ overlay: withHidden(state.overlay, threadIds, false) }));
    }
  }

  /**
   * The Archive mailbox, by its role. The first time something is archived, a top-level
   * "Archive" without a role (made by an import or another mail client) takes the role, because
   * Stalwart refuses a second top-level folder of that name in any case; otherwise it is created.
   */
  #ensureArchive(): Promise<string> {
    const existing = mailboxByRole(this.#state.mailboxes, "archive");

    if (existing !== null) return Promise.resolve(existing.id);

    // Archives started in a row (e, e, e) wait for one folder instead of each making one.
    this.#archiveFolder ??= this.#makeArchive().finally(() => {
      this.#archiveFolder = null;
    });

    return this.#archiveFolder;
  }

  async #makeArchive(): Promise<string> {
    const account = this.#ctx.account();

    if (account === null) throw new Error("Not signed in");

    const named = this.#state.mailboxes.find(
      (mailbox) =>
        mailbox.parentId === null &&
        mailbox.role === null &&
        mailbox.name.toLowerCase() === "archive",
    );

    if (named !== undefined) {
      const updated = await account.client.call(
        [
          [
            "Mailbox/set",
            { accountId: account.accountId, update: { [named.id]: { role: "archive" } } },
            "0",
          ],
        ],
        MAIL_USING,
      );

      const refused = updated.parse("0", "Mailbox/set", mailboxUpdated).notUpdated?.[named.id];

      if (refused !== undefined)
        throw new Error(
          `The server did not make "${named.name}" the Archive folder: ${refused.type}`,
        );

      await this.#ctx.engine()?.catchUp();

      return named.id;
    }

    const response = await account.client.call(
      [
        [
          "Mailbox/set",
          {
            accountId: account.accountId,
            create: { a: { name: "Archive", role: "archive", parentId: null } },
          },
          "0",
        ],
      ],
      MAIL_USING,
    );

    const id = response.parse("0", "Mailbox/set", mailboxCreated).created?.["a"]?.id;

    if (id === undefined) throw new Error("The server did not create the Archive folder");

    await this.#ctx.engine()?.catchUp();

    return id;
  }

  // --- attachments and inline images ----------------------------------------------------------

  /** The stored message, from memory or the server. */
  async #rawMessage(emailId: string): Promise<Uint8Array<ArrayBuffer>> {
    const cached = this.#raw.get(emailId);

    if (cached !== undefined) {
      this.#raw.delete(emailId);
      this.#raw.set(emailId, cached);

      return cached;
    }

    const account = this.#ctx.account();
    const engine = this.#ctx.engine();

    if (account === null || engine === null) throw new Error("Not signed in");

    const [record] = await engine.records([emailId]);

    if (record === null || record === undefined) throw new Error("The message is not saved");

    const raw = await account.client.download(
      account.accountId,
      record.summary.blobId,
      "message.eml",
      "message/rfc822",
    );

    this.#raw.set(emailId, raw);

    while (this.#raw.size > RAW_CACHE) {
      const oldest = this.#raw.keys().next().value;

      if (oldest === undefined) break;

      this.#raw.delete(oldest);
    }

    return raw;
  }

  /** Decrypted parts of a message, through the key worker. */
  async parts(
    emailId: string,
    indexes: readonly number[],
  ): Promise<{ filename: string | null; mimeType: string; content: Uint8Array<ArrayBuffer> }[]> {
    const worker = this.#ctx.worker();

    if (worker === null) throw new Error("Kasten is locked");

    const raw = (await this.#rawMessage(emailId)).slice();

    return worker.call("readAttachments", { raw, indexes }, [raw.buffer]);
  }

  /** Saves an attachment as a file. It is never opened in the app. */
  async download(emailId: string, index: number, filename: string | null): Promise<void> {
    try {
      const [part] = await this.parts(emailId, [index]);

      if (part === undefined) return;

      // A generic type, so the browser saves the file instead of showing it.
      const url = URL.createObjectURL(
        new Blob([part.content], { type: "application/octet-stream" }),
      );

      const link = document.createElement("a");

      link.href = url;
      link.download = safeFilename(filename ?? part.filename);
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      this.#ctx.ui.toast(
        error instanceof KastenJmapError && error.type === "network"
          ? "Attachments need a connection to your server."
          : "Couldn't download the attachment.",
        { tone: "error" },
      );
    }
  }

  /**
   * Blob URLs for a message's inline images (cid:) and for previews of attached images, by
   * Content-ID and by part index. Only safe image types get one.
   */
  async images(view: MessageView): Promise<{
    readonly inline: ReadonlyMap<string, string>;
    readonly previews: ReadonlyMap<number, string>;
  }> {
    const cached = this.#inline.get(view.emailId);

    if (cached !== undefined) return cached;

    const parts = view.attachments.filter((part) => isPreviewImage(part.mimeType));
    const inline = new Map<string, string>();
    const previews = new Map<number, string>();
    const result = { inline, previews };

    if (parts.length === 0) return result;

    const decoded = await this.parts(
      view.emailId,
      parts.map((part) => part.index),
    );

    // Another call may have finished first.
    const raced = this.#inline.get(view.emailId);

    if (raced !== undefined) return raced;

    parts.forEach((part, position) => {
      const content = decoded[position];

      if (content === undefined) return;

      const url = URL.createObjectURL(
        new Blob([content.content], { type: part.mimeType.toLowerCase() }),
      );

      if (part.contentId !== null) inline.set(part.contentId, url);

      previews.set(part.index, url);
    });

    this.#inline.set(view.emailId, result);

    return result;
  }

  /** Lets go of the blob URLs of a thread that closed. */
  release(emailIds: readonly string[]): void {
    for (const id of emailIds) {
      for (const url of this.#inline.get(id)?.previews.values() ?? []) URL.revokeObjectURL(url);

      this.#inline.delete(id);
    }
  }

  /** Forgets everything decrypted that this controller holds, on lock. */
  reset(): void {
    this.release([...this.#inline.keys()]);
    this.#raw.clear();
  }
}

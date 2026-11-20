// Optimistic changes on top of the saved email records (see Overlay in store.ts).
import type { EmailSummary } from "@kasten/core/mail";

import type { KeywordPatch, Overlay } from "./store.ts";

/** Whether an email has a keyword, with the pending patches applied. */
export function hasKeyword(
  summary: Pick<EmailSummary, "id" | "keywords">,
  overlay: Overlay,
  keyword: string,
): boolean {
  return overlay.keywords.get(summary.id)?.get(keyword) ?? summary.keywords[keyword] === true;
}

export function isUnread(
  summary: Pick<EmailSummary, "id" | "keywords">,
  overlay: Overlay,
): boolean {
  return !hasKeyword(summary, overlay, "$seen");
}

export function isStarred(
  summary: Pick<EmailSummary, "id" | "keywords">,
  overlay: Overlay,
): boolean {
  return hasKeyword(summary, overlay, "$flagged");
}

/** Sets one keyword on these emails, on top of any pending patches. */
export function withKeyword(
  overlay: Overlay,
  emailIds: readonly string[],
  keyword: string,
  on: boolean,
): Overlay {
  const keywords = new Map(overlay.keywords);

  for (const id of emailIds) {
    const patch: KeywordPatch = new Map(keywords.get(id));

    keywords.set(id, new Map(patch).set(keyword, on));
  }

  return { ...overlay, keywords };
}

/** Removes this change again, keeping the keyword where a later change set it otherwise. */
export function withoutKeyword(
  overlay: Overlay,
  emailIds: readonly string[],
  keyword: string,
  on: boolean,
): Overlay {
  const keywords = new Map(overlay.keywords);

  for (const id of emailIds) {
    const current = keywords.get(id);

    if (current?.get(keyword) !== on) continue;

    const rest = new Map(current);

    rest.delete(keyword);

    if (rest.size === 0) keywords.delete(id);
    else keywords.set(id, rest);
  }

  return { ...overlay, keywords };
}

export function withHidden(
  overlay: Overlay,
  threadIds: readonly string[],
  hidden: boolean,
): Overlay {
  const next = new Set(overlay.hidden);

  for (const id of threadIds) {
    if (hidden) next.add(id);
    else next.delete(id);
  }

  return { ...overlay, hidden: next };
}

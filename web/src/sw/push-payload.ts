// What a Web Push from Stalwart carries, decoded for the service worker.
import { z } from "zod";

const pushVerification = z.object({
  "@type": z.literal("PushVerification"),
  pushSubscriptionId: z.string().min(1),
  verificationCode: z.string().min(1),
});

export type PushVerification = Omit<z.infer<typeof pushVerification>, "@type">;

const emailPush = z.object({
  "@type": z.literal("EmailPush"),
  emails: z
    .array(
      z.object({
        from: z
          .array(z.object({ name: z.string().nullish(), email: z.string().nullish() }))
          .nullish(),
        subject: z.string().nullish(),
      }),
    )
    .min(1),
});

/** Stalwart's push for a new message that it does not send as an EmailPush. */
const stateChange = z.object({
  "@type": z.literal("StateChange"),
  changed: z.record(z.string(), z.record(z.string(), z.string())),
});

export type PushPayload = z.core.util.JSONType | null;

/** The push body, or null when it is empty or not JSON; every push still shows a notification. */
export function payloadOf(data: PushMessageData | null): PushPayload {
  try {
    return z.json().parse(data?.json() ?? null);
  } catch {
    return null;
  }
}

/** Stalwart's first push to a new subscription, which carries the verification code. */
export function verificationOf(payload: PushPayload): PushVerification | null {
  const parsed = pushVerification.safeParse(payload);

  return parsed.success
    ? {
        pushSubscriptionId: parsed.data.pushSubscriptionId,
        verificationCode: parsed.data.verificationCode,
      }
    : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === "" ? null : value.trim();
}

/** What the notification for a new message says. */
export interface MailNotice {
  readonly title: string;
  readonly body: string;
}

const GENERIC: MailNotice = { title: "New mail", body: "" };

/**
 * Whether a push is for new mail. `emailPush` says whether this device's subscription asks for
 * EmailPush (sw/notice-prefs.ts). Stalwart v1.0.1 then sends each delivered message as an
 * EmailPush, and a plain state change for every other new message: the app's own $draft and Sent
 * copy (Email/import), an IMAP APPEND, an Email/set create. Without emailPush a delivery is a
 * state change too, so every push is new mail. Only a well-formed state change is not.
 */
export function isNewMail(payload: PushPayload, emailPush: boolean): boolean {
  return !emailPush || !stateChange.safeParse(payload).success;
}

/** The notice for a push that is not new mail. It names no one, and each replaces the last. */
export const MAILBOX_CHANGE: MailNotice = { title: "Mailbox updated", body: "No new mail." };

export const MAILBOX_CHANGE_TAG = "kasten-mailbox-change";

/** The tag of new-mail notifications, the ones that may name a sender and a subject. */
const NEW_MAIL_TAG = "kasten-new-mail";

/**
 * A tag of its own for each new-mail notification. A notification with the tag of one still shown
 * replaces it, so the earlier sender and subject would be lost, and browsers do not alert again.
 */
export function newMailTag(): string {
  return `${NEW_MAIL_TAG}:${crypto.randomUUID()}`;
}

/** Whether a notification is a new-mail one, those from versions with one shared tag included. */
export function isNewMailTag(tag: string): boolean {
  return tag === NEW_MAIL_TAG || tag.startsWith(`${NEW_MAIL_TAG}:`);
}

/**
 * Title and body for a new-mail push: the sender and subject when the server sent them and
 * `details` is on (the setting "Show sender and subject in notifications"), else "New mail".
 */
export function newMailText(payload: PushPayload, details: boolean): MailNotice {
  if (!details) return GENERIC;

  const parsed = emailPush.safeParse(payload);

  if (parsed.success) {
    const [first] = parsed.data.emails;
    const from = first?.from?.[0];
    const sender = nonEmpty(from?.name) ?? nonEmpty(from?.email);
    const subject = nonEmpty(first?.subject);

    if (sender !== null || subject !== null)
      return { title: sender ?? GENERIC.title, body: subject ?? "" };
  }

  return GENERIC;
}

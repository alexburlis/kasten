// Small building blocks shared by the screens.
import type { ComponentChildren, JSX } from "preact";

import { Icon } from "./icons.tsx";

/** The phone layout's media query, the same `(max-width: 719px)` the stylesheets use. */
export const PHONE = "(max-width: 719px)";

/** The mark above a centred card, for the one-task screens: sign-in, unlock, key setup. */
export function TaskScreen(props: {
  readonly title: string;
  readonly children: ComponentChildren;
}) {
  return (
    <main class="task">
      <div class="task-mark">
        <Icon name="mark" />
        <span>Kasten</span>
      </div>
      <div class="task-card">
        <h1>{props.title}</h1>
        {props.children}
      </div>
    </main>
  );
}

/**
 * The error line. Its slot is always there, so an error does not move the button below it; the
 * slot has no role, so only a real error is an alert.
 */
export function ErrorText(props: { readonly text: string | null }) {
  return (
    <div class="error-slot">
      {props.text === null ? null : (
        <p class="error" role="alert">
          {props.text}
        </p>
      )}
    </div>
  );
}

/** A keycap beside a button's name. Hidden from assistive tech, so the name does not change. */
export function Kbd(props: { readonly keys: string }) {
  return <kbd aria-hidden="true">{props.keys}</kbd>;
}

export function Field(props: {
  readonly label: string;
  readonly children: ComponentChildren;
  readonly hint?: string | null;
}) {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      {props.children}
      {props.hint === undefined || props.hint === null ? null : (
        <span class="field-hint">{props.hint}</span>
      )}
    </label>
  );
}

/** The value of the input that fired an event. */
export function inputValue(
  event: JSX.TargetedEvent<HTMLInputElement | HTMLTextAreaElement>,
): string {
  return event.currentTarget.value;
}

export function Splash(props: { readonly text: string }) {
  return (
    <main class="splash" aria-busy="true">
      <Icon name="mark" class="splash-mark" />
      <p>{props.text}</p>
    </main>
  );
}

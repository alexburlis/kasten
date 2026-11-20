// To, Cc and Bcc: typed addresses become chips; suggestions come from mail saved on this device.
import { useEffect, useRef, useState } from "preact/hooks";

import {
  formatAddress,
  parseAddresses,
  uniqueAddresses,
  type Address,
} from "../../lib/addresses.ts";
import { actions } from "../../state/actions.ts";
import { Icon } from "../../ui/icons.tsx";

export interface AddressFieldHandle {
  /** Turns the typed text into chips; returns the text that is not an address, if any. */
  commit(): string | null;
}

export function AddressField(props: {
  readonly label: string;
  readonly id: string;
  readonly value: readonly Address[];
  readonly onChange: (next: readonly Address[]) => void;
  readonly handle?: { current: AddressFieldHandle | null };
  readonly autofocus?: boolean;
}) {
  const { value, onChange } = props;
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<readonly Address[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = `${props.id}-suggestions`;

  const add = (raw: string): string | null => {
    const parsed = parseAddresses(raw);

    if (parsed.valid.length > 0) onChange(uniqueAddresses([...value, ...parsed.valid]));

    const rest = parsed.invalid.join(", ");

    setText(rest);
    setSuggestions([]);
    setError(rest === "" ? null : `Not an email address: ${rest}`);

    return rest === "" ? null : rest;
  };

  if (props.handle !== undefined) {
    props.handle.current = { commit: () => (text.trim() === "" ? null : add(text)) };
  }

  useEffect(() => {
    let current = true;
    const query = text.trim();

    if (query.length < 1 || /[,;]/u.test(query)) {
      setSuggestions([]);

      return;
    }

    void actions.compose
      .suggest(
        query,
        value.map((address) => address.email),
      )
      .then((found) => {
        if (current) {
          setSuggestions(found);
          setActive(0);
        }
      });

    return () => {
      current = false;
    };
  }, [text]);

  const choose = (address: Address): void => {
    onChange(uniqueAddresses([...value, address]));
    setText("");
    setSuggestions([]);
    setError(null);
    input.current?.focus();
  };

  return (
    <div class="address-field">
      <label class="compose-label" for={props.id}>
        {props.label}
      </label>
      <div class="chips" onClick={() => input.current?.focus()}>
        {value.map((address) => (
          <span class="chip address" key={address.email} title={address.email}>
            {address.name === "" ? address.email : address.name}
            <button
              type="button"
              class="chip-remove"
              aria-label={`Remove ${formatAddress(address)}`}
              onClick={() => onChange(value.filter((item) => item !== address))}
            >
              <Icon name="close" class="sm" />
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={props.id}
          type="text"
          inputMode="email"
          autocomplete="off"
          spellcheck={false}
          value={text}
          autofocus={props.autofocus}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : `${props.id}-error`}
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls={suggestions.length > 0 ? listId : undefined}
          role="combobox"
          aria-activedescendant={suggestions.length > 0 ? `${listId}-${active}` : undefined}
          onInput={(event) => {
            const next = event.currentTarget.value;

            setError(null);

            if (/[,;\n]\s*$/u.test(next)) add(next);
            else setText(next);
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData?.getData("text") ?? "";

            if (/[,;\n]/u.test(pasted)) {
              event.preventDefault();
              add(`${text}${pasted}`);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && suggestions.length > 0) {
              event.preventDefault();
              setActive((active + 1) % suggestions.length);
            } else if (event.key === "ArrowUp" && suggestions.length > 0) {
              event.preventDefault();
              setActive((active - 1 + suggestions.length) % suggestions.length);
            } else if (event.key === "Enter" || (event.key === "Tab" && text.trim() !== "")) {
              const suggestion = suggestions[active];

              if (suggestion !== undefined) {
                event.preventDefault();
                choose(suggestion);
              } else if (text.trim() !== "") {
                event.preventDefault();
                add(text);
              }
            } else if (event.key === "Escape" && suggestions.length > 0) {
              event.stopPropagation();
              setSuggestions([]);
            } else if (event.key === "Backspace" && text === "" && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => {
            // Leave time for a click on a suggestion.
            setTimeout(() => {
              if (document.activeElement !== input.current && text.trim() !== "") add(text);

              setSuggestions([]);
            }, 150);
          }}
        />
      </div>
      {suggestions.length > 0 ? (
        <ul
          class="suggestions"
          id={listId}
          role="listbox"
          aria-label={`${props.label} suggestions`}
        >
          {suggestions.map((address, index) => (
            <li
              key={address.email}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              class={index === active ? "active" : undefined}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(address);
              }}
            >
              <span class="suggestion-name">
                {address.name === "" ? address.email : address.name}
              </span>
              {address.name === "" ? null : <span class="suggestion-email">{address.email}</span>}
            </li>
          ))}
        </ul>
      ) : null}
      {error === null ? null : (
        <p class="field-error" id={`${props.id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

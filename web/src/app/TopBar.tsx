// The top bar: the menu button (narrow widths), the mark and the search field. At 1200 px and up
// it sits at the top of the sidebar column; the sync line and the account menu live in the
// sidebar foot.
import { actions } from "../state/actions.ts";
import { INBOX } from "../state/route.ts";
import { useAppState } from "../state/store.ts";
import { Icon } from "../ui/icons.tsx";
import { withKey } from "./keys.ts";

/** The id of the search field, which the / shortcut focuses. */
export const SEARCH_FIELD = "search-field";

export function TopBar(props: { readonly onMenu: () => void; readonly menuOpen: boolean }) {
  const query = useAppState((state) => state.search.query);

  return (
    <header class="topbar">
      <button
        class="icon-button menu-button"
        type="button"
        onClick={props.onMenu}
        aria-label="Menu"
        aria-expanded={props.menuOpen}
        aria-controls="sidebar"
      >
        <Icon name="menu" />
      </button>
      <a
        class="brand"
        href="/"
        onClick={(event) => {
          event.preventDefault();
          actions.navigate(INBOX);
        }}
      >
        <Icon name="mark" />
        <span>Kasten</span>
      </a>
      <form
        class="search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          document.querySelector<HTMLElement>(".list-pane .row-button")?.focus();
        }}
      >
        <Icon name="search" />
        <input
          id={SEARCH_FIELD}
          type="search"
          placeholder="Search mail"
          aria-label="Search mail"
          title={withKey("Search mail", "search")}
          autocomplete="off"
          value={query}
          onInput={(event) => actions.search.type(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              actions.search.clear();
              event.currentTarget.blur();
            }
          }}
        />
      </form>
    </header>
  );
}

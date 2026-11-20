// Drafts saved on this device. They never go to the server, so other devices do not see them.
import { actions } from "../../state/actions.ts";
import { useAppState } from "../../state/store.ts";
import { Icon } from "../../ui/icons.tsx";
import { shortDate } from "../mailbox/MessageList.tsx";

export function DraftsView() {
  const drafts = useAppState((state) => state.drafts);

  return (
    <section class="list-pane drafts" aria-label="Drafts">
      <div class="pane-head">
        <h1 class="pane-title">Drafts</h1>
      </div>
      <p class="pane-note">Drafts stay on this device, encrypted.</p>
      {drafts.length === 0 ? (
        <div class="empty">
          <p>No drafts on this device.</p>
          <button class="button" type="button" onClick={() => void actions.compose.compose()}>
            Write a message
          </button>
        </div>
      ) : (
        <ul class="rows">
          {drafts.map((draft) => (
            <li key={draft.id} class="row-item" data-testid="draft-row">
              <div class="row-content">
                <button
                  type="button"
                  class="row-button"
                  onClick={() => void actions.compose.openDraft(draft.id)}
                >
                  <span class="row-line">
                    <span class="sender draft-label">
                      Draft{draft.to === "" ? "" : `: ${draft.to}`}
                    </span>
                    <time dateTime={draft.updatedAt}>{shortDate(draft.updatedAt)}</time>
                  </span>
                  <span class="subject-line">
                    <span class="subject">
                      {draft.subject === "" ? "(no subject)" : draft.subject}
                    </span>
                    <span class="snippet">{draft.snippet}</span>
                  </span>
                </button>
                <button
                  type="button"
                  class="icon-button row-discard"
                  aria-label={`Discard draft: ${draft.subject === "" ? "(no subject)" : draft.subject}`}
                  onClick={() => void actions.compose.discard(draft.id)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

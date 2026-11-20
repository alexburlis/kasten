# Kasten web app design

Kasten looks like good stationery: warm paper, ink-black type and hairline rules where other apps draw boxes. The list is a ledger grouped by day. An open message is a letter on a lighter sheet. One blue-black ink colour marks what is unread, what is primary and where the focus is. It must feel fast enough to live in all day. Encryption shows up only where it changes a decision.

## Principles

- **Mail first.** The list and the letter are the interface. Chrome is thin, sans-serif and quiet.
- **Serif for what you read, sans for what you operate.** Subjects, the thread title, page titles and plain-text letters are serif. Senders, metadata, navigation and controls are sans.
- **Rules, not boxes.** Hairlines separate rows, messages and settings. Panes differ by paper tone: the desk (`--bg`) and the sheet (`--surface`).
- **One channel per state.** Unread, hover, keyboard cursor, selected and open each have their own visual channel, so any two can sit on one row without confusion.
- **Truthful states.** Sync, index coverage, offline and send status are shown plainly. Never show a spinner where a count is known.
- **Security without noise.** A message not stored encrypted gets one calm badge. Normal encrypted mail shows nothing extra.
- **Fast and optimistic.** State changes first. Motion only explains what already happened and never delays input.

## Layout

| Width                            | Layout                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ≥ 1200 px                        | Sidebar 232 px on `--bg`, holding the brand and the search field at the top, then Compose, folders and the sidebar foot. With no thread open, the list fills the rest of the window, and when it is at least 880 px wide its rows become one line (see List). With a thread open, the list is `clamp(400px, 34vw, 520px)` wide with two-line rows, and the reading sheet (`--surface`) takes the rest. Compose opens as a 560 × 600 px sheet docked 24 px from the right edge. |
| 720–1199 px                      | A 52 px top bar spans the window: menu button, brand, search field (up to 560 px). The sidebar sits below it on the left and the menu button collapses it. The thread replaces the list. Back (`u`) returns to the list.                                                                                                                                                                                                                                                       |
| < 720 px (designed at 390 × 844) | One pane at a time. The top bar holds the menu button and a filled search field. The list head shows the serif title and "13 unread · Up to date". Rows have three lines. A "Compose" pill floats bottom right over a fade. The thread hides the top bar and pins the conversation actions and Reply to the bottom, within thumb reach. Compose is full screen. Folders open in a drawer from the menu button.                                                                 |

- The sidebar holds, top to bottom: the brand (box mark and "Kasten" in serif), the search field, Compose, Inbox, Starred, Sent, Drafts, Outbox (only while something waits), Archive, Spam, Trash, the "Folders" label and the custom folders, then the foot: Settings, the sync line and meter, and the account menu.
- The sidebar foot is sticky at the bottom of the sidebar and has a fixed height (`--sidebar-foot`, 112 px), so the toast can sit directly above it.
- Safe-area insets apply on iPhone in standalone mode. While a thread is open on a phone, the safe-area band takes the sheet colour.
- Every control is a 44 px touch target on phones. Labelled buttons grow to 44 px tall. Icon buttons, the star and the chip remover keep their drawn size and take the 44 px target from an invisible overlay, so dense rows keep their layout; the chip remover's overlay reaches only 8 px to each side so a tap beside a chip never removes it.
- Hover fills and underlines apply only where the device can hover (`@media (hover: hover)`), so a tap on a touch screen never leaves one stuck on.

## Tokens

Light mode is warm paper. Dark mode is graphite: neutral grey surfaces with a faint cool cast, never brown, with the same ink-blue accent and warm amber warning.

The tokens the contrast test reads are six-digit hex in the first `:root` block of `app.css` and in the `:root` inside `@media (prefers-color-scheme: dark)`. They come first in each block, and neither block holds a nested block. Supporting tokens follow them. The word `:root` must not appear in a comment above the light block.

### Tested tokens

| Token                        | Light                 | Dark                  | Use                                                                                                                                          |
| ---------------------------- | --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--bg`                       | `#f3eee4`             | `#16171a`             | The desk: sidebar, list, task backdrop                                                                                                       |
| `--surface`                  | `#fbf8f2`             | `#1e1f23`             | The sheet: reading pane, settings, task cards, the open row                                                                                  |
| `--surface-2`                | `#ebe4d6`             | `#292a2f`             | Fills: search field, banners, attachment tiles, hover base                                                                                   |
| `--text`                     | `#1d1a16`             | `#e6e7ea`             | Ink                                                                                                                                          |
| `--text-2`                   | `#5c5448`             | `#a3a6ad`             | Metadata, snippets, labels                                                                                                                   |
| `--accent`                   | `#24467a`             | `#9fb3d6`             | Unread dot, links, focus ring, checked boxes and switches, chips and the selected folder                                                     |
| `--accent-weak`              | `#e2ded5`             | `#262e3b`             | Selected folder, address chips, search marks, the swipe underlay                                                                             |
| `--warn`                     | `#87520a`             | `#e0aa5e`             | "Not encrypted", storage warnings, the offline dot                                                                                           |
| `--danger`                   | `#a1291b`             | `#ec8a7a`             | Errors, destructive actions                                                                                                                  |
| `--primary` / `--on-primary` | `#24467a` / `#fbf8f2` | `#34507f` / `#eef1f6` | Primary buttons (Reply, Send, Unlock) and the Compose pill                                                                                   |
| `--ink` / `--on-ink`         | `#1d1a16` / `#f3eee4` | `#34363c` / `#eef0f3` | The toast                                                                                                                                    |
| `--warn-tint`                | `#e8dece`             | `#2d281f`             | Background of the "Not encrypted" badge: `--warn` at 10 % (12 % dark) over `--bg`, opaque so the test can read it                            |
| `--selected`                 | `#e1d5bf`             | `#32353c`             | The selected-row wash: a warm tan, clearly stronger than hover and distinct from the open row's `--surface`. Dark is a neutral graphite step |

### Contrast of the tested pairs

Computed with the formula and parser of `web/test/contrast.test.ts`, run against `app.css`. Every pair clears 4.5:1.

| Pair                          | Light | Dark  |
| ----------------------------- | ----- | ----- |
| `--text` on `--bg`            | 14.99 | 14.50 |
| `--text` on `--surface`       | 16.35 | 13.32 |
| `--text` on `--surface-2`     | 13.70 | 11.58 |
| `--text-2` on `--surface`     | 7.03  | 6.75  |
| `--text-2` on `--surface-2`   | 5.89  | 5.87  |
| `--accent` on `--surface`     | 8.88  | 7.76  |
| `--warn` on `--surface`       | 6.11  | 7.90  |
| `--danger` on `--surface`     | 6.96  | 6.65  |
| `--surface` on `--accent`     | 8.88  | 7.76  |
| `--surface` on `--danger`     | 6.96  | 6.65  |
| `--accent` on `--accent-weak` | 7.01  | 6.44  |
| `--on-primary` on `--primary` | 8.88  | 7.13  |
| `--on-ink` on `--ink`         | 14.99 | 10.58 |
| `--warn` on `--warn-tint`     | 4.87  | 7.03  |
| `--text` on `--selected`      | 11.94 | 9.93  |
| `--text-2` on `--selected`    | 5.14  | 5.04  |

### Supporting tokens

| Token           | Light                                                   | Dark                                    | Use                                                                                                                         |
| --------------- | ------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--rule`        | `#ddd4c3`                                               | `#2d2f34`                               | Hairlines (decorative)                                                                                                      |
| `--rule-strong` | `#c6baa5`                                               | `#44474e`                               | Outlines of labelled buttons, chips and keycaps; the snippet dash                                                           |
| `--control`     | `#8e8270`                                               | `#70747c`                               | Outlines of checkboxes, text inputs and the off switch track (3.55 and 3.51 on `--surface`, above the 3:1 non-text minimum) |
| `--text-3`      | `#8a8072`                                               | `#7d8088`                               | Keycap text only; a keycap is never the only label                                                                          |
| `--raised`      | `#fdfbf7`                                               | `#26272c`                               | Compose, menus, dialogs, the Compose button                                                                                 |
| `--mail-card`   | `#ffffff`                                               | `#eceef1`                               | The card behind designed HTML mail                                                                                          |
| `--mail-dim`    | `1`                                                     | `0.94`                                  | `filter: brightness()` on the HTML mail card                                                                                |
| `--hover`       | `color-mix(in srgb, var(--surface-2) 70%, transparent)` | 60 %                                    | Hover fill of buttons, folders and menu items                                                                               |
| `--backdrop`    | `rgb(29 26 22 / 0.32)`                                  | `rgb(0 0 0 / 0.5)`                      | Dialog backdrop and the drawer scrim                                                                                        |
| `--edge`        | none                                                    | `inset 0 1px 0 rgb(255 244 228 / 0.07)` | The hairline highlight on raised surfaces in dark                                                                           |

- In dark mode the primary fill is a deep ink blue with pale text, not the pale accent. It is never the brightest thing on screen.
- In dark mode the toast is a raised graphite card, not an inverted pale slab.
- The star is ink (`--text`) when on. The "Not encrypted" badge stays the only amber thing in a row.
- Selected rows keep their snippets readable: `--text-2` on `--selected` is 5.14 (light) and 5.00 (dark). The checked checkbox on it is 6.48 and 5.86.

### Layout tokens

| Token            | Value                                                           | Use                                                                                                      |
| ---------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `--sidebar`      | `232px`                                                         | Sidebar width (≥ 720 px)                                                                                 |
| `--list-w`       | `clamp(400px, 34vw, 520px)`                                     | List width while a thread is open (≥ 1200 px)                                                            |
| `--row-h`        | `52px`, phone `76px`                                            | Fixed row height                                                                                         |
| `--day-h`        | `24px`, phone `28px`                                            | Day separator height                                                                                     |
| `--gutter`       | `32px`; `48px` when the list is ≥ 880 px wide; `20px` on phones | The column for the unread dot, checkbox and cursor (wide enough for both side by side in selection mode) |
| `--sidebar-foot` | `112px`                                                         | Fixed height of the sidebar foot                                                                         |

At 1440 × 900 with nothing open, the list is wider than 880 px, so rows are one line at `44px` and more conversations fit than the 14 two-line rows (60 + 4 × 24 + 14 × 52 = 884 px) a narrower list shows.

## Type

The CSP allows system faces only.

| Stack     | Value                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `--serif` | `ui-serif, "New York", Charter, "Iowan Old Style", "Palatino Linotype", "Noto Serif", Georgia, serif`         |
| `--sans`  | `system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` |
| `--mono`  | `ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", monospace`                                          |

- Safari renders New York. Chrome on macOS has no `ui-serif` and renders Charter, which has only regular and bold. So serif text uses only 400 and 700, and both browsers match: a serif 500 would render regular in Chrome and medium in Safari, and 600 bold in one and semibold in the other.
- New York sets about 2–3 % wider than Charter, so Safari wraps and truncates serif text a little earlier. Check line breaks in Safari, not only Chrome, and let headlines that fill their container wrap to a second line.
- Sans weights are 400, 500 and 600. Serif weights are 400 and 700.
- Dates, counts and sizes use `tabular-nums`. Mono is for the fingerprint, key text and refused addresses only.
- Inputs are 16 px on phones so iOS does not zoom.

| Role                                              | Family | Size / line height             | Weight                        | Notes                                                                         |
| ------------------------------------------------- | ------ | ------------------------------ | ----------------------------- | ----------------------------------------------------------------------------- |
| Thread subject                                    | serif  | 30 / 1.18 (phone 26)           | 400                           | Tracking −0.015em, `text-wrap: balance`                                       |
| Page title (Inbox, Settings)                      | serif  | 24 / 1 (Settings 32, phone 31) | 400                           | Search shows the query in typographic quotes                                  |
| Task screen title                                 | serif  | 28 / 1.15                      | 400                           |                                                                               |
| Settings section                                  | serif  | 18 / 1.3                       | 400                           |                                                                               |
| Dialog title                                      | serif  | 20 / 1.3                       | 400                           |                                                                               |
| Wordmark                                          | serif  | 19 (task screens 20)           | 400                           |                                                                               |
| Letter body (plain text)                          | serif  | 17 / 1.62 (phone 17.5 / 1.6)   | 400                           | Old-style numerals, `hanging-punctuation: first`, measure about 70 characters |
| Compose subject and body                          | serif  | 15.5 and 16 / 1.6              | 400                           |                                                                               |
| Row subject                                       | serif  | 15 / 20 (phone 16.5 / 21)      | 400, unread 700               |                                                                               |
| Sender                                            | sans   | 13.5 / 18 (phone 15.5 / 20)    | 400, unread 600               |                                                                               |
| Snippet                                           | sans   | 13.5 (phone 14.5)              | 400                           | `--text-2`, after an en-spaced em dash in `--rule-strong`                     |
| Date                                              | sans   | 12.5 (phone 13.5)              | 400, unread 600               | `--text-2`, tabular; unread in `--accent`                                     |
| UI text, folders, buttons                         | sans   | 13.5–14                        | 400, buttons 500, primary 600 |                                                                               |
| Tracked label (day separators, kicker, "Folders") | sans   | 10.5 / 1                       | 600                           | Uppercase, tracking 0.08em, `--text-2`                                        |
| Badge                                             | sans   | 11.5 (thread 12.5)             | 600                           | Sentence case                                                                 |
| Keycap                                            | sans   | 11 / 1                         | 500                           | `--text-3` on a `--rule-strong` outline, lower case as typed                  |
| Fingerprint                                       | mono   | 13 / 1.6                       | 500                           | Groups of four, five groups per line                                          |

## Spacing, radius, elevation

- **Grid:** 4 px. Desktop rows are 52 px: 6 px padding, an 18 px first line, 2 px gap and a 20 px second line. Phone rows are 76 px with three lines. The letter column is at most 1000 px, 60 px from the toolbar's left edge, with an 80-character text measure.
- **Radius:** 4 px badges, checkboxes and keycaps; 6 px folders, toolbar buttons and attachment icons; 7 px buttons, fields and the search field; 8 px attachment tiles; 9 px toast and menus; 10 px the HTML mail card and the compose top corners; 12 px task cards and dialogs; 13 px address chips; 25 px the phone Compose pill.
- **Rules instead of boxes:** rows, collapsed messages, compose fields and settings sections are separated by 1 px `--rule` hairlines. Cards are used only for task screens, designed HTML mail, compose, menus and dialogs.
- **Elevation, three levels:**

| Level | Token            | Used by                        |
| ----- | ---------------- | ------------------------------ |
| Lift  | `--shadow-lift`  | Compose button                 |
| Card  | `--shadow-card`  | Task cards, the HTML mail card |
| Sheet | `--shadow-sheet` | Compose, menus, dialogs        |

In dark mode every level starts with the `--edge` highlight and a 1 px neutral ring, because shadows do not show on graphite. Depth in dark comes from the surface steps: `--bg` #16171a → `--surface` #1e1f23 → `--raised` #26272c.

## Icons and the mark

- One inline SVG set, drawn on a 20 px grid, rendered at 18 px (15 px small, 22 px in phone bars), `currentColor`, 1.5 px strokes, round caps and joins.
- **The mark** is a closed box in isometric view: the outline hexagon, the two front edges, and the seam where the lid flaps meet. It is monochrome in `--text`. It cannot be confused with the Archive icon, which is a front-on tray with a lid.
  - Path: `M10 2.6 17.2 6.2v7.6L10 17.4 2.8 13.8V6.2Z`, `M2.8 6.2 10 9.8l7.2-3.6M10 9.8v7.6`, `M6.4 4.4l7.2 3.6`.
  - Sizes: 22 px in the sidebar and top bar, 44 px (stroke 1.1) above task cards and on the splash screen.
- **The open box** (`markOpen`): the same box seen open, with the two back flaps folded out. It appears once, at 40 px in `--text-3`, above the empty-state sentence.
  - Path: `M3 8.5 10 5l7 3.5-7 3.5Z`, `M3 8.5v6l7 3.5 7-3.5v-6M10 12v6`, `M3 8.5 1 6.5 8 3l2 2`, `M17 8.5l2-2-7-3.5-2 2`.
- **App icon:** the mark in `#1d1a16` on a `#f3eee4` tile, full bleed, with the mark inside the 80 % safe zone so it also works as a maskable icon.
- Folder names in the sidebar have no icons. Toolbars show icons; Archive and Delete also show their label.
- New icons: `mark` (redrawn), `markOpen`, `lockOpen` (the "Not encrypted" badge, replacing the warning triangle), `chevron` (account menu), `image` (the remote images line).
- Mark as read is the open envelope (flap folded up, a pentagon outline) and Mark as unread the closed one (a plain rectangle), so the two differ in silhouette wherever both show.
- `Icon` takes an optional `class` added after `icon`, for example `class="sm"` for 15 px.

## Motion

Motion explains where something went. It uses `transform` and `opacity` only. Colour, background and size changes are instant. Nothing waits for an animation.

Entrances use `@starting-style`, which Safari supports from 17.5 and Chrome from 117. It is a progressive enhancement: where it is missing, the element simply appears in place, and nothing depends on the entrance having run.

### Durations and easings

| Token          | Value                              | For                                                                                     |
| -------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| `--t-tap`      | 90 ms                              | Press, checkbox reveal, date and dot swaps                                              |
| `--t-hover`    | 120 ms                             | Hover underline, quick actions, tick, switch knob, snippet arrival, bulk actions, menus |
| `--t-glide`    | 110 ms                             | Keyboard cursor between rows                                                            |
| `--t-close`    | 180 ms                             | Rows closing a gap, swipe settle                                                        |
| `--t-pane`     | 200 ms                             | Reading sheet, page turn, toast, task card, dialog, sync meter                          |
| `--t-sheet`    | 220 ms                             | Compose rising, phone drawer                                                            |
| `--ease-out`   | `cubic-bezier(0.2, 0.7, 0.2, 1)`   | Feedback and glides                                                                     |
| `--ease-paper` | `cubic-bezier(0.22, 0.9, 0.28, 1)` | Panels and sheets                                                                       |

### Every animation

| Name              | Trigger                                                        | Property                                                                                             | Duration, easing                                                                                       | Reduced motion | Built with                                                                                    |
| ----------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------- |
| Press             | `:active` on buttons, Compose, the pill                        | `transform: scale(0.98)`                                                                             | 90 ms ease-out                                                                                         | none           | CSS `:active`                                                                                 |
| Hover underline   | Pointer over a row                                             | `.row-content::after` `scaleX(0 → 1)` from the left, 1 px ink over the hairline                      | 120 ms ease-out, retracts at the same speed                                                            | instant        | CSS `:hover`                                                                                  |
| Quick actions     | Pointer over a row                                             | `.row-quick` opacity and `translateX(4px → 0)`; the date fades out                                   | 120 ms ease-out; date 90 ms                                                                            | instant        | CSS `:hover`                                                                                  |
| Checkbox reveal   | Pointer over a row, or selection mode                          | `.row-check` opacity; the unread dot fades out                                                       | 90 ms linear                                                                                           | instant        | CSS on `:hover` and `.selecting`                                                              |
| Tick              | Checkbox checked                                               | `::after` `scale(0.4 → 1)` and opacity; the fill colour is instant                                   | 120 ms ease-out                                                                                        | instant        | CSS `:checked`                                                                                |
| Switch            | Switch toggled                                                 | Knob `translateX(14px)`; the track colour is instant                                                 | 120 ms ease-out                                                                                        | instant        | CSS `:checked`                                                                                |
| Cursor glide      | `j` or `k`                                                     | `.list-cursor` `translateY(--cursor-y)`                                                              | 110 ms ease-out; 0 ms on key repeat or a second press within 140 ms; 0 ms for clicks and route changes | instant        | Layout effect in `MessageList` sets `--cursor-y` and `--cursor-t` through `style.setProperty` |
| Close the gap     | Rows leave the list (archive, delete, move, spam, swipe, bulk) | Following rows `translateY(Δ → 0)`; the cursor follows at the same speed                             | 180 ms ease-out                                                                                        | instant        | FLIP in a layout effect in `MessageList` (below)                                              |
| Snippet arrival   | A snippet decrypts after the row rendered                      | `.snippet` opacity 0 → 1                                                                             | 120 ms linear                                                                                          | instant        | Class `pending` removed; the line height is already reserved                                  |
| Bulk actions      | Selection becomes non-empty                                    | Count and actions opacity 0 → 1, no movement                                                         | 120 ms ease-out                                                                                        | instant        | `@starting-style`                                                                             |
| Reading sheet     | A thread opens while none is open (≥ 1200 px)                  | `.reader` opacity and `translateX(12px → 0)`                                                         | 200 ms ease-paper                                                                                      | opacity 120 ms | `@starting-style` on the persistent `.reader` wrapper                                         |
| Page turn         | A thread opens (< 1200 px)                                     | `.reader` opacity and `translateX(16px → 0)`                                                         | 200 ms ease-paper                                                                                      | opacity 120 ms | `@starting-style`                                                                             |
| Back              | The list returns (< 1200 px)                                   | `.list-pane` opacity 0 → 1, no movement                                                              | 120 ms linear                                                                                          | instant        | `@starting-style` on `display: none → block`, inside `max-width: 1199px` only                 |
| Compose rising    | Compose opens (≥ 720 px)                                       | `translateY(24px) scale(0.985)` and opacity, origin bottom right                                     | 220 ms ease-paper                                                                                      | opacity 120 ms | `@starting-style` on `.compose`                                                               |
| Compose on phones | Compose opens (< 720 px)                                       | Opacity only, so the full-screen sheet is in place at frame 0                                        | 160 ms linear                                                                                          | opacity 120 ms | `@starting-style`                                                                             |
| Toast             | A toast appears or replaces another                            | `translateY(8px)` and opacity                                                                        | 200 ms ease-paper                                                                                      | opacity 120 ms | `@starting-style`; each toast is keyed by its id                                              |
| Menu              | The account menu opens                                         | `.menu` opacity and `translateY(4px)`                                                                | 120 ms ease-out                                                                                        | instant        | `@starting-style`                                                                             |
| Dialog            | A dialog opens                                                 | Card opacity and `scale(0.98 → 1)`; backdrop opacity                                                 | 200 ms ease-paper                                                                                      | opacity 120 ms | `@starting-style` on `dialog[open]` and `::backdrop`                                          |
| Drawer            | Menu button on phones                                          | `.sidebar` `translateX(-100% → 0)`; scrim opacity                                                    | 220 ms ease-paper                                                                                      | instant        | Transition on the existing `.open` class                                                      |
| Swipe             | Finger on a phone row                                          | `.row-content` follows the finger with no transition; on release under the threshold it settles back | 180 ms ease-out                                                                                        | instant settle | Transition disabled while `.swiping` is set                                                   |
| Sync meter        | Index count changes                                            | `scaleX(indexed / total)`                                                                            | 200 ms linear                                                                                          | instant        | Transition on the meter fill                                                                  |

Closing and dismissing are instant: compose, toasts, menus and dialogs leave the DOM at once.

### Input safety

1. Every action changes state and the DOM first. No code awaits `transitionend` or `animationend`, and no `setTimeout` sits before a state change.
2. `e` and `#` (and `s` in Starred, where unstarring removes the row) move the keyboard cursor to the next row at keydown, before the row leaves. `e e e` works at typing speed. The cursor moves only when its own row is one of the targets and the list shows that the action removes it (an `e` in Starred on a thread outside the Inbox, or a `#` in search on a result already in Trash, leaves it in place); otherwise the action moves it once it has read the mail, with the same next-row rule.
3. Holding `j` or `k` sets the glide to 0 ms. A second press within 140 ms also sets it to 0 ms. A `j` or `k` that cannot move (at either end of the list) leaves no glide behind for the next click. CSS transitions retarget and never queue.
4. Switching threads with `j`/`k` while the sheet is open never replays the sheet entrance.
5. Focus moves at frame 0: the thread heading on open, the compose body or To field on compose.
6. Entering elements never get `pointer-events: none`. Only the cursor bar and hidden quick actions do.
7. Scrolling and typing are never animated. `scrollIntoView` uses `block: "nearest"` with no smooth behaviour.
8. Feedback is at most 120 ms and panels at most 220 ms.
9. Under `prefers-reduced-motion: reduce`, nothing moves. Entrances keep an opacity fade of at most 120 ms. `app.css` sets every transition and animation to 0.01 ms with an unlayered `!important` rule; a component that keeps a fade restates `transition: opacity 120ms linear !important` inside its own layer, which beats the unlayered rule.

### Close-the-gap rule (FLIP)

The app removes a row from state at once, so the leaving row does not animate. In one layout effect, `MessageList` records every row's `offsetTop` after each commit. When a commit removes threads, each row within one screen of the viewport that moved up gets `transform: translateY(old − new)` through CSSOM, then, one frame later, the `closing` class and an empty transform. Only removals animate. New mail and Undo appear in place.

## Components

### Shell

- **Top bar** (720–1199 and phones): menu button "Menu", brand, search field. At ≥ 1200 px the same element sits at the top of the sidebar column with the brand above the search field.
- **Search field:** a filled field (`--surface-2` mixed with `--bg`), radius 7, 34 px high (38 px on phones), search icon, placeholder "Search mail", tooltip "Search mail (/)". On focus it turns `--surface` with a 2 px `--accent` ring, the same focus ring as every other control. The browser's own clear button is hidden. Escape clears it.
- **Sidebar folders:** 30 px rows, radius 6, sans 13.5. Hover uses `--hover`. The current folder is an `--accent-weak` pill with `--accent` text in 600. Unread counts (Inbox, custom folders) are `--text` 600; device counts (Drafts, Outbox) are `--text-2`.
- **Compose button:** full width, 36 px, `--raised` with `--shadow-lift`, pencil icon and "Compose". Tooltip "Compose (c)".
- **Sync line:** a 6 px dot and one line of text, then a 2 px meter track that is always reserved. Text is "Up to date", "Syncing" or "Connecting", or "Indexed 21,870 of 26,343" while indexing, when the meter fills to that fraction. Offline shows "Offline" in `--warn` and the dot turns into a hollow `--warn` ring, so the state changes shape and not only colour.
- **Account menu:** a `<details>` whose `summary` (label "Account menu") shows the username and a chevron. The menu opens upward on `--raised`: the username, then Settings, Keyboard shortcuts (with the `?` keycap), Lock now, Sign out.
- **Banners:** a full-width strip on `--surface-2` with a 3 px left rule: `--warn` for offline and storage, `--danger` for sync errors. Text 13 px, then an accent text action ("Try again"). They sit at the top of the main area, above the list and the reading sheet, so the Inbox's offline and sync-error banners stay in sight while a thread is open.
- **Toast:** an `--ink` card with `--on-ink` text, radius 9. At ≥ 1200 px it sits in the sidebar column directly above the foot, the sidebar's width, so it never covers mail. At 720–1199 px it sits bottom left, at most 420 px. On phones it spans the width above the Compose pill. Text, then "Undo" (or another action) underlined, then a dismiss button. In the narrow sidebar column (≥ 1200 px) a toast with an action gives the text the full width and puts the action and the dismiss button on a second row. On phones the action is a 44 px tall target. Errors add a 3 px `--danger` left rule. The list reserves 72 px of bottom padding (96 px on phones).
- **Phone drawer:** the sidebar slides in from the left, 300 px or 85 vw, over a scrim. Escape, the scrim and any pick (a folder or an account-menu item) close it. Focus moves to Compose, and back to the menu button when it closes. Compose, the folders and the account menu are 44 px rows (folders in 16 px type). Touch-only devices do not offer "Keyboard shortcuts".
- **Compose pill (phones):** `--primary` pill, 50 px, pencil and "Compose", 16 px from the right and bottom safe area. A 132 px fade from transparent to `--bg` sits under it so rows never show through behind its edges.

### List

- **Row (desktop):** the gutter, then two lines, 52 px.
  - Line 1: sender (or "To: name" in Sent), thread count, attachment clip, "Not encrypted" badge, date right-aligned.
  - Line 2: serif subject, an em dash and the snippet, cut with an ellipsis. Grapheme clusters are not split.
  - The star sits at the right end of line 2. It shows when on (ink) and on hover.
  - The snippet line is reserved before decryption, so rows never change height.
  - Rows are transparent on the desk. The list's right edge carries a 1 px `--rule` seam while a thread is open; only the open row covers it.
- **Row (one line):** when no thread is open and the list container is at least 880 px wide (`@container list`), each row is one 44 px line: sender, then the serif subject, an em dash and the snippet, then the badges, attachment clip and date on the right. The gutter is 48 px, with the checkbox in a fixed lane at 24–40 px; in selection mode the unread dot moves to 11–18 px beside it. The star has its own 30 px slot just before the date, which is a fixed 84 px column. Quick actions still replace the date on hover. Day separators stay. Whenever a thread is open, or the list is narrower, rows are the two-line 52 px rows.
- **Row (phone):** sender and date, then the serif subject, then the snippet. The unread dot sits in a 20 px gutter. No checkbox until selection mode (long press).
- **Keyboard:** the list is one Tab stop: only the cursor's row (or the first decrypted row) is in the tab order. On a focused row ArrowUp and ArrowDown move the cursor like `k` and `j`, and focus follows it. Row checkboxes and stars stay out of the tab order and are reached with `x` and `s`.
- **Row states, one channel each:**

| State           | Channel                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unread          | A 7 px accent dot in the gutter, the sender in 600 and the subject in 700, and the date in `--accent` at 600. The date and the dot survive selection mode, so unread is never told by weight alone |
| Hover           | The hairline under the row redraws in ink from the left; quick actions replace the date; the checkbox appears in the gutter                                                                        |
| Keyboard cursor | A 3 × 36 px ink bar at the gutter's left edge, one element that glides between rows                                                                                                                |
| Selected        | The warm `--selected` wash, stronger than hover and distinct from the open row, and a checked accent checkbox. In selection mode the unread dot stays visible beside the checkbox                  |
| Open            | `--surface` fill that covers the list/sheet seam, so the row reads as the tab of the sheet. The cursor always sits on the open row. Selected and open together show the `--selected` wash          |

- **Quick actions** (pointer only, not in the tab order): Archive, Mark as read (open envelope) or Mark as unread (closed envelope), Delete. Tooltips carry the keys. Their names include the subject ("Archive: Hike on Saturday?").
- **Day separators:** 24 px. A tracked label ("Today", "Yesterday", "Earlier this week", "Last week", then the month, with the year when it is not this year) and a hairline to the edge. Weeks start on Monday.
- **List head:** 60 px. The select-all checkbox in the gutter (shown on hover, focus or while selecting), the serif title, and "13 unread". While selecting, "13 unread" gives way to "2 selected" and the actions toolbar on the right, in the same row height. Rows scrolling under the head fade into it through a 12 px band instead of being cut mid-line.
- **Actions toolbar:** Archive and Delete show icon and label (in the list head only while the list is at least 490 px wide; narrower lists show icons); Mark as read (open envelope), Mark as unread (closed envelope), Star, Report spam (or Not spam) and Move to are icons with tooltips. A hairline separates the two groups. Archive is hidden in Archive, Trash and Spam; Delete reads "Delete for good" in Trash and Spam.
- **Empty state:** the open box, one serif sentence ("Your Inbox is empty.") and an outline "Write a message" button, centred in the pane below its head and lifted slightly above the middle.
- **Loading:** "Loading messages…" in `--text-2`, centred. A row whose message is not decrypted yet shows "Loading…" at full row height.
- **More:** "Show more" as an accent link centred after the last row; "Loading more…" while loading; the 1,000-row note in `--text-2`.

### Search

- The search route uses the same list. The pane title is the query in serif, in typographic quotes (“hike saturday”), then the existing coverage line in `--text-2` ("3 conversations. Searched 21,870 of 26,343 messages."), which keeps its `data-testid`.
- Matched words are marked with an `--accent-weak` background and weight 600 (700 inside the serif subject).
- No match: "No messages match." and a "Clear search" button. Errors show as a danger banner.

### Thread

- **Sheet toolbar:** 56 px, sticky, on `--surface`: Back ("Back to the list", tooltip "Back (u)"), then the actions toolbar.
- **Head:** a tracked kicker ("Inbox · 3 messages"), then the serif subject.
- **Collapsed message:** a ruled line with sender (600), snippet and date in a 160 px / flexible / auto grid. On phones the snippet wraps under the sender.
- **Expanded message:** sender (600) and `<address>`, date ("Nov 12, 2026, 7:20 PM", always joined by a comma) and star on the right, then a compact To/Cc/Bcc/Via list in 12.5 px `--text-2` with `--text-3` labels.
- **Column:** the letter column starts under the toolbar's actions (60 px left padding, 48 px right) and is at most 1000 px wide, so a wide reading sheet holds a wide letter. Text keeps an 80-character measure inside it.
- **Plain-text body:** the letter: serif 17 / 1.62 (phone 17.5 / 1.6).
- **HTML correspondence:** a Gmail, Outlook or Apple Mail message shows as the same letter (`src/ui/letter.ts`): the app's serif, size and colours in light and dark, no card. Paper-white backgrounds go; highlights stay, with dark text on them. Text that would be hard to read on the sheet takes the surrounding text colour (links `--accent`), plain body-text sizes take the letter's size (headings, superscripts and small print keep theirs), monospaced text stays monospaced, and real quotes (not indents) get a 2 px `--rule-strong` rule and `--text-2`. Coloured text that reads well keeps its colour. In dark mode images get a light `--mail-card` backing, so dark logos on transparent backgrounds stay visible.
- **Designed HTML:** mail with a background that is not paper white, a background image or a fixed layout width of at least 480 px (a table, a wrapper, the body or a hero image) keeps its own page on the mail card: `--mail-card`, radius 10, `--shadow-card`, static `filter: brightness(var(--mail-dim))` in dark, 16 × 20 px padding.
- Either way the frame is sized to its content and the page scrolls, not the frame.
- **Remote images:** a quiet line above the message: image icon, "Remote images blocked.", accent "Show". Until shown, each blocked image collapses to its alt text in small muted italic sans, and an image without alt text takes no space.
- **Not encrypted:** a sentence-case badge with an open padlock, "Not encrypted on server", in `--warn` on `--warn-tint`. Tapping it expands the existing one-sentence explanation in `--text-2` below.
- **Attachments:** 48 px tiles with a hairline outline: a 36 px icon tile or image preview, name (500) over size (`--text-2`), and a download button.
- **Reply bar:** after a hairline under the last message: Reply (primary, reply icon, `r` keycap), Reply all (`a`), Forward (`f`).
- **Phone thread (< 720 px):** the frequent conversation actions (Archive, Delete, Mark as unread, Move to) move to a bar pinned to the bottom, within thumb reach, together with Reply: five visible targets, each at least 44 px, on a blurred `--surface` backdrop above the safe area, with no keycaps. In Archive, Trash and Spam there is no Archive button, so Reply widens into its slot. The top keeps Back and the rarer actions (Mark as read, Star, Report spam). Reply all and Forward stay as full-width 44 px buttons under the last message. `ThreadActions` keeps its markup, labels and test ids; only its placement changes.
- **States:** "Opening the conversation…", "Decrypting…", "This conversation isn't saved on this device." with "Back to the list", and the warn banner "This device can't decrypt this message."

### Compose

- A 560 × 600 px sheet on `--raised` with `--shadow-sheet`, radius 10 at the top, docked bottom right. Maximised: centred, up to 860 px wide, radius 12. Phones: full screen, fitted to the visual viewport while the on-screen keyboard is up, so Send sits directly above the keyboard.
- Head: the subject (or "New message", "Reply", "Reply all", "Forward") in serif, then Maximise or Restore size, and Close ("Close and keep the draft").
- Fields are ruled lines with labels in a 56 px `--text-2` column: From (only with several identities), To, Cc and Bcc (revealed by the "Cc Bcc" link), Subject in serif.
- Address chips are `--accent-weak` pills with `--accent` text and a remove button. Suggestions open in a menu on `--raised`.
- The body is a plain-text serif textarea. The quoted original is part of the text, so it has the same colour.
- Attachments are outlined chips with a clip icon, name and size.
- The size line ("31 MB of 38 MB your server sends.") shows only near the limit, in `--text-2`, or `--danger` above it.
- Footer: Send (primary, send icon, `⌘↵` keycap, or `Ctrl+↵` off Apple platforms; "Sending…" while busy), Attach files, then Discard draft on the right.

### Task screens

- One task per screen on `--bg`: the 44 px mark and "Kasten" above a 400 px card (`--surface`, radius 12, `--shadow-card`, padding 34 / 32 / 28). The card has a serif title, at most one explanatory paragraph, the fields, a reserved 18 px error line, and one full-width primary button. The error line keeps the button still when an error appears.

| Screen                 | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Splash                 | The 44 px mark and the phase text ("Starting Kasten…", "Signing in…", "Checking your keys…") in `--text-2`. No card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Sign in                | "Sign in", the server sentence, the error line, "Sign in".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Unlock                 | "Unlock Kasten". With passkeys on the device: the primary "Unlock with passkey", then "or enter your recovery code" in `--text-2` (13 px, centred). Then "Recovery code or passphrase", "Keep unlocked on this device" (ticked by default), the error line, and "Unlock" ("Unlocking…"), outline when the passkey button leads. Then the outline "Clear this device", the way out when nothing unlocks; for a key made here whose recovery sheet was never confirmed, a sentence above the form, and the button reads "Start over". A saved unlock runs behind the start screen and never shows this form.                         |
| Unlock on a new device | "Unlock Kasten on this device", one sentence, then the same passkey button and recovery code form as Unlock, then the outline "Use my recovery sheet instead" and, after `kasten lock`, "Make a new key". Shown when the account keeps its key in the hidden "Kasten key" folder and this device has no key yet.                                                                                                                                                                                                                                                                                                                   |
| Create key             | "Create your mail key", the sentence, Your name, a `field-hint` sentence about the recovery code, the error line, "Create key", then the outline "Choose my own passphrase", which swaps the sentence for Passphrase (strength hint below) and Passphrase again (mismatch hint) and becomes "Let Kasten make a recovery code".                                                                                                                                                                                                                                                                                                     |
| Recovery sheet         | A 760 px column: a card with "Save your recovery sheet", the paragraph, for a key with a recovery code the code box (`--surface-2`, radius 7: "Your recovery code" label, the code in 17 px mono, a sentence, "Copy recovery code"), Print and "Save as file", the checkbox "I printed or saved my recovery sheet.", the error line and "Continue" (or "Done"). Below it, the sheet itself as white paper (`#ffffff`, black text, radius 4, `--shadow-card`): title, instruction, the facts list with the fingerprint and any recovery code in mono, the QR codes in a wrapping grid with captions, and the key text in 9 px mono. |
| Unlock without typing  | After a new key's recovery sheet: "Unlock without typing", the Add a passkey steps (below), and the outline "Not now" (or "Done"), which goes on to the mail or the install screen.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Restore key            | "Restore your mail key", the reason, "Scan the codes" and "Choose the file", the scanner video (radius 10) when scanning, "Or paste the key text" (mono textarea), "Recovery code or passphrase", the error line, "Restore key".                                                                                                                                                                                                                                                                                                                                                                                                   |
| Client locked          | The title for the state, the paragraph, the fingerprint in mono, the public key on `--surface-2` (11 px mono keeping the key's own lines, radius 7, scrolls after 240 px; the card widens to 520 px so a 64-character line fits), and the two buttons.                                                                                                                                                                                                                                                                                                                                                                             |
| Fatal                  | "Kasten can't start", the message, then "Clear this device" (danger) or "Try again".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

- **Print:** only the recovery sheet prints, on one A4 page with 14 mm margins. White page (also in dark mode), black text, no shadows, no radius, the QR codes at 54 mm in one row, and neither the codes nor the key text split across pages.

### Settings

- The sheet (`--surface`) beside the sidebar. A centred column, at most 760 px, with 48 px padding. Serif title "Settings".
- Each section is a ruled two-column block: the serif heading in a 180 px column, the content on the right. Below 720 px the heading sits above the content.
- Sections and content are the app's own: Account (signed-in sentence, Sign out), Your key (fingerprint in mono, five groups per line; locked note; "Print the recovery sheet again"; the passkey sentence, the list of passkeys with their name and date and a Remove button each, and "Add a passkey", which opens the steps in place: "prove" when the device unlocked by itself (an existing passkey or the recovery code), "Add a passkey", "Use the new passkey", then "Your passkey is ready." with "Add another passkey"), Sign-in codes (status sentence and its button; enrolment shows the QR code, the secret in mono, the two fields and buttons), Notifications (state sentence and button; "Show sender and subject in notifications" as a switch; "Stop notifications on other devices"), This device (coverage and storage sentences; "Keep unlocked on this device" as a switch; "Lock Kasten when idle" select or the keep-unlocked warning; Lock now, Download mail again, Clear this device in danger), About (licences sentence and link).
- Switches are 34 × 20 px. They are native checkboxes with `appearance: none`, so their role, label and keyboard behaviour do not change. Every on/off choice in Settings, Notifications included, is the same switch row: the label on the left, the switch on the right.
- The native select ("Lock Kasten when idle") is drawn by `app.css`: 34 px, the buttons' height, with a `--control` outline and a stroked chevron drawn by two gradients (no image request). Its menu stays native.

### Outbox and Drafts

- Both are list panes with the serif title.
- **Outbox item:** serif subject, "To: …" in `--text-2`, date; then the status badge and its text actions (Retry, Send again, Delete or Dismiss); the error line; refused recipients in mono. Status badges: info is a `--rule-strong` outline with `--text-2` text, warn uses `--warn-tint`, error uses `--danger` text on a 10 % danger tint.
- The offline line ("Offline. These messages send when you're back online.") is a warn banner.
- **Drafts:** the note "Drafts stay on this device, encrypted." sits under the title in `--text-2`. Draft rows are list rows: "Draft: recipients" and date, then the serif subject and snippet. The discard button shows on hover, focus and on touch screens, where it is a 44 px target in a column of its own beside the snippet.

### Dialogs

- Native `<dialog>` on `--raised`, radius 12, `--shadow-sheet`, 24 px padding, width up to 440 px (560 px for help). The backdrop is `rgb(29 26 22 / 0.32)` in light and `rgb(0 0 0 / 0.5)` in dark.
- Confirm: serif title, one sentence, buttons on the right: Cancel (outline) and the confirm button (primary, or danger fill for destructive choices). A destructive choice never has initial focus.
- Keyboard shortcuts: a ruled two-column table with keycaps on the left, generated from the bindings in `app/keys.ts`. The key column is as wide as its widest keys, so each description starts right after them.

### Keyboard hints

- Hints come from the binding table in `app/keys.ts`, which `shortcuts.ts` dispatches on, so a hint cannot drift from its key.
- They appear only in tooltips ("Archive (e)", "Mark as read (Shift+I)"), in the account menu (Keyboard shortcuts `?`), in the `?` dialog, and as keycaps on Reply, Reply all, Forward and Send.
- Keycaps are lower case as typed, because `u` and `U` are different bindings. Keycaps are `aria-hidden`, so button names do not change.

### Phone gestures

- Swipe left past 80 px archives; swipe right toggles read. The row follows the finger; an `--accent-weak` underlay shows the action icon. Under the threshold it settles back.
- Long press (500 ms) selects and enters selection mode, which shows checkboxes and the count in the list head and moves the actions to a bar pinned to the bottom (64 px plus the safe area, 44 px targets on a blurred `--surface`). The Compose pill hides while selecting.
- Tap the menu button for the drawer.

## Copy

- Short, plain and specific. "Conversation archived." "Couldn't send. It's in your Outbox and will retry."
- Name the user's things, not the system's: "your key", "this device", "your server".
- Sentence case everywhere, including badges and buttons. Tracked capitals only for day separators, the thread kicker and the "Folders" label, which are set in CSS from sentence-case text.
- No exclamation marks and no marketing language.
- Copy added by this design:
  - Row dates read "Yesterday" for yesterday's mail (everywhere `shortDate` is used).
  - Day separators: "Today", "Yesterday", "Earlier this week", "Last week", month names.
  - The list head shows "13 unread" (the folder's unread count), and on phones adds the sync state.
  - The thread kicker: "Inbox · 3 messages".
  - The sidebar label "Folders" above custom folders.
  - Tooltips gain their key: "Archive (e)".
  - The phone Compose button shows "Compose", its existing name.
  - The account menu summary shows the username instead of its initial.
- No existing copy is removed or renamed.

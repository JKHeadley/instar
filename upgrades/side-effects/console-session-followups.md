# Side effects: console session attachments, internal-session toggle, no paste button

## Changes
- `POST /sessions/:name/attachments` (Bearer, like every session route): saves a base64 file
  (≤ 8 MB decoded) for a session running on THIS machine under `<stateDir>/state/dashboard-uploads/`
  (0600, dir 0700) and returns its path. Files older than 30 days are removed on later uploads.
- Console composer: an attach button, image paste and drag-and-drop. On Send it uploads each
  file, then sends the text plus one line per file naming the saved path. Remote sessions show
  the button disabled with a reason.
- Sessions list hides internal sessions (jobs, and headless helpers the agent spawned) by
  default, with a per-viewer toggle that names the count. `/sessions/create` now records
  `triggeredBy: 'dashboard-operator'` so operator-created headless sessions stay visible.
- The "Paste long text" button and footer link (legacy dropzone) are removed: the composer
  already sends long multi-line text over the same socket, local or remote.

1. **Over-block** — an operator-created headless session started before this change has no
   marker and is listed as internal until the toggle is on (still reachable, counted).
2. **Under-block** — attachments to a session on another machine are not supported (said in
   the UI). The route does not inspect file contents; it is behind the same Bearer token that
   can already type into the session.
3. **Level fit** — file bytes live on the machine running the session; the session gets a
   path, the same shape Telegram photos use.
4. **Signal vs authority** — no decision authority added.
5. **Interactions** — `triggeredBy` was an existing optional Session field; nothing else
   branches on 'dashboard-operator'.
6. **External surfaces** — one new authenticated route; disk usage bounded by retention.
7. **Multi-machine** — machine-local by design (the file must be on the session's disk);
   the list toggle is per viewer (localStorage).
8. **Rollback** — revert; saved uploads stay on disk until removed by hand or by the next
   version's retention.

## 6b. Operator-surface quality

1. **Leads with its primary action** — the composer stays message-first; the paper-clip is a
   small icon beside it, and the list's toggle sits under the list, not above it.
2. **No raw internals as primary content** — the toggle says "Show 5 internal sessions (jobs
   and helpers)"; attached files show by their own names. The saved path appears only in the
   message the session receives.
3. **Destructive actions de-emphasized** — nothing destructive added; removing a pending
   attachment is a small ✕ that only drops it from the unsent message.
4. **Plain language at phone width** — chips wrap, the paper-clip is a 44 px target, and the
   disabled state on another machine's session explains why in one sentence.

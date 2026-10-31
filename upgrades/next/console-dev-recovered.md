# Console: the operator-reviewed dev version, and promise checks that stop failing falsely

<!-- bump: patch -->

## What Changed

The console work the operator reviewed live from 2026-10-27 to 2026-10-31 was never committed: it was a dev copy on one machine. It is now recovered, merged with main, and shipped.

- **Home:** the headline is only ever something the operator can act on. Its link opens that item ("Tap to review and respond"). Otherwise it reads "Nothing needs you". My own areas (promises I owe, machines, safety settings, failed reads of those) never take the headline; they sit under a "See agent status" fold.
- **No duplicate asks:** a promise that waits on the same pull request as a queue item is shown once, as the queue item that carries the action.
- **Promises:** overdue promises show their due date. Each promise has an expandable "How this came about" history and a "Copy update question and open chat" action. Promises the agent owns sit in collapsed sections instead of the default list. Sheets scroll their own content, not the page behind them.
- **Names, not ids:** topic names are read from every machine (Sessions, Agents, Messages). Delayed messages are grouped by cause, and Agents gains a "Past conversations" list.
- **Promise checks:** `POST /commitments` rejects an unknown `verificationMethod`, and a `config-change` that names no setting, with a 400 that says why. Existing records of either kind no longer add a violation on every sweep (one had accumulated 23,161), and are never marked delivered. The sentinel saves a detected config-change that names no setting as a one-time action.
- **Held-message counts** (`/health` → `telegramOrigin.heldForward`) split session replies, automatic messages and other messages.

## What to Tell Your User

The dashboard you tried out over the last few days is now the real thing. The front page only shows what you can act on, each promise explains how it came about, and you can ask about one with a single tap. Promise checks no longer pile up false failures.

## Summary of New Capabilities

Promise backstory and one-tap update question in the console; held-message counts split by kind; clear 400s for malformed promises.

## Evidence

The operator reviewed these screens live on his phone (topic 127504, 2026-10-27 to 2026-10-31). Console unit tests (25 files), the commitments unit/integration/e2e tests, the origin forward tests and the console e2e all pass on the merged tree.

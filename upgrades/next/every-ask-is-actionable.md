# Every ask is actionable: one tap on everything that needs you

## What Changed

- `dashboard/console/shared-counts.js`: every item the console counts as needing the operator now carries an `action` — an in-place approval (`POST` with a confirmation, and the existing PIN sheet when the route needs a recent unlock) or a deep link to the exact place (`#/<page>?…&item=<id>`, or GitHub's "Files changed" review page for a pull request). An item with no buildable action is not counted; `needsYou()` reports it in `agentOwned`, and Home lists it under "What I'm doing" (behind Details).
- Actions per kind: attention items use the tap the server stamps; promises waiting on the operator open that promise's sheet ("Answer" / "Open to approve"); sign-in repairs waiting for a tap are approved in place (`POST /subscription-relogin/repair-cell`, PIN sheet); PRs waiting for the code-owner review open `https://github.com/<repo>/pull/<n>/files` in a new tab (the Development row when the repository name is unknown).
- `dashboard/console/actions.js` (new): renders the tap on Home's "What needs you" rows and on the Promises, Accounts, Development and Passwords & keys pages; Promises, Accounts, Development and Messages open or mark the exact item named by `item=` and then drop it from the address.
- `src/messaging/attentionAction.ts` (new): the one rule for an attention item's tap (category/id → console page; a valid producer-supplied `action` wins). `GET /attention` stamps `action` on every item (local and pool-merged); `POST /attention` accepts an optional `action` and refuses one that is not a console hash path (400).
- `TelegramAdapter`: an Attention hub post now carries an inline URL button to `<tunnel URL>/dashboard/console/#/…` (never localhost). A post with nothing to tap still goes out and is recorded in `logs/attention-unactionable.jsonl` (`reason: no-action | no-public-url`). A relayed send appends the link to the text, since markup cannot travel. `sendToTopic` gained a `urlButtons` option.
- `GreenPrAutoMerger.configurationView()` (and `GET /green-pr-automerge` → `configuration.repo`) now names the repository, so the PR link can be built.
- `src/scaffold/templates.ts` + `PostUpdateMigrator.migrateClaudeMd`: one Attention Queue bullet (content-sniffed on `attention-unactionable`, idempotent).

## What to Tell Your User

Everything I bring to you now comes with one button. On the console's Home, each thing that needs you has its own Approve, Answer or Review button that either does it right there or opens the exact spot where you decide. Attention messages in Telegram carry a button that opens that spot too. If something has nothing for you to tap, I no longer count it as yours; I list it with my own work instead.

## Summary of New Capabilities

- One-tap actions on every needs-you row in the console, and an inline button on every Attention post that has a place to act.
- `logs/attention-unactionable.jsonl` — Attention posts that reached the operator with nothing to tap.

## Evidence

Unit: `console-actionable.test.ts` (both sides of each kind's action, the no-action ⇒ not-needs-you invariant, jsdom render of the buttons, the approve flow through the PIN sheet, deep-link landing), `attention-action.test.ts` (rules, URL safety, the real TelegramAdapter hub post with and without a button, the unactionable log, the relay path), `PostUpdateMigrator-attentionActionable.test.ts`. Integration: `attention-actionable.test.ts` (GET stamps, POST validation), `green-pr-automerge-routes.test.ts`. E2E: `console-home-lifecycle.test.ts` (every counted needs-you item carries an actionable tap through the real stack).

## Follow-up in the same release: a refused button never costs the alert (fb-99bc2103-19b)

- `TelegramAdapter.sendToTopic`: when a send carrying `urlButtons` is refused, the fallback no longer re-sends the same `reply_markup`. It tries plain with the button, then the formatted text without it, then plain without it; a send without buttons keeps the old single retry. A post delivered without its button is logged to `logs/attention-unactionable.jsonl` with `reason: "button-refused"` (new `onButtonRefused` option).
- `GET /attention?scope=pool`: a peer item's `action` is re-validated with the same rule as a local producer's (`peerItemAction`); a non-console target gets `action: null` and one `reason: "peer-action-invalid"` log line. Evidence: `attention-action.test.ts` (refused → delivered without markup + logged; accepted → unchanged; peer valid/invalid), `attention-pool-scope.test.ts` (forged peer over real HTTP).

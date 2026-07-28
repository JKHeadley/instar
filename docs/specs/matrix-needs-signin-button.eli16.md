# Account Matrix "Needs sign-in" → actionable Sign-in button — Plain-English Overview

> The one-line version: a matrix cell that said "Needs sign-in" was a dead-end with no button to act on — this gives it a working "Sign in" button right below the words, exactly like the empty cells already have.

## The problem in one breath

The Subscriptions dashboard shows a grid of "which account is signed in on which machine." Empty cells get a "Set up" button you can tap; a cell whose login expired showed only the grey text "⟳ Needs sign-in" — with nothing to tap. So the user could SEE that an account needed re-authentication but had no way to do anything about it from the dashboard. The operator's exact words: "Everything should be actionable from the dashboard itself."

## What already exists

- **The account × machine matrix** — a table in the Subscriptions tab. Rows are accounts (by email), columns are machines (Laptop, Mac Mini). Each cell shows a state: ✓ Active, an empty "Set up" button, "Needs sign-in", "Signing in…", "Machine offline", etc.
- **The in-dashboard sign-in flow** — tapping "Set up" expands an inline PIN box → on confirm it calls the PIN-gated `start-cell` endpoint → that returns a real provider sign-in link + a code-paste box. The whole login happens inside the dashboard, no terminal. This already works for empty cells.
- **`start-cell`** — the server orchestrator behind that flow. It resolves the account's email from the account id, issues the follow-me mandate, and drives the login (on this machine or, over the mesh, on a peer machine).

## What this adds

The "Needs sign-in" state was simply left out of the list of cell-states that render a button — it fell into the "just draw text" branch. This change moves `needs-reauth` into the actionable branch alongside the empty/retry states, and gives it the label **"Sign in"**. The status word "⟳ Needs sign-in" still shows, with the button directly below it — precisely the layout the operator asked for. The button carries the same `(account id, machine id)` data and triggers the exact same existing flow, so a tap drives a genuine re-authentication. An account in the needs-sign-in state already resolves to its email, so `start-cell` works for it unchanged — the button is real, not cosmetic.

## The new pieces

- **No new module, no new endpoint, no new authority.** This is a pure front-end rendering change in `dashboard/subscriptions.js`. The PIN gate, the mandate issuance, and the sign-in orchestration all already exist and are untouched. The button simply re-uses them.

## The safeguards

The action behind the button is still gated by the operator's dashboard PIN (the `start-cell` endpoint refuses without it) — adding the button changes nothing about who is allowed to start a login. The change is one branch condition plus a button label; a new unit test asserts the needs-sign-in cell now renders a "Sign in" button wired to the existing flow, so the dead-end can't silently come back. Other cell states (active, offline, in-progress) are unchanged.

## What the reader needs to decide

Nothing risky — this is a small UX fix that makes a visible dead-end actionable using machinery that already ships. The only judgement call was the button label ("Sign in" vs "Re-authenticate"); "Sign in" matches the rest of the flow's vocabulary.

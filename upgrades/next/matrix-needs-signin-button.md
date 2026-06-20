## What Changed

The Subscriptions dashboard's account × machine matrix had a dead-end. A cell whose login had expired showed only the grey text "⟳ Needs sign-in" with **no button to act on** — so you could see an account needed re-authentication but had no way to do anything about it from the dashboard. Every other cell-state was already actionable: an empty cell gets a "Set up" button, a failed cell gets a "Retry" button. The `needs-reauth` state was simply left out of the branch that renders a button and fell through to the "just draw text" path.

This fix moves `needs-reauth` into the actionable branch in `dashboard/subscriptions.js`. The cell now shows the status word "⟳ Needs sign-in" **and** a "Sign in" button directly below it. The button carries the same `(account, machine)` ids as the "Set up" button and runs the exact same in-dashboard flow (PIN → provider sign-in link → paste code). Because a needs-sign-in account already resolves to its email, the `start-cell` orchestrator drives a genuine re-authentication — the button is real, not cosmetic. No server route, authority, or data model changed; the PIN gate on starting a login is untouched.

## What to Tell Your User

If you saw an account in your Subscriptions grid marked "Needs sign-in" with no way to fix it, that's now a one-tap action. The cell shows "Needs sign-in" with a **Sign in** button right below — tap it, enter your PIN, open the sign-in link, and paste the code back, exactly like setting up a new account. Everything stays inside the dashboard; nothing changed about who's allowed to start a login.

## Summary of New Capabilities

- The account × machine matrix's "Needs sign-in" cell is now actionable: it renders the status word **plus a "Sign in" button** that runs the existing in-dashboard re-authentication flow (PIN → link → paste code).
- The button works for an account whose login expired on this machine OR on a peer machine — it rides the same PIN-gated, mesh-delivered `start-cell` path the "Set up" button already uses.
- No change to authorization: starting a login still requires the operator's dashboard PIN.

## Evidence

- New regression unit test in `tests/unit/subscriptions-render.test.ts`: asserts a `needs-reauth` cell renders the "Needs sign-in" word AND a `.sub-matrix-setup` "Sign in" button wired to the start-cell flow (`data-matrix-setup`, correct account/machine ids). 34/34 in that file pass.
- Related front-end tests green: `follow-me-controller-wiring.test.ts` (8) and `account-follow-me-locally-executable.test.ts` (9) — confirms the existing tap-handler/flow this button re-uses is unchanged.
- Traced root cause directly in `renderAccountMatrix`: `needs-reauth` was absent from the actionable-cell branch condition; the server `start-cell` route resolves an existing account's email and drives a real re-auth, so the new button is functional.
- Side-effects review: `upgrades/side-effects/matrix-needs-signin-button.md` (no block/allow surface; no new authority; machine-local render of an existing pool-scope flow). Tier 1.

## ELI16

The Subscriptions screen has a grid showing which account is signed in on which machine. Empty squares had a "Set up" button you could tap. But a square for an account whose login had run out just said "Needs sign-in" in grey — with no button. So you could see the problem but couldn't fix it from the screen. Turns out the code that decides "should this square have a button?" simply forgot to include the "needs sign-in" case, so it drew plain text instead. This fix adds the button: the square now says "Needs sign-in" with a "Sign in" button right under it, and tapping it runs the same sign-in steps as setting up a new account (enter your PIN, open the link, paste the code). It actually signs the account back in — it's not a fake button — and it works whether the account expired on this machine or another one.

## What Changed

Added operator-**Cancel** for an in-flight account×machine matrix cell. PR #1230 shipped the matrix happy-path (tap a cell → start a cross-machine sign-in) but left no way to back out: a mis-tapped cell sat "in-progress" (◷) for up to 15 minutes with a live `claude auth login` pane and no undo. This adds a tappable Cancel on the in-progress cell that abandons the pending login and tears down its sign-in pane — on THIS machine or a peer, via a fronting relay that mirrors the existing `submit-code` pattern (Bearer-authed, one mesh hop; offline peer → honest 502). Two new routes (`POST /subscription-pool/follow-me/enroll/:id/cancel` target-local + `POST /subscription-pool/follow-me/cancel` relay), dark behind the existing `multiMachine.accountFollowMe` flag (no new config key). Two `PendingLoginStore` hardening tweaks ride along: a `transition()` terminal guard (a cancel can never clobber a login that just COMPLETED) and an `issue()` that replaces a stale terminal/expired same-id record (so re-enrollment after a cancel works instead of erroring "already exists").

## Evidence

- 32 new tests pass: store terminal-guard + issue()-replace + the live-pending-still-throws boundary (unit); `EnrollmentWizard.getById`/`abandon` pass-throughs (unit); the full route matrix over HTTP (integration) — dark→503, happy→200+abandoned with the RAW `tmux kill-session` asserted via a recording stub, idempotent terminal→200, completed-not-clobbered, unknown/malformed id→404, expired-still-cancellable→200, submit-in-flight→409, relay self/peer/offline; and the Tier-3 "feature is alive" E2E booting the real `AgentServer` (200 + abandoned, not 404; dark→503; Bearer required).
- 178 existing related tests still green (no regression), tsc clean, full custom-lint suite clean.
- Spec converged through `/spec-converge` (2 rounds, `cross-model-review: codex-cli:gpt-5.5`); the review caught FOUR real bugs in the first draft before any code: the original pane-kill (`sessionManager.killSession`) was a no-op for these unregistered raw-tmux panes; cancel→abandon would have broken re-enrollment; a cancel could have un-done a successful login; and a self-only scope would have silently 404'd peer cells.
- Independent second-pass review (kill-path + gate) — see `upgrades/side-effects/matrix-cell-operator-cancel.md`.

## What to Tell Your User

If you start setting up an account on a machine from the dashboard's account×machine grid and realize you tapped the wrong cell, you can now tap **Cancel** right on that spinning cell to back out — it shuts down the leftover sign-in window and frees the cell so you can set up the right one. It works whether the cell is on the machine you're looking at or another of your machines. (This rides the account-follow-me feature, which is off by default.)

## Summary of New Capabilities

- **Cancel an in-flight matrix cell** — a tappable Cancel on the in-progress (◷) cell in the dashboard Subscriptions grid; abandons the pending login + tears down its sign-in pane on the owning machine (self or peer). Bearer-only (no PIN — a per-machine PIN can't cross the mesh, same as the code-submit step). Dark behind `multiMachine.accountFollowMe`.

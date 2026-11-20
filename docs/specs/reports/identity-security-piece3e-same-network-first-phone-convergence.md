# Convergence report: identity piece 3e, a first phone over the same network

Builder #38, 2026-11-19. Two review rounds on the spec and the code together, by Opus reviewers with no stake in the
design (the Fable reviewers hit their quota and were relaunched on Opus). No cross-model (GPT or Gemini) round was run.

## Round 1 (security + integration, independent)

Both reviewers found the same two blockers:
- A phone waiting for the number could be let in by the shared approval funnel (owner-phone tap, introducer,
  dashboard approve), skipping the number and the signed pinned hash. Fixed: `admission: 'at-computer'` on the device
  record closes every other path for its whole pending life.
- A phone let in at the computer had full owner-phone approval power. Fixed: `activeOwnerPhone()` is false for it.

Majors fixed: notification-token and document-page side doors on the main listener; `/mobile/routes` handing a home
phone addresses it cannot use; the home address left open after an abandoned setup; a stop race in the listener; a
same-network redeem falling onto the dashboard path. Minors fixed: shared PIN lockout store, socket marked in the
request handler too, per-address map pruning, 15 s request timeout, full signing window after a late number, lease and
pause checks at activation, Telegram setups recorded as sent to the chat, route-table flags, no PIN on the command
line, a wider ratchet with its limit stated. Not fixed, recorded as limits: the 15 s window after a network change.

## Round 2 (resolution check)

Ten of twelve fixes resolved. Two partly, and one new blocker:
- BLOCKER: owner-only routes that act as approvals or admin (org acts, conversation grants, attention choices) checked
  only the person's role. Fixed: an at-computer phone may sign only the browser-device routes plus its push
  registration, route list and activation (`cannot-approve-yet` otherwise), and may remove only itself.
- MAJOR: the home address could stay open indefinitely (expiry, restart, revoked phone). Fixed: at boot and each tick
  the listener closes itself when no setup is open and no home phone is active or waiting.
- Minors fixed: close awaits an in-flight reconcile; a spent code ends its setup; piped CLI input read line by line;
  Ctrl+C cancels; activation refusal closes on `close` as well as `finish`; tied default routes read as unknown;
  spec drift.

The round-2 fixes have tests (integration 12/12, e2e 2/2, unit) but were not re-reviewed by a third round. The
identity session reviews this branch before a pull request is opened.

## After review: one change from the live proof

The live proof on the Windows 11 VM found that a listener bound to WSL's loopback is not reachable from Windows (WSL
forwarded only the wildcard-bound main port), so A4's "inside WSL bind to loopback only" leaves the pass-through nothing
to forward to. Changed: inside WSL the listener binds to WSL's own NAT address, only when provably NAT mode, and stays
closed otherwise. Tested (unit, and live end to end) but not reviewed by a reviewer; the identity session should read it.

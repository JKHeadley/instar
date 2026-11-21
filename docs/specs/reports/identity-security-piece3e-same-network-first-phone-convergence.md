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

## Round 3 (builder #40): the home port and A5's ceremony credential

Scope: §3.1 (default port main + 20000, an asked-for port, `port-fixed`) and §4.6 (the one-time ceremony credential),
both found necessary by the Windows app's live proof (builder #39). One independent Opus reviewer (security +
integration) read the code, A4/A5's text and the spec. No blocker.

- MAJOR: a port move that joined a running reconcile could report and keep the earlier port. Fixed (settle once more),
  with a white-box test that fails without the fix.
- MAJOR: a Telegram owner of an app-made agent has no way through at the computer (credential refused for Telegram
  owners; the PIN was never told). Not changed: raised to the identity session as an explicit decision (§4.6 choice a).
- Minors fixed and tested: refusals known in advance now come before the credential is spent; a wrong try is never
  written over a newer credential; a stored lapse time is capped at the credential's life; exactly one enrolled-app
  record is required; the main port cannot be asked for. Answered without change: paused phones (no such status) and
  native Windows (refused by design, now stated).

The round-3 fixes have tests but were not re-reviewed. No cross-model round.

## Round 4 (builder #45): WSL networking mode, review leads, and the first outside (GPT) review

Scope: the review leads from the first outside-review attempt (which OpenAI refused) — the WSL NAT range guess (MAJOR),
the two at-computer fields, the credential file read, the port-move race — then one outside review.

- One independent Opus second pass on the four fixes: concur, five MINOR. Four fixed (ledger written only for an
  at-computer admission; a 10-minute clock margin on the `.wslconfig` fallback; the ratchet narrowed and quote-agnostic;
  the status reads the WSL mode before any open); one accepted (mirrored mode shares one loopback budget, in §4 limits).
- One cross-model round: codex `gpt-6.2-sol`, read-only, neutral correctness prompt, not refused
  (winapp-work/a4/gpt-review-2-20261120T121900Z.md). Four BLOCKERS, all confirmed against the code and fixed with tests that fail
  without them: device routes on the home listener without a signature when no agent token is configured; document
  devices did not carry the home/at-computer distinction; a missing `.wslconfig` read as NAT; the mint command could race
  the spend's path-based write and removal. One MAJOR fixed (approval pushes to an at-computer iPhone). The other
  MAJOR and MINOR leads are listed in the side-effects artifact for the identity session, unverified.

The round-4 fixes after the GPT review were not re-reviewed.

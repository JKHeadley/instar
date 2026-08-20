---
change_type: fix
---

## What Changed

A cross-machine "Set up" tap on the Subscriptions grid nests four timeout budgets, and the outermost was the smallest. `POST /subscription-pool/matrix/start-cell` and the target machine's `POST /subscription-pool/follow-me/enroll/start` both inherited the 30s global default, while the relay fetch between them was hard-coded to 40s and the pane scrape underneath ran on `multiMachine.accountFollowMe.remoteScrapeTimeoutMs` (default 60s, commonly tuned to 180s for a remote peer). Any cross-machine sign-in slower than 30s therefore returned a bare `408 Request timeout` from the middleware while the handler was still legitimately working — discarding the handler's own classified outcome (`502 login-did-not-start / retryable`, `409 cannot-resolve-email`, `201 reused`).

The same inversion was present on two sibling relays found by sweeping every `AbortSignal.timeout` in route scope: `follow-me/submit-code` and `follow-me/cancel`. The submit-code case is the more severe one — a verification code is single-use, so a 408 there leaves the operator unable to determine whether their one attempt was spent.

All four budgets now derive from the single `remoteScrapeTimeoutMs` knob through `resolveFollowMeBudgets()`, so widening the scrape budget widens every budget above it instead of silently re-inverting the chain. The three hard-coded relay literals are gone.

This is the same "408 while the handler keeps running" class that `OUTBOUND_MESSAGING_TIMEOUT_MS`, `PARITY_PASS_TIMEOUT_MS` and `POOL_TRANSFER_TIMEOUT_MS` each already fixed one instance of. It recurred because those were three independent constants, leaving a newly nested route nothing to inherit.

## Evidence

Reverting the four override entries fails the new unit test with 18 failures naming each inverted route; restoring passes 29/29 across four knob values including the operator's 180s. A prefix-containment assertion confirms `/subscription-pool`, `/subscription-pool/poll` and `/subscription-pool/swap` remain on the 30s default, so the new prefix does not swallow the namespace. The four affected integration suites (`account-matrix-start-cell-route`, `account-follow-me-submit-code-route`, `account-follow-me-cancel-route`, `account-follow-me-enroll-start-route`) pass — 51 tests. The existing `AgentServer-outbound-timeout` wiring assertion was widened for the now multi-line call and additionally asserts the new config-derived argument reaches the shared builder.

## Known Limits

Budgets are computed per machine from that machine's own knob, deliberately — the bound must cover work on that machine's hardware and network path. If the fronting machine's knob is set lower than the target's, its relay can still abort early; that degrades to the honest retryable `502` and never a false success, and retrying is safe because the target reuses a live pending login rather than starting a second. Operators running a non-default knob should set it on every machine.

`FOLLOWME_MANDATE_DELIVERY_BUDGET_MS` mirrors the `timeoutMs: 15_000` literal in `src/commands/server.ts` rather than importing it; raising that literal without updating the constant would erode slack without failing a test.

A wedged peer now surfaces later than before — up to roughly four minutes at a 180s knob, versus 30 seconds. That is the intended trade: the previous behaviour "noticed" quickly by declaring every slow-but-healthy sign-in dead.

## What to Tell Your User

If tapping **Set up** on the Subscriptions grid for another machine gave you "Couldn't start: Request timeout", that was a wrapper giving up on a sign-in that was still running — not the sign-in failing. It is fixed, along with the same problem on the code-paste and cancel steps of that flow. You will now get a real explanation when something genuinely goes wrong, and slow machines (particularly any reachable only over the tunnel rather than a direct network route) get the time they actually need.

## Summary of New Capabilities

No new capabilities — this restores the intended behaviour of the existing account × machine setup grid on multi-machine agents.

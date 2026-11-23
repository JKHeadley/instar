# Confirm-page PIN guesses from strangers go through the sign-in limits (SEC-135)

<!-- bump: patch -->

## What Changed

SEC-135 (medium). The recommended-services confirm page (`GET`/`POST /recommended-services/:id/confirm`) is reachable before any sign-in, and every page open minted a fresh token with its own 5 wrong PIN guesses. With up to 30 opens a minute for anyone, a stranger could make about 9,000 PIN guesses an hour per machine.

Behind one switch, `security.approvalLinks.enabled` (dev-gated: live on development agents, dark on the fleet until the maturation review graduates it):

- The sign-in page's public PIN limits are exposed to routes as one hook (`ctx.publicPin`: `context` and a synchronous `verify`). Sign-in and step-up were refactored onto the same internal functions; their answers and wording are unchanged.
- A confirm answer from a browser that never unlocked the dashboard, away from the machine, is admitted and charged exactly like sign-in (per-source backoff, the per-network budget, the public aggregate of 20 wrong per 5 minutes shared with sign-in), plus the existing per-page budget, in one store write (`PinAttemptStore.recordFailures`). A refused answer gets one fixed `pin-paused` wording that names the ways through. A browser that unlocked the dashboard before, and the machine itself, keep their own allowances, as on sign-in. The per-page budget holds even when the counter store is unavailable.
- Page opens from such a browser or the machine itself (with the page's own `X-Instar-Request` header, which other websites cannot send) get their own 30-a-minute allowance and protected tokens that a stranger flood never evicts. The page retries a refused open with brakes and explains an expired page.
- `GET /recommended-services` reports per-machine `confirmStats` (flushed at most once a minute), `unknown` with a reason when unreadable.
- `state/pin-attempts.json` and the new `confirm-stats.json` are declared in the state coherence registry (machine-local).

With the switch off, the confirm page behaves exactly as before. `/mcp/approve/:id` and the email-code route are unchanged.

## What to Tell Your User

- **Approval pages are harder to guess at**: "My yes-or-no pages for outside services now have the same PIN guessing limits as the dashboard sign-in. If one ever says it is paused, open it in a browser you have signed in to the dashboard with before, or on the computer I run on, or wait a few minutes."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Confirm-page answers on sign-in's PIN limits | Automatic on development agents; `security.approvalLinks.enabled` |
| Confirm-page counters per machine | `confirmStats` in `GET /recommended-services` |

## Evidence

- `tests/unit/sec135-approval-link-verify.test.ts` (new, 18 tests, real AgentServer): stranger path, one verifier (including the parallel last-attempt race), owner paths, CORS preflight, no wrong exemptions, sign-in wording unchanged, store outage, switch off.
- `tests/unit/sec135-store-and-stats.test.ts` (new, 11): one persist per wrong guess, counters flush at most once a minute, unreadable file reports unknown, token store owner allowance and eviction.
- `tests/unit/sec135-service-yes-page.test.ts` (new, 7): the real page script in jsdom.
- `tests/integration/sec135-approval-link-flood.test.ts` (new) and `tests/e2e/sec135-approval-link-alive.test.ts` (new).

# Side-effects review: pool reads fall through a dead rope

## Change
`src/server/poolPeerFetch.ts` (the one function all ~30 pool-scope reads dial through):
1. A Cloudflare edge error (HTTP 520–530 on a `cloudflare` rope) is recorded as a rope failure instead of a working rope. Instar never sends these codes; Cloudflare sends them when it cannot reach the peer.
2. For GET requests only, when the rope is dead (the dial threw, other than abort/timeout, or a Cloudflare edge error came back), the next rope in the peer's `ropes` list is tried, in resolver order. A fallback rope must pass `isPeerUrlAllowedForCredentials` with no caller allowlist (the strict default), so the API token is never sent to an address the guard would refuse.

## Evidence
On the Studio (2026-11-02) Mama PC's pooled reads failed on every attempt with HTTP 530 from its tunnel while the pool liveness check reached it directly seconds earlier; `poolPeerFetch` recorded each 530 as a healthy rope, so the tunnel stayed selected. Mac M5 Pro intermittently failed with "fetch failed". Both showed on Home as "part of the list could not be checked".

## 1. Over-block
None. Fewer reads fail.

## 2. Under-block
A fallback rope the strict guard refuses (for example plain-http Tailscale) is skipped, so a peer reachable only that way still fails as before (tested). A peer whose only live rope is slower than the caller's remaining budget still times out.

## 3. Level-of-abstraction fit
The single pool-read dial point, which already owns rope-health recording. The desktop path got the same fallthrough in #2592; this applies it to reads.

## 4. Signal vs authority
The credential guard stays the authority for every rope; this only adds attempts it admits. The rope-health record now gets a correct signal for edge errors.

## 5. Interactions
The caller's `AbortSignal` is shared across attempts, so total time never exceeds the caller's budget; an abort or timeout is never retried. A real peer reply of any status (including 503 for a dark feature) is returned as-is and recorded healthy, as before. Non-GET requests never fall through (they may act on the peer). Call sites that pass a target without `ropes` behave exactly as before.

## 6. External surfaces
None beyond fewer failed pool reads (Home, sessions, jobs, guards, attention).

## 7. Multi-machine posture
This is the multi-machine read path itself. Each machine applies it to its own outgoing reads.

## 8. Rollback cost
Revert the commit.

## Class closure
unbounded-self-action: n/a. A bounded, per-request retry across the peer's own advertised ropes (at most one attempt per rope, within the caller's single timeout); no background loop or self-triggered action.

## Second-pass review
Concur with the review. No new reach for the token: fallback ropes come from the same candidate list the selector already chooses from, held to the strict guard (a subset of what callers admit). All POST callers dial once; the GET callers are status and list reads. Only `cloudflare` ropes and 520–530 are affected, codes the server never sends. Every caller passes `AbortSignal.timeout`, shared across attempts; aborts are not retried. Nit applied: a discarded edge reply's body is cancelled.

# Side-effects review: late ordinary Telegram capacity

**Author:** Echo
**Independent reviewer:** Hooke; design, implementation, corrected coverage and artifact concurred.

## Scope and governing contract

Justin authorized remaining delivery repairs in topic69507. This independent
repair starts at deadline candidate7e2eb5900, which includes releasedv1.3.1233's
permanent model correction. The deadline repair must ship separately first.
Governing approved contract: [Telegram message origin](../../docs/specs/telegram-message-origin.md),
particularly N10 shared capacity and the original admission, charged-attempt,
deadline and uncertain-outcome rules.

A real claim or markDispatched call whose response takes more than250ms reproduced
the old pre-network capacity expiry. Live operation50b9019b-fb9c-41e1-b51a-478b9381a47e
also recorded a capacity refusal, then was accepted by its original recovery.
Its224ms claim-to-result interval does not include reservation time and does not
prove the live refusal was expiry. IPC, ownership and capacity refusals still share
the existing reason; better stage diagnostics remain separate work.
<!-- tracked: topic-69507 -->

## Decision points

- Grant acquisition moves after durable dispatch intent and final origin/policy checks.
- Prepared closure availability remains single-use and latches before any await.
- Actual owner reservation, consumption, expiry and lease checks remain authoritative.
- Known pre-network refusal remains charged; native-fetch uncertainty remains held.

## 1. Over-block

The new grant can still expire during reserve/consume IPC. It refuses rather than
renewing or refunding capacity. Saturation, which previously held before a claim,
now produces a charged known-failed attempt after dispatch intent. Sustained
saturation can exhaust the existing nine transport attempts without a wire call.
This tradeoff is explicit: never erase durable dispatch intent or reset the
original operation to make the refusal look uncharged. Missing capacity DI still
holds before claim. The original six-hour default deadline and fifteen-minute
review pacing remain unchanged.

## 2. Under-block

Only one reserve and consume can occur per prepared closure, including concurrent
calls. A failed durable mark never reserves; rejected or expired consumption never
calls the network. The parent deadline change demotes proof-shaped errors emitted
after native fetch, so a recycled capacity or cancellation error cannot authorize
replay. No authorization predicate, rate constant or IPC method is changed.

## 3. Abstraction fit

The existing prepared transport owns the last synchronous callback before network
invocation. Acquiring there avoids spending the short grant on unrelated durable
storage latency. No second capacity owner, renewed grant or recovery controller is
introduced. The actual owner retains the1250ms debit window and startup quiet
period that account for the250ms grant lifetime.

## 4. Signal versus authority

A delayed real durable response demonstrates the source ordering defect; it does
not establish fleet frequency. Tests delegate to the actual SQLite worker,
credential owner, HTTP route and Boot initialization. The IPC fixture connects to
the actual Boot socket in the same process; it is not a claim of a second-process
Lifeline lifecycle. Fixture Telegram receipts are the only substituted network
service. See [signal versus authority](../../docs/signal-vs-authority.md).

## 4b. Judgment points

No new model call, heuristic or policy decision is introduced. Existing policy
and owner checks retain their meaning and can hold a send.

## 5. Interactions

Fixed outage notices keep their separate reserved-notice lifecycle and share the
unchanged owner with ordinary sends. Existing grant/debit-window tests cover
ordinary/notice sharing and replacement-owner quiet time; this repair does not
claim a new mixed native-wire timestamp proof. Compatibility includes notice
expiry, outage queue drain, cancellation, recovery pacing and uncertain receipts.

## 6. External surfaces and migration

No endpoint, config or IPC schema change. The agent awareness builder feeds
scaffold generation; idempotent migration adds the new paragraph to existing
CLAUDE.md, AGENTS.md and GEMINI.md even when older origin text is already present.
No custom text is replaced. Source changes reach existing server and Lifeline
processes through normal update and process activation; merely installing a
package does not prove an older running Lifeline loaded it.

## 6b. Operator surface

No new approval or control. The upgrade guide explains the timing repair and
charged-attempt tradeoff. Retained operations must not be copied or replayed as
new messages to work around a hold.

## 7. Multi-machine posture

The current lease owner remains the only capacity authority. Standby, revoked
lease and replacement-owner checks continue to fence sends. No session token is
forwarded to a peer, and no direct standby bypass is added.

## 8. Rollback

Revert this repair and publish a patch; no durable data migration or queue clearing
is needed. Reverting restores the reproduced early-grant expiry behavior.

## Evidence and review

Four real-path regression cases failed against unchanged production source.
The minimal fix passed26 targeted tests across four files. Expanded unit, real
HTTP/IPC, Boot restart lifecycle and migration/completeness checks passed170 tests
across five files. Review required moving older expiry fixtures to the new
reserve/consume boundary and adding lease revocation after dispatch; that
compatibility run passed all72 tests across ten files, including both expiry
cases, late lease revocation, uncertain outcomes, recovery pacing and the real
Boot restart. Build and lint passed. Full test:all and CI remain required
before this repair's separate release. Class closure unbounded-self-action is n/a:
this repair adds no automatic retry or autonomous actuation controller and claims
no generic convergence coverage.

### Existing HTTP capacity compatibility

A later compatibility audit found the pre-existing reply-route test still expected
zero attempts when shared capacity was exhausted. A focused run failed exactly on
that obsolete expectation (one attempt was recorded). The updated test preserves
the actual HTTP/IPC path and requires409, no wire call, one dispatched known-failed
attempt, and subsequent acceptance on the same nonempty canonical operation ID.
It also preserves the original deadline and maximum attempts, retains the first
attempt unchanged and requires a second accepted attempt. The generic service
contract for other transports that invalidate before dispatch remains unchanged
and keeps its existing tests. A five-file compatibility run passed87 cases and
failed this case because its earlier1251ms wait ignored the existing30-second
known-failure backoff. The corrected case passed separately (one passed,25 skipped):
free capacity alone cannot trigger recovery, a reservation before the persisted
retry time is refused, and recovery succeeds after a real wait until that time.
The charged child count advances from one to two. This is not a claim that a fresh
combined88-case run passed. No production source change, delay reduction, or
additional recovery permission is introduced; full validation remains pending.

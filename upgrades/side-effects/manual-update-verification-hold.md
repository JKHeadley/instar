# Side-Effects Review — manual update preserves verification

**Version / slug:** `manual-update-verification-hold`
**Date:** `2026-10-31`
**Author:** `Echo`
**Second-pass reviewer:** `gpt-6-Astra, 2026-10-31; concerns resolved and re-review concurred`

## Summary of the change

`POST /updates/apply` keeps the existing bounded restart holds even though it bypasses the preferred restart time window. A caller can explicitly send `forceRestart:true` to bypass those holds, including after the update was installed and the restart was left waiting. The change touches `AutoUpdater`, its HTTP route, Local Verify documentation and awareness, and all three test tiers. The motivating manual update cancelled PR #2499's full check after 11.6 minutes; the Local Verify log records 49.4 spent minutes across 15 interruptions, with 18.7 minutes in the last day. The aggregate includes other restart causes and is not an estimate of the fix's exact savings.

**Declared tier:** 1. This is a narrow, reversible correction to an existing hold gate: it uses the current bounded provider and deferral timer, adds one explicit override, and a revert fully restores the prior behavior. Because it touches restart admission and an API field, independent restart-lifecycle review and the complete test suite are still required. Scope: 16 files, roughly 380 changed lines including tests and documentation; one review round with one correction pass, and no commit/gate attempts yet.

## Decision-point inventory

- `AutoUpdater.gatedRestart` — modified: separates bypass of the clock window from bypass of active-work holds.
- `POST /updates/apply` — modified: validates the optional force flag and passes it to the updater; normal requests keep holds.
- `UpdateGate` and `LocalVerifyService.restartHolds` — passed through: they remain the sole provider and evaluator of bounded hold state.
- Local Verify success/merge authority — unchanged: a restarted check still needs a fresh full result.

## 1. Over-block

A routine manual update can now wait behind a long active verification, although its package has already installed. The hold has an absolute deadline derived from that run and the updater's maximum deferral, and the response exposes `restartDeferral`. An operator who truly needs an immediate restart can explicitly force it. A hold provider that incorrectly reports a live run could delay an update up to that bounded ceiling; the existing `UpdateGate` cap remains the recovery limit.

## 2. Under-block

Direct process restarts, crashes, and the route's legacy fallback when no AutoUpdater is wired can still interrupt a run. An explicit forced restart intentionally does so. The change does not claim to preserve a child across a restart; it prevents this specific ordinary manual update path from needlessly causing one. The existing queue safely replays an interrupted check.

## 3. Level-of-abstraction fit

The route states caller intent. `AutoUpdater` owns restart timing. `UpdateGate` already evaluates live, bounded holds from Local Verify and other providers. Reusing that gate avoids a second local-verifier-specific blocker in HTTP or a brittle process-name check. The hold is a structural fact about an in-flight child, not a guess about a message's meaning.

## 4. Signal vs authority compliance

The architecture follows [Signal vs Authority](../../docs/signal-vs-authority.md). The Local Verify service supplies a typed, time-bounded hold; `UpdateGate` is the one restart admission authority. The added boolean validation is a hard API shape invariant. No string matcher, similarity score, or heuristic acquires blocking authority. The explicit force field passes a caller's decision to that same authority.

## 5. Interactions

Automatic update timing is unchanged. Manual apply still bypasses the preferred clock window; it now uses the already wired hold, durable deferral record, and retry timer. Local Verify's update-pending rule prevents a busy PR queue from perpetually starting new checks while this restart waits. The second forced request consults the saved deferral because the package is no longer pending. The ordinary session gate and same-version restart cooldown still run. The route's no-AutoUpdater fallback remains direct apply, as before.

## 6. External surfaces

The update API response can now show `restartDeferral` after a manual apply. The optional `forceRestart` field is rejected when its type is wrong; unknown fields are rejected. Agent templates and migration explain the new behavior to existing and new agents. Users may see the updated version become active after the current verification run and normal session gate clear, rather than seeing an interrupted check start again.

## 7. Multi-machine posture

The hold is machine-local by design: each Instar process knows its own verification child, and the serving coordinator uses its own updater. The peer machines keep separate update and test state. No replicated ledger or cross-machine decision is introduced. The existing serving lease controls the one voice that communicates with the user, and no new notification is emitted by this change.

## 8. Rollback cost

A code revert restores the former manual-apply behavior. The deferral record gains an optional `bypassWindow` field; older records still parse and no data migration or state repair is needed. A pending bounded deferral can be allowed to finish or deliberately forced through the existing route before rollback.

## Evidence

Build and lint passed. The focused unit suite passed 145 tests; the HTTP integration file passed 6 tests; the production AgentServer lifecycle test passed after wiring its callback dependencies. The full `npm run test:all` suite passed on the M5 compute worker from the final source: 53,829 unit, 4,992 integration, and 3,623 E2E tests passed; the new lifecycle file passed. The first remote attempt was invalid because a generated manifest had been built before final source sync; it was rebuilt, and the complete second attempt passed. The exact-head merge gate remains required before shipping.

## Second-pass review

**Reviewer:** gpt-6-Astra (independent restart-lifecycle review, 2026-10-31)

The first pass found that a deferred manual apply lost its restart-window bypass on retry, `forceRestart:null` was accepted, and a template bullet broke a Markdown table. Those were corrected. A regression test now runs hold release and session retry outside the preferred window, including recovery from the durable deferral record. The reviewer re-read the revised diff and found no remaining P1/P2 blockers. **Concur with the review.**

## Class-Closure Declaration

No agent-authored prompt, hook, config, skill, or standards defect is fixed here. The change does not add an autonomous restart trigger or retry edge; it changes admission for a request initiated through the manual update route. The existing bounded retry timer is unchanged. Class closure is not applicable.

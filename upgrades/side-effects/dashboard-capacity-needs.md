# Side-Effects Review — Capacity waits on Agent

**Version / slug:** dashboard-capacity-needs
**Date:** 2026-11-17
**Author:** Echo
**Second-pass reviewer:** review_work_folds

## Summary of the change
The declared sessions-full health rule gains optional requiresUserAction:false, propagated to the read. The shared healthNeedRows model excludes only explicit false. console.js mounts an authenticated Agent status dot. Health retains its warning, verdict and action. Approved work-front-doors §2.1; live /needs snapshot showed this ordinary wait among twelve person-action items.

## Decision-point inventory
- Health rule: add explicit source metadata for one known ordinary capacity wait.
- Needs rows: omit that explicitly non-actionable issue only; missing marker retains existing behavior.
- Agent dot: note / clear / unknown from authenticated health read; failed/truncated reads never imply clear.

## 1. Over-block
No block/allow surface. Nothing stops work or filters messages. The omitted Needs row remains visible through Agent and Health, with the Sessions link intact. Only explicit boolean false is honored; missing or malformed metadata preserves the row.

## 2. Under-block
No block/allow surface. Other user-affecting health issues remain Needs rows. This does not claim every health issue's actionability has been reclassified. A full queue can coexist with a real fault; that fault remains independently visible.

## 3. Level-of-abstraction fit
The declared source rule owns its meaning; clients do not match title text or blacklist IDs. One pure model feeds Home and the server's shared owner/mobile Needs composer. The Agent dot consumes the existing health read and opens the existing door.

## 4. Signal vs authority compliance
Reference: docs/signal-vs-authority.md. No block/allow surface. Presentation consumes an explicit source signal. Health reporting, scheduler, session management and permission authorities are unchanged.

## 4b. Judgment-point check (Judgment Within Floors standard)
No new static heuristic at a competing-signals decision point. The enumerable invariant is the existing sessions-full source: current session count reaches the configured maximum, and new work waits. It does not infer intent, task priority, urgency or safety from text. All other issue meanings remain unchanged.

## 5. Interactions
Health counts/verdict and Health page retain capacity. Needs count drops only the explicit wait. Agent dot uses one active mount, one in-flight request and a 45-second interval; replacement cancels old painting and disconnect stops polling. It never writes server state or drives recovery. No notifications or cleanup races are added.

## 6. External surfaces
Existing health JSON gains one optional field. Older readers ignore it; missing metadata stays conservative. Owner-phone Needs counts follow the server composer automatically. The console dot uses existing authenticated access, including existing refusal behavior for unauthorized viewers. No durable state or config changes. No new operator action; existing Health and Sessions routes remain reachable on phone width.

## 6b. Operator-surface quality
1. Primary action: real Needs-you actions retain their position; ordinary waiting no longer competes with them. Agent remains a direct navigation link.
2. Raw internals: no IDs, hashes or JSON are rendered. Dot text says work is waiting or status could not be read.
3. Destructive actions: none added. No stop button or capacity change is suggested to clear a dot.
4. Plain words and phone width: actual shell checked at390/1280, including Agent→Health and failure state; no new table or horizontal layout.

## 7. Multi-machine posture (Cross-Machine Coherence)
Machine-local BY DESIGN: available session slots belong to the responding machine. Existing health machine naming and Needs source posture remain intact. No replicated durable state, user notifications or cross-machine URL changes. The dot describes the current agent server's health read, not a fleet-wide all-clear.

## 8. Rollback cost
Revert the isolated commit and release. No migration or state repair; the previous Needs row returns. No installation or production restart performed by this branch owner.

## Conclusion
Narrow presentation correction to the approved action/status distinction. Health observability and action links preserved. Local targeted tests and browser evidence accompany the change; full integration/e2e verification belongs to Local Verify before merge.

## Second-pass review (if required)
review_work_folds independently concurred with source changes: explicit-only exclusion, Health retained, authenticated dot, lifecycle and failure handling. Artifact review concurred except pending browser evidence and spacing; both corrected after the actual-shell browser checks passed at 390/1280.

## Evidence pointers
Unit producer, console model, Agent dot, shared composer; signed integration health marker and production Needs alive regression authored. Logs /tmp/capacity-needs-{focused,guards,build}.log and /tmp/capacity-needs-browser-proof.log. 1140 tests in39files passed. Actual-shell390/1280 checks passed Agent dot, empty Needs-you, Agent-to-Health retained warning/action, failure unknown, authentication and no overflow/runtime errors. Full tiers run by throughput under maintainer authorization f4adb757; not claimed locally.

## Class-Closure Declaration (display-only mirror)
No agent-authored-artifact defect — not applicable. Browser read-only polling performs no self-triggered restart, spawn, notify, retry of an action, or recovery authority.

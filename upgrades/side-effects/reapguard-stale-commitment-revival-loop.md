# Side-Effects Review — ReapGuard stale-commitment revival loop

**Version / slug:** `reapguard-stale-commitment-revival-loop`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `general-purpose reviewer subagent (lifecycle change — required)`

## Summary of the change

`ReapGuard` (the shared, stateless "is it safe to reap this session?" guard) has two methods that read an open commitment differently. `evaluate()` (the KILL decision) only keeps a session alive on an open commitment while the topic has had a user message within `staleCommitmentWindowMs` (default 8h); past that the commitment is "abandoned" and the idle session is reaped (staleness gate added 2026-06-06). `workEvidence()` (the RESUME-eligibility decision) emitted `open-commitment` evidence for **any** active commitment, with **no** staleness gate. So the same guard killed an idle session (commitment stale ⇒ reap) and immediately tagged it resume-eligible (commitment exists ⇒ revive), looping forever.

Evidence (live `logs/reap-log.jsonl`, 2026-06-13): 13 age-limit reaps with `midWork=true`, **all** carrying solely `workEvidence=[open-commitment]`, across 6 topics (multi-channel-support, Resource Limitation Mitigation, instar evolution, Subscription & Auth, instar-exo, Topic UX). The resume queue showed repeated `reason=age-limit` respawn entries, several doubled per topic.

The fix: one line in `ReapGuard.workEvidence()` — the `open-commitment` probe now applies the identical predicate `evaluate()` uses (`protectOpenCommitments && activeCommitmentForTopic && recentUserMessage(staleCommitmentWindowMs)`). Files touched: `src/core/ReapGuard.ts` (the probe + a comment), `tests/unit/work-evidence.test.ts` (a new regression `describe` block).

## Decision-point inventory

- `ReapGuard.workEvidence()` open-commitment probe (`src/core/ReapGuard.ts`) — **modify** — narrows when `open-commitment` is emitted as work evidence to match the KEEP guard's staleness horizon. This is a SIGNAL producer (work evidence consumed by the resume queue / reap-notify), not a blocking authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

This change narrows a SIGNAL (work evidence), not a block/allow gate. The "over-block" analogue is: does it now suppress `open-commitment` evidence for a session that genuinely had interrupted work? No. To be age-killed at all, a session must be idle-at-prompt with no live processes (the age-gate's `ageGateTrulyIdle` check) — a genuinely-busy session is deferred, never killed. And by the time `workEvidence()` runs as the fallback, `blockedReason()` has already returned null, meaning the commitment was already judged stale (no user message in 8h). A session with real interrupted work carries OTHER evidence (`structural-long-work`, `active-subagent`, `pending-injection`, `active-process`, `main-process-active`) which are untouched. A commitment touched within 8h still emits `open-commitment` (covered by the "FRESH commitment" test). No legitimate revival is lost.

## 2. Under-block

**What failure modes does this still miss?**

The change does not, by itself, drain the 279 already-`pending` commitments that fuel the loop — but it makes them HARMLESS for revival (a stale one no longer revives). A separate, careful runtime hygiene pass to mark genuinely-delivered commitments is tracked: <!-- tracked: topic-18423 --> (operator-visible follow-up on the live machine; not a code deferral). It also does not change the age-limit reaper killing idle sessions — that is correct behavior and out of this fix's scope by design (the loop was the *revival* half, not the kill).

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. `ReapGuard` is the single shared guard both the reaper and the terminate authority consult; aligning its two methods at that one place fixes every killer that uses the `workEvidence()` fallback (the age-limit path does). Putting the staleness logic anywhere downstream (resume queue, reap-notify) would patch one consumer and leave the evidence itself wrong for the others. The correct owner of *promise* follow-through (the commitment beacon / overdue-commitment job) is a different subsystem and is intentionally left to do its job — this fix stops the resume queue from double-covering it on a stale signal.

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or produce a signal that feeds a smart gate?** (ref: `docs/signal-vs-authority.md`)

Compliant. `workEvidence()` is a pure SIGNAL producer — observe-only evidence collection. It holds no blocking authority (the KILL authority is `evaluate()`/`blockedReason()`, unchanged). This change makes the existing signal MORE accurate by removing a false-positive; it adds no new brittle check and no new authority.

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, race with cleanup?**

The two `ReapGuard` methods now use one identical predicate, removing the contradiction that WAS the bug. No race: `workEvidence()` is only collected after `blockedReason()` returned null (a non-null keep returns early at terminateSession before evidence is gathered), so the two never disagree on the same live state. Downstream consumers behave correctly: dropping the sole `open-commitment` signal flips `isMidWork`→false and `evidenceEligible`→false, which correctly prevents (a) `ResumeQueue` enqueue (gated on `evidenceEligible`), (b) the server's live enqueue (gated on `midWork===true`), and (c) boot-reconciliation re-enqueue from the reap-log (also `midWork===true`). The reaper's own idle path supplies authoritative `workEvidence:[]` and is unaffected (it was never the loop's source).

## 6. External surfaces

**Does it change anything visible to other agents/users/systems?**

User-visible: fewer "your session was shut down — a restart is queued" notices on topics with no genuinely-unfinished work; the looping topics settle. Reap-log entries for these reaps now record `midWork:false` (honest — they were idle reaps, not interrupted work). No agent-to-agent or cross-system surface. No new timing/runtime dependency — it reuses the same in-memory `recentUserMessage` dep `evaluate()` already calls.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** `ReapGuard` evaluates the LOCAL machine's sessions against that machine's local topic-state deps (topic binding, recent-message, active-commitment). Session reaping is inherently a per-machine operation — a machine reaps its own sessions — so there is no replication path to add and none is wanted. The commitment registry that backs `activeCommitmentForTopic` follows its own (separate) cross-machine story; this change reads it identically to how `evaluate()` already does, so it introduces no new multi-machine assumption. No user-facing notice voice, durable-state-on-transfer, or generated-URL concern applies.

## 8. Rollback cost

Cheap. Pure code change, no migration, no persisted-state shape change. Back-out = revert the one-line probe to its prior form (`upgrades/eli16/...` + git revert) and ship a patch. The reap-log entries already written are inert historical records. Config knob `staleCommitmentWindowMs: Infinity` independently restores the always-protect behavior for BOTH methods consistently (now that they share the predicate) without a code change, if a site wants the old revival behavior back immediately.

---

## Second-pass review

**Reviewer:** independent general-purpose reviewer subagent (required: change touches session lifecycle kill/recovery + a "guard").

**VERDICT: Concur with the review.**

The reviewer independently audited `ReapGuard.evaluate()`/`workEvidence()`, the `SessionManager.terminateSession` evidence path (lines 825–925), and the new tests, pressure-testing all five risk dimensions:

- **A (over-block):** could not construct a genuinely-interrupted session left un-revived; busy sessions never reach the age-kill, and real work carries other evidence.
- **B (race/consistency):** the two methods now use the identical predicate triple; the benign `recent-user-message`/`open-commitment` independence in `workEvidence()` cannot resurrect the loop (for a stale session both windows are false; workEvidence is recomputed from the same live deps regardless of WHY evaluate cleared).
- **C (killer-supplied evidence):** grepped every killer supplying explicit `opts.workEvidence` — only the idle-reaper (authoritative `[]`), the operator force-resume (`['active-build-or-autonomous-run']`), and tests. The age-limit path supplies none → uses the patched fallback. The fix reaches the path that actually fired.
- **D (config edges):** `protectOpenCommitments:false` and `staleCommitmentWindowMs:Infinity` now behave consistently across both methods.
- **E (downstream):** correctly prevents ResumeQueue enqueue, server live enqueue, AND boot-reconciliation re-enqueue (all `midWork===true`/`evidenceEligible` gated); ReapNotifier reports the idle reap honestly.

No concern raised; no design iteration required.

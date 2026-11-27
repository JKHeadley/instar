# Side-Effects Review — planned-restart peer hold covers the whole peer run

**Version / slug:** `peer-restart-hold-covers-run`
**Date:** `2026-11-15`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see Second-pass review)`

## Summary of the change

Tier 1. 9 files, about 60 changed lines, one runtime line. Effort: no spec round (amendment to an existing converged spec's constant), one build attempt, one test fix.

`PEER_RESTART_HOLD_MS` in `src/core/PlannedRestartVerifyGuard.ts` goes from 21 minutes to 61 minutes (the peer run ceiling `PEER_LIMITS.maxRunMs`, 60 minutes, plus one `pollMs`). The constant bounds how long a planned restart waits for a Local Verify run that the coordinator has handed to a peer machine. It was taken from an audit in which peer runs took a median of 13 minutes. Runs now take 22 to 25 minutes, so the hold expired one to four minutes before the result was imported, the restart went ahead, the lease epoch moved and the run was abandoned `lease-changed` (2026-11-15, PR 3198, 22 peer-minutes lost; 37 of 38 green peer runs that day exceeded 21 minutes).

Files: `src/core/PlannedRestartVerifyGuard.ts` (the constant and its comment), `src/localVerify/peer.ts` (one comment corrected, no behaviour), `tests/unit/planned-restart-verify-guard.test.ts` (new cases, one case re-anchored to the constant), `docs/specs/planned-restart-local-verify-hold.md` and its ELI16, `docs/specs/local-verify-peer-skew-audit.eli16.md` (the stated bound), plus this change's own ELI16 and release note.

## Decision-point inventory

- `plannedRestartVerifyState` / `peerAttemptHoldUntil` (`src/core/PlannedRestartVerifyGuard.ts`) — modify — the bound of the peer hold read by the lifeline supervisor and the foreground restart watcher.
- `LocalVerifyService.restartHolds` (`src/localVerify/LocalVerifyService.ts:1130`) — pass-through — the updater's in-process hold reads the same constant; its `now + maxDeferralMs` cap is unchanged.
- `LocalVerifyService.auditPeerHolds` (`:2451`, `:2461`) — pass-through — the `restart-held-for-peer` / `bound-reached` audit events follow the constant.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The "block" here is a deferred restart. The new over-hold case: a peer that keeps answering result polls within two minutes, with the coordinator's heartbeat fresh, but whose run never finishes. That peer can now defer a routine planned restart for up to 61 minutes from dispatch instead of 21. What ends such a run is the 60-minute run ceiling (`PEER_LIMITS.maxRunMs`, enforced on the peer and on the coordinator), which abandons the attempt and so removes it from the heartbeat; the real worst case is therefore 60 to 61 minutes. `forceRestart` (`bypassHolds`) ignores the hold entirely and is unchanged; it is the route for an urgent restart.

A healthy run does not wait longer than before in any case that worked before: the hold ends when the attempt leaves the heartbeat (imported, abandoned, lease changed), not at the bound.

---

## 2. Under-block

**What failure modes does this still miss?**

- The lifeline supervisor is a separate long-lived process and keeps the code it started with (noted in `LocalVerifyService.ts:1124-1126`). On a machine whose lifeline process was started before this change, the supervisor path still uses 21 minutes until that process is restarted. The updater path (`restartHolds`, in the server process) uses the new bound on the first server start after install. Not fixed here; it is the existing property of every supervisor-side change.
- A restart that fires within the few seconds between the run finishing on the peer and the next result poll importing it is still covered: the attempt stays listed until import, and the bound is now far past it.
- A run longer than 61 minutes is not held. `PEER_LIMITS.maxRunMs` abandons such an attempt at 60 minutes anyway, so there is nothing left to protect.
- `restart-peer-hold-ended` is not written when the supervisor wins a race exactly at the bound. Unchanged, and now rare because the bound is rarely reached.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The bound is an invariant-style floor in the cross-process guard, read by every restart consumer from one constant. The liveness judgment (is the peer actually still working on it?) already lives in the verifier's heartbeat and its four typed conditions; this change does not move or duplicate that. The earlier value encoded a measurement (run length) that belongs to a different part of the system and drifts; the new value is derived from the limit that part of the system enforces (`PEER_LIMITS.maxRunMs`), and a unit test asserts the relation. The constant stays a literal in `core/` rather than importing `localVerify/peer.ts`, which keeps `core` free of a dependency on `localVerify`; the test is what ties the two.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — an existing bounded invariant (arithmetic on typed, fresh, machine-written facts), not a judgment on content.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The hold defers a restart; it never blocks one for good. It is the same invariant the converged spec `planned-restart-local-verify-hold` classified as an invariant (typed marker, fresh heartbeat, bounded, unreadable input never defers, explicit bypass). This change alters only the bound. No string matching, no heuristic over competing signals is added.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals decision point. The bound is a ceiling (a floor in the standard's sense) around facts the verifier already measures; whether the peer is still alive is decided by those facts, not by this number.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- Three-hour request ceiling (`VERIFY_RESTART_HOLD_MS`) and the `Math.min(..., pendingSinceMs + VERIFY_RESTART_HOLD_MS)` cap: unchanged, still dominate. A test in the file already covers the cap.
- Updater's `maxDeferralHours` ceiling (four hours by default): unchanged; `restartHolds` still takes `Math.min(sentAt + bound, now + maxDeferralMs)`.
- Update pause: while an update or planned restart waits, the verifier hands out no new peer runs (`notePause()` re-check before reservation), so a longer bound cannot chain holds. Unchanged.
- Merge hand-off hold: the combined bound is still the later of the peer and merge bounds. The existing test for that combination hard-coded a 20-minute-old attempt whose bound was assumed to be earlier than the merge bound; it is now anchored to the constant.
- `peerVerifier.test.ts` uses the constant symbolically (lines 718, 850, 857) and passes unchanged (75 tests).
- Request expiry: the hold can now outlast a restart request's own 60-minute `expiresAt` (it could not at 21 minutes). Delivery then relies on the deferral proof written by `markPlannedRestartDeferred`, the same route the three-hour local-run hold already uses; if that write fails the restart proceeds, so it fails open.
- `bound-reached` audit event: the coordinator's 60-minute `run-bound` abandon now fires before the 61-minute bound, so `bound-reached` is close to unreachable in production. The spec's graduation line says so.
- Coordinator restart while a peer attempt is `accepted`: the abandon-on-lease-change behaviour is unchanged; this change makes it rarer.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- `GET /updates/status` → `restartDeferral.reason` shows "a peer verify of PR #N is running (until <time>)". The time shown is now up to 61 minutes after dispatch instead of 21. Wording unchanged.
- `restart-held-for-peer` audit events carry a later `boundAt`.
- No route, config key, message or dashboard change. No operator surface touched (6b not applicable).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The guard reads files in this machine's own state directory (`restart-requested.json`, `local-verify/peer-hold.json`, `inflight.json`) and decides this machine's own restart. Only the lease-holding coordinator writes a peer-hold heartbeat (the verifier lists attempts only while `lease.holds` and the epoch matches), so a standby never holds on peer work. The peer machine's own restart is governed by its local in-flight marker, not by this constant. No user-facing notice, no durable state that could strand on a topic transfer, no generated URL. No `/status`, `/health`, `/capabilities` or `/channels` answer changes shape.

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Revert the one-line constant (and the tests and wording) and ship a patch. No persistent state, no migration, no config. During a rollback window the only visible effect is the old behaviour: a waiting restart may again cut off a peer run.

---

## Conclusion

A measured-value bound had gone stale as the suite grew and was silently discarding nearly finished peer runs. The bound is now derived from the run ceiling and a test keeps the relation. The one real cost is the larger worst case for a peer that answers but never finishes (61 minutes instead of 21), which the 60-minute run ceiling ends and `forceRestart` bypasses. The supervisor-process caveat in section 2 means machines pick the change up fully only after their lifeline process restarts. Clear to ship.

Found along the way, triaged and not added to this change:
- `waiting-restored.downtimeMs` reads as server downtime but measures the age of an empty waiting list; it misled the first reading of this incident. Queue: feedback.
- `POST /updates/apply` records nothing about its caller. Queue: feedback.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (fresh context, given the code and asked to find faults; not the author)
**Independent read of the artifact: concern, resolved**

The reviewer read the guard, every use of the constant, the dispatch pause, the supervisor, the foreground watcher, the updater and both test files, and ran both test files (26 and 75 passing). Verdict on the code change: nothing blocks it; no new chaining or starvation (dispatch re-checks the pause; the three-hour cap, `now + maxDeferralMs` and the updater's hold ceiling all hold with the larger value); no hard-coded 21-minute value tied to this hold remains in `src/` or `tests/`; the new cases fail on the old constant and the re-anchored merge test keeps its geometry.

Concerns raised, all in the written claims, and their resolution:

- The claim that a 45-minute lane deadline ends a stuck run sooner was false (lane limits are 40/45/60 minutes with a 120-minute active total; what ends a stuck run is `PEER_LIMITS.maxRunMs` at 60 minutes). Resolved: the spec, the ELI16 and this artifact now state the 60-minute run ceiling and a 60 to 61 minute worst case.
- Two lines of the amended spec still said 21 minutes. Resolved: both amended.
- `bound-reached` is now close to unreachable. Resolved: stated in the spec and in section 5.
- The hold can outlive the request's 60-minute expiry and then relies on the deferral proof. Resolved: stated in section 5.
- A stale line reference in the spec. Resolved: removed.

The stale "45-min lane deadline" wording in the comment at `src/localVerify/peer.ts:87` is corrected in this change as well.

---

## Evidence pointers

- `npx vitest run tests/unit/planned-restart-verify-guard.test.ts` → 26 passed. With the old constant the new 22/25/40/59-minute case and the ceiling case fail.
- `npx vitest run tests/unit/localVerify/peerVerifier.test.ts` → 75 passed.
- `npx tsc --noEmit` clean.
- Incident: coordinator `local-verify.jsonl`, 2026-11-15: `restart-held-for-peer` 21:23:54Z and 21:34:54Z (bound 21:43:24.498Z), verifier events until 21:43:30Z, `queue-restored` 21:43:58Z, `peer-attempt-abandoned lease-changed` 21:44:28Z.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (The defect is a stale constant in product source; the guard added is the unit test tying it to `PEER_LIMITS`.)

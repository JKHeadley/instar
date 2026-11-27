# Side-Effects Review — a main verify runs on whichever host is free

**Version / slug:** `main-verify-either-host`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see Second-pass review)`

## Summary of the change

Tier 2, under `docs/specs/local-verify-main-on-peer.md` (it amends one clause of the approved `local-verify-capacity` Part D: a peer "never verifies `main`"). Runtime changes in `src/localVerify/LocalVerifyService.ts`, `peer.ts`, `record.ts`, `orchestrator.ts` and `localVerifyWiring.ts`; an awareness entry; tests in `tests/unit/localVerify/peerVerifier.test.ts`, `tests/unit/localVerify/record.test.ts`, `tests/integration/local-verify-peer-routes.test.ts` and `tests/e2e/local-verify-lifecycle.test.ts`; an ELI16 and a release note. Effort: one read-only scoping pass, one build, code review rounds and spec review rounds as recorded below; the first design was changed after the spec review (a peer could have turned main red by itself).

With a peer verifier configured, the coordinator handed the peer PR verifies only (`dispatchable()` excluded `kind: 'main'`, and the peer protocol, the record validator and the import path all assumed a PR number above zero). A `main` verify therefore always waited for the coordinator's own slot, even while the peer was free, and took that slot from the PR line while it ran. Measured on the Echo test machines on 2026-11-17: main waited 82 minutes on average and used 426 coordinator-minutes in the day (throughput brainstorm decision 2026-11-17, experiment E3).

Now, with the new switch `monitoring.localVerify.mainOnPeers` on (default off), a queued `main` verify is handed to a free peer while main is healthy, under the same fair-share rule as the local slot. While main is suspect or red every `main` verify is the coordinator's own, so a peer can make main suspect and never red. At most one `main` verify runs at a time on either host. The peer checks for itself that main contains the head. The coordinator imports the peer's record into main health only. A red result carries its failing files. The reservation survives a coordinator restart, and a peer that stops answering gives the verify back within five minutes.

Files: the five source files above, the three test files, `docs/specs/local-verify-main-on-peer.eli16.md`, `upgrades/next/main-verify-either-host.md`, this artifact.

## Decision-point inventory

- `LocalVerifyService.dispatchable()` / `dispatchOnce()` — modify — a `main` entry may be reserved for a peer only with the switch on and main healthy; fair share decides between it and the first dispatchable PR; a peer paused for unconfirmed refusals is offered PRs only.
- `LocalVerifyService.noteMainUnconfirmed()` — add — three unconfirmed refusals in a row pause `main` offers to that peer for 30 minutes and raise one signal.
- `LocalVerifyService.nextRunnableQueuedEntry()` — modify — a pending `main` entry does not start locally while a peer runs one.
- `LocalVerifyService.enqueueMain()` — modify — a peer-run `main` verify counts as in flight (never replaced, so never cancelled by a newer head).
- `LocalVerifyService.peerRun()` / `mainContains()` — add — the peer's own check that main contains the head.
- `LocalVerifyService.pollPeers()` — modify — a `main` record goes to `completeMain`; a silent peer gives a `main` reservation back after `PEER_LIMITS.mainSilentMs`.
- `LocalVerifyService.abandonRemote()` — modify — a `main` entry handed back beside a newer pending one is dropped.
- `persistQueue()` / `readQueueFile()` / `doRestoreQueue()` — modify — a reserved `main` entry is saved and restored.
- `peer.ts` `parsePeerRunRequest()` / `importRefusal()` — modify — optional `kind: 'main'`; `wrong-kind`.
- `record.ts` `validateRecord()` — modify — `attempt` allowed on a `main` record.
- `decideStart`, `decideMainEnqueue`, `completeMain` health logic, `MainHealth.onVerify`, the merge line — pass-through.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A pending `main` entry now waits while a peer runs another `main` verify, including when the coordinator's own slot is free. Intended (one main verify at a time, the invariant the single slot gave before); the cost is bounded by the peer run and by the five-minute silence rule.
- The peer refuses a head it cannot confirm main contains: main's head, the two commits under it, or an ancestor in its own clone. A legitimate older head whose commit the peer's clone lacks is refused (`head-moved`). The attempt is spent, the peer is not counted as failing, and after two attempts the entry runs on the coordinator as before.
- A `main` request carrying `isolation` or `preflightRediscoverable` is refused as malformed. The coordinator never sends either.

---

## 2. Under-block

**What failure modes does this still miss?**

- A peer whose environment differs from the coordinator's can make a healthy main suspect on its own (never red: the confirming re-run is the coordinator's). Merging pauses for the length of that one coordinator run. A Studio-versus-M5 disagreement on main is not yet raised as its own signal; it is visible in the audit log (`main-record` after `peer-imported` with the peer id).
- A peer that keeps answering "running" holds the reservation up to `PEER_LIMITS.maxRunMs` (60 minutes), as for PR attempts.
- A peer that is alive but unreachable never receives the cancel sent when its `main` reservation is taken back; its run ends at its own bound while the coordinator runs main again (two main runs at once, the orphan never imported). PR attempts behave the same way today.
- `mainContains` on a stale head can take longer than the coordinator's 10-second request timeout (one head read, two commit reads, one local ancestry check); the late refusal is then read as an unknown attempt and counts against the peer after two minutes.
- An `error` record from a peer-run `main` verify hands the entry back through the generic abandon path: it skips the per-head main error backoff and is re-offered at once, bounded by two remote attempts per entry.
- A machine that is both a coordinator elsewhere and a non-peer-only peer would share `mainRunOnCurrentHead` between its own and a handed `main` run. The Echo peer is peer-only; not addressed.
- The green main record that becomes the isolation baseline (`saveGreenMain`) may now come from the peer, so the peer's flaky set on green main becomes the coordinator's baseline for isolation re-runs.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The decision is made where peer dispatch is already decided, with the existing pure fair-share function (`decideStart`) rather than a second rule. The protocol change is one optional field on the existing request and one on the existing result. No new route.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — an existing bounded invariant.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The verdict on main (green, suspect, red) is still produced only by `completeMain` on the coordinator, from a record whose head equals the reserved entry's head, whose attempt, peer, lease epoch, verifier version and policy hash match the dispatch snapshot (`importRefusal`, now also `wrong-kind`). The peer never judges main. The new refusals are identity and ancestry checks on machine-written facts.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic at a competing-signals decision point. The fair-share choice reuses the existing rule unchanged; the silence bound is a fixed time on a liveness fact (last answered poll).

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- Fair share: the same `decideStart` inputs as the local slot, so the 90-minute window (and the Echo cadence hot patch on it) governs both hosts. `lastStartWasMain` (the suspect/red alternation) is not touched by peer dispatch: a peer is never offered `main` in those states.
- Main health: a peer-run failure enters `health.onVerify` like a local one (healthy → suspect, re-run queued); the re-run entry is not dispatchable because main is no longer healthy.
- Stale-head retarget (PR 3256): moved into `retargetStaleMain()` and applied before the dispatch snapshot; a reserved entry is never retargeted, because `importRefusal` compares against the snapshot.
- Unverified clock: `mainRunOnCurrentHead` is set at dispatch; a green peer record moves the clock to the coordinator's dispatch time (`marker.sentAt`), never the peer's clock.
- Main-red hold: the peer returns bounded `reasons` and `failures` with a red main record (`parsePeerMainRun`, re-validated by the coordinator's client), so `mainFailureFromRunDetail` still names the failing files.
- Peer breaker: a main dispatch refused as `head-moved` or `pr-unreadable` does not count toward it (it has its own count, pause and signal); transport failures and a silent peer do.
- Restart hold for peer attempts (`writePeerHold`, `PlannedRestartVerifyGuard`): a reserved main entry is held like a PR attempt (the reader uses only `sentAt`).
- Queue persistence: `queue.json` now also holds a `main` entry while it is reserved. Older code reading a newer file drops that entry (its PR-number check); the peer attempt then ends at its own run bound.
- Verifier version: `LocalVerifyService`, `record` and their imports are in the version hash, and dispatch requires equal versions, so a coordinator on this change never sends `kind: 'main'` to a peer without it.
- PR-only paths (journal, index, merge hand-off, status posts, starved alarms, closed-PR sweep, queue caps): each is already guarded by `kind`; the reviewer checked them.
- `src/testing/selfActionRegistry.ts`: its simulated main-schedule controller models the single-host order and is unchanged.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- `POST /local-verify/peer-run`: optional `kind: "main"`. `GET /local-verify/peer-result`: optional `run` with a red main record. Both are machine-to-machine routes behind the agent token.
- `GET /local-verify`: `peers.reserved` can list `pr: 0`; `mainHealth.mainInFlight` shows a peer-run head; `pendingMainHead` excludes a reserved entry.
- `local-verify.jsonl`: `peer-dispatch` with `kind: "main"`; `main-replaced` with `why: "peer-attempt-abandoned"`; `peer-attempt-abandoned` with reason `main-peer-silent`; `queue-restore-dropped` with `kind: "main"`.
- New config key `monitoring.localVerify.mainOnPeers` (boolean, default false, read live); absent means off, so no config migration is needed. New signal key `local-verify:peer-main-unconfirmed:<machine>`. New awareness entry `src/data/awareness/local-verify-main-on-peers.md` (reaches existing agents on update through the feature-notes rebuild).
- No message or dashboard change. No operator surface touched (6b not applicable).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated by request, judged in one place.** The coordinator (lease holder) alone decides what runs and alone records main health. A peer only executes one attempt and returns one record for it; it holds no main state. Both machines must run the same verifier version for any dispatch, so the change is inert until both are updated.

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Set `monitoring.localVerify.mainOnPeers` to false (live, no restart): every new `main` verify stays on the coordinator. Code rollback: revert and ship a patch; both machines must restart together (the verifier version changes). No migration. A `queue.json` written with a reserved main entry is read safely by the older code (the entry is skipped).

---

## Conclusion

The peer could test changes but never the main line, so the main verify waited for one specific machine. It now takes whichever slot frees first under the same fairness rule, with one main verify at a time and the coordinator still the only judge of main.

Found along the way, triaged and not added to this change:
- No signal when the two hosts disagree on main. Queue: feedback.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (fresh context, given the diff and asked to find faults; not the author), three rounds on the code; plus a cold spec reviewer (three rounds) and Codex gpt-6-astra (two rounds) on the spec. Full table: `docs/specs/reports/local-verify-main-on-peer-convergence.md`.
**Independent read of the artifact: concern, resolved**

The code reviewer read `dispatchOnce`, `dispatchable`, `pollPeers`, `abandonRemote`, `enqueueMain`, `noteMainHead`, `pump`, `nextRunnableQueuedEntry`, `completeMain`, `start`, `onExit`, `finishPeerAttempt`, `peerRun`, `persistQueue`, `readQueueFile`, `doRestoreQueue`, `shutdown`, `mainHealth.ts` `onVerify`, and every site that iterates the queue or reads `remote` or `kind`; it ran the four Local Verify unit files and the type check each round.

Concerns raised and their resolution:

- Round 1, medium (did not concur): a peer that went silent while holding a `main` verify blocked every `main` verify for up to 60 minutes. Resolved: the reservation is taken back after 5 minutes without an answer and two missed polls, with a cancel.
- Round 1, low: a restored reservation could be dropped silently; `lastStartWasMain` forced false on refusal; the unverified clock used the peer's clock; a slow head check could count against the breaker; `isolation` accepted on a main request. Resolved: audited drop; bookkeeping later removed with the healthy-only rule; coordinator dispatch time; two parent reads instead of four (residual stated in section 2); refused.
- Spec review round 1, blocker: the confirming re-run could go to the same peer, so a peer could turn main red alone. Resolved by changing the rule: a peer is offered `main` only while main is healthy and the switch is on; a record that arrives when main is not healthy is not judged; a running attempt is taken back when main stops being healthy.
- Spec review round 2, should-fix: a suspect main could wait up to 60 minutes on a peer run whose verdict would be discarded. Resolved: taken back at the next poll.
- Round 3 (after the redesign), concur: the reviewer attacked "a peer can never turn main red or clear a suspect or red main" across check-to-verdict timing, the one await in `onVerify`, restart, the re-run and a second peer, and found no path. Low: unguarded signal calls in the dispatch path; the signal cleared when never raised. Resolved: guarded; cleared only when raised.
- Accepted and recorded in section 2: a peer `error` on main re-offered without backoff (two attempts); an orphan run after a partition; the slow stale-head check; no host-disagreement signal.

Not verified by the reviewers: live behaviour on two real machines; the full test suite (the merge line runs it).

---

## Evidence pointers

- `npx vitest run tests/unit/localVerify/peerVerifier.test.ts tests/unit/localVerify/mainHealth.test.ts tests/unit/localVerify/record.test.ts tests/unit/localVerify/LocalVerifyService.test.ts` → 365 passed.
- `npx vitest run --config vitest.integration.config.ts tests/integration/local-verify-peer-routes.test.ts tests/integration/planned-restart-local-verify.test.ts` → 10 passed.
- `npx vitest run --config vitest.e2e.config.ts tests/e2e/local-verify-lifecycle.test.ts tests/e2e/planned-restart-local-verify-lifecycle.test.ts` → 19 passed (includes the two-service lifecycle "main on a peer, production-built on both sides over real HTTP").
- `tsc --noEmit` clean.
- Baseline: coordinator `local-verify.jsonl`, 2026-11-17: main wait 82 min, Studio main-verify 426 min/day.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (A capacity gap in product source; the guard added is the unit block "a main verify on whichever host is free".)

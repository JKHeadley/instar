# Side-Effects Review — a pending main verify starts on the head current at its start

**Version / slug:** `main-verify-current-head`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see Second-pass review)`

## Summary of the change

Tier 1. One runtime block in `src/localVerify/LocalVerifyService.ts` (`pump()`), tests in `tests/unit/localVerify/mainHealth.test.ts`, an ELI16 and a release note. Effort: one read-only diagnosis, one build attempt, one correction after independent review.

A queued `main` verify can wait up to `MAIN_FAIR_SHARE_MS` (90 minutes) behind PRs while main is healthy (`decideStart`). It then started on the head it was queued for, which main had usually left. A green run of a replaced head only moves the unverified clock to when that head was replaced, so a second main verify was due at once. On 2026-11-16 this cost about 80 minutes of back-to-back main runs twice, with eight PRs waiting.

Now, when the chosen entry is a `main` entry and main is healthy, `pump()` retargets it to main's head as observed (`mainObs.head`, mapped through `releaseAlias`) before it starts, records `main-replaced` with `why: 'stale-at-start'`, and marks the observed head handled. It does not retarget to a head already verified on this machine, to the last green head, or when the observed head is one already seen replaced.

Files: `src/localVerify/LocalVerifyService.ts`, `tests/unit/localVerify/mainHealth.test.ts`, `docs/specs/main-verify-current-head.eli16.md`, `upgrades/next/main-verify-current-head.md`, this artifact.

## Decision-point inventory

- `LocalVerifyService.pump()` — modify — which head a pending main verify runs on.
- `decideStart`, `decideMainHeadEnqueue`, `decideMainEnqueue`, `completeMain`, `start()` (`mainRunOnCurrentHead`) — pass-through — unchanged; they now receive an entry whose head is current.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Nothing is blocked. The one thing no longer done is a main run of the originally queued head when main has moved on while healthy. That head is an ancestor of the head now tested in a linear history, so its content is covered by the run of the newer head. If the newer head fails, the existing suspect/red path re-runs it and names it; the older queued head is not separately judged. That is the same information main health had before for any head between two main runs.

---

## 2. Under-block

**What failure modes does this still miss?**

- While main is suspect or red, a queued head still runs as queued, including the suspect states that have no failed head (`unverified-too-long`, `boot-unknown`, `lease-foreign`). One green run corrects those; left as is on purpose so the failed-head re-run path is untouched.
- A `commitInfo` lookup for an older head that resolves after the retarget can still queue that older head. At its start it is retargeted to the current head unless that head is already verified, in which case it runs as queued (one run of an older head). Needs a lookup slower than one poll.
- A head read that is wrong in the FORWARD direction (a head main never had) is trusted, as it already was by the enqueue path.
- The fix does not change how often a main verify becomes due. The 45/90-minute cadence hot patch on the Echo test machines is a separate setting.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The head is resolved at the single point where an entry leaves the queue and starts, synchronously, from the observation the reconcile pass already keeps. No new GitHub or git read.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — an existing bounded invariant.
- [ ] ⚠️ Yes, with brittle logic — STOP.

It chooses which head a scheduled verify tests. The verdict on main (green, suspect, red) is still produced only by `completeMain` from a record whose head equals the entry's head.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic at a competing-signals decision point. The rule is an identity comparison on machine-written facts (observed head, verified heads, last green head).

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- Main health record: `completeMain` requires `record.headSha === entry.headSha`; the entry is changed before the run input is built, so the head marked green is the head tested.
- Unverified clock: a green run of the current head clears it or moves it to the run start (`mainRunOnCurrentHead` is computed in `start()` from the already retargeted entry). This is what removes the immediate second run.
- Debounce: `mainObs.handled = cur` stops the observed head's own delayed enqueue from queueing it again; a later head is debounced as before.
- Release collapse: the target is mapped through `releaseAlias`, so a release commit of the queued head changes nothing and starts nothing new.
- Stale or backward read: a target equal to `lastGreenHead`, present in `verifiedMainHeads`, or an observed head present in `mainSupersededAt` is never taken (independent review, concern 1).
- Error retries: `mainErrorRetries` is keyed by head and read at completion from the entry's head, so a retargeted entry uses the new head's count, as a replaced entry already did. The entry's own `errorRetries` and `notBefore` are left untouched.
- Peer dispatch: main entries are never sent to a peer. In-flight file and status posts are written after the retarget.
- Queue persistence: `queue.json` holds PR entries only; main is re-derived at boot.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- `local-verify.jsonl` gains `main-replaced` lines with `why: 'stale-at-start'` (existing event name, new `why` value).
- `GET /local-verify/status` → `mainHealth.pendingMainHead` can differ from the head that then runs; `mainInFlight` shows the head running.
- No route, config key, message or dashboard change. No operator surface touched (6b not applicable).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** Only the lease-holding coordinator runs main verifies, from its own observation of main's head. Peers never receive main entries.

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Revert the block and the tests and ship a patch. No persistent state, no migration, no config. The old behaviour returns: a main verify of a replaced head followed by a second one.

---

## Conclusion

The scheduling rule that lets PRs go first made the queued main head stale by the time it ran, and nothing refreshed it. The run now tests the head that is current when it starts, with a guard so one stale read cannot send it back to a head already verified.

Found along the way, triaged and not added to this change:
- The 45/90-minute cadence hot patch on the Echo test machines lines its cap up with the stock 90-minute fair-share rule; with this fix it no longer causes back-to-back runs. Whether to keep it: mine to decide after a day of data.
- Suspect-without-a-failed-head still runs stale heads. Queue: feedback.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (fresh context, given the code and asked to find faults; not the author)
**Independent read of the artifact: concern, resolved**

The reviewer read `pump()`, `decideStart`, `noteMainHead`, `enqueueMain`, the enqueue deciders, `start()`, `completeMain`, the release-collapse logic, the error-retry handling and the consumers of a main entry's head, and ran `tests/unit/localVerify/mainHealth.test.ts` (68 passing at that point). It confirmed the suspect/red path is untouched, that the head marked green is the head tested, and found no loop and no main run that never starts.

Concerns raised and their resolution:

- Medium: one stale or backward read of main's head just before the start retargeted the entry to an already green head, spent a run on it, and advanced the unverified clock past a merge no run covered. Resolved: the retarget is skipped when the target is the last green head, is in `verifiedMainHeads`, or the observed head is in `mainSupersededAt`; a new test covers a stale read of the last green head.
- Low: a new test asserted re-running a head that had just gone green. Resolved: the test now asserts the queued head runs and no run is spent on the green head.
- Low: `delete next.notBefore` was dead code and `errorRetries = 0` mattered only after a spawn failure. Resolved: both lines removed.
- Low, accepted and recorded in section 2: a slow `commitInfo` lookup can still queue an older head after the retarget; the retry count across a release alias is per head.
- Observation, recorded in section 2: the healthy-only guard also leaves suspect-without-a-failed-head on the old behaviour.

Not verified by the reviewer: the rate of stale head reads in production; mutation testing (edits were not allowed).

---

## Evidence pointers

- `npx vitest run tests/unit/localVerify/mainHealth.test.ts` → 69 passed.
- `npx vitest run tests/unit/localVerify/LocalVerifyService.test.ts` → 162 passed.
- `tsc --noEmit` clean.
- Incident: coordinator `local-verify.jsonl`, 2026-11-16: `main-queued` 16:21Z (1d41de094) run 17:54 to 18:36Z, `main-queued` 17:57Z; `main-queued` 19:06:37Z (6252ddba1) run 20:38:46Z to 21:17:58Z, `main-queued` 20:56:23Z (f69ac8d38) started 21:18Z.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (The defect is a scheduling gap in product source; the guard added is the unit test block for the start-time head.)

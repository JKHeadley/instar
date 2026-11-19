---
title: "Local Verify: the age of unverified main survives a restart"
slug: "local-verify-main-age-survives-restart"
author: "echo"
status: draft
date: 2026-11-18
parent-spec: "local-verify-merge-authority"
eli16-overview: local-verify-main-age-survives-restart.eli16.md
approved: true
approved-by: "echo-chief-of-staff (maintainer approval, message 23c11976, 2026-11-18 15:27 PST; two fold-ins applied)"
review-convergence: "2026-11-18T23:20:25.132Z"
review-iterations: 3
review-completed-at: "2026-11-18T23:20:25.132Z"
review-report: "docs/specs/reports/local-verify-main-age-survives-restart-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Local Verify: the age of unverified main survives a restart

## Problem statement

While `main` is healthy, waiting pull requests go ahead of a `main` verify until the oldest unverified merge is 90 minutes old. That age lives only in memory, so every restart resets it.

Measured on the coordinator on 2026-11-18 (feedback fb-a28ace2f-93c), from `logs/local-verify.jsonl`:

- 10:44:59Z: the last green `main` verify (head 73e4aad1e).
- The coordinator then booted 12 times. Each shows `index-rebuilt`, `queue-restored`, `lease-acquired` and `main-queued` (why `head-changed`) within 20 seconds: 11:20:01, 12:26:24, 12:52:49, 14:11:24, 15:03:47, 16:22:39, 16:48:40, 17:33:09, 18:03:21, 18:38:45, 19:29:23 and 20:41:27Z. The longest gap is 79 minutes. All 12 are in the coordinator's own log, each a minute after a planned restart.
- Two more `lease-acquired` lines (18:04:56 and 20:43:04Z) have no boot lines beside them. They are re-acquisitions in a running process and did not reset the age.
- No `main` verify started. Pull request runs kept starting.

Frequent lease changes on the coordinator are a separate matter, already worked by the scaling session's PR 3460, not treated here.

The cause, at commit a5ce7904d:

- `decideStart` (src/localVerify/LocalVerifyService.ts:484-515): with `main` healthy, `main` goes first only when `now - oldestUnverifiedMainAt >= mainFairShareMs` (line 511). The constant is 90 minutes (line 534).
- The value is `mainObs.oldestUnverifiedAt` (lines 738-739, in memory, initially `null`), set to `now` at the first observation of a head that is not the last green head (line 1320).
- The same value feeds `health.noteUnverifiedAge` every tick (line 2457), which raises `local-verify:main-unverified` after 3 hours (src/localVerify/mainHealth.ts:412-418).

## Proposed design

### 1. Persist the age

`oldestUnverifiedAt` becomes one optional numeric field (milliseconds) in the existing `state/local-verify/main-health.json`, written by the existing atomic writer `MainHealth.writeWatermark` (src/localVerify/mainHealth.ts:448-473) beside `lastGreenHead`. The version stays `v: 1`.

`MainHealth` holds the value, includes it in every watermark write, and writes whenever it changes:

- set (LocalVerifyService.ts:1320);
- cleared by a release collapse (line 1338);
- cleared or moved by a green verify (line 3485). Here the new value is handed to `onVerify`, so it lands in the same write as `lastGreenHead`.

Why not derive it from git history: a local git read is cheap, but the head may be absent from the verifier's clone, which needs a fetch on the boot or merge path, and the memory of which release commits were collapsed is not durable. Storing the value avoids both.

### 2. Restore at boot

Restore happens in `MainHealth.load` (mainHealth.ts:347-364), which is called three times: in the constructor (LocalVerifyService.ts:860), at boot (line 1111) and on lease re-acquisition in a running process (line 1298). Its own rewrite keeps the fields. The restore and the `main-age-unknown` audit line happen once per process start, not at each call.

- **Own-machine branch** (lines 359-361). At boot, a finite number not in the future is restored into `mainObs.oldestUnverifiedAt`. In a running process the stored value equals the in-memory one and nothing changes.
- **Foreign-machine or epoch-gap branch** (lines 354-358). The age becomes unknown, at boot and in a running process. It never stays a number. When this machine's own `oldestUnverifiedAt` (stored or in memory) is finite and in the past, `unknownSince = min(that, now)`, so lease flapping cannot keep pushing the 3-hour signal back. The stored `oldestUnverifiedAt` is cleared in the same write that sets `unknownSince`. When the age is already unknown and a usable `unknownSince` is stored, it is kept: a lease flap never restarts it at `now`.

### 3. Unknown is due

At the first observation after boot, if the head is not `lastGreenHead` and there is no usable stored value, the age is **unknown**. At boot or lease re-acquisition, `now` is never substituted for it. Unknown has one encoding, in memory and on disk: `unknownSince` is present. There is no separate flag that could disagree.

- `FairShareState` (LocalVerifyService.ts:519-527) gains `oldestUnverifiedMainUnknown`. In `decideStart`, `due` is also true when the age is unknown. `main` then goes ahead of waiting pull requests at the next start, after any resumed run (lines 500-505 are unchanged).
- It stays unknown until a `main` verify settles it. Green clears it. Red follows the existing red path. A release collapse (line 1338) clears it, as it clears the value.
- Unknown must not silence the 3-hour signal for ever. The second optional field, `unknownSince`, is written in the same watermark: the time unknown was first observed. It has the same validation and provenance rules as `oldestUnverifiedAt` (finite, not in the future, this machine's own watermark). An unusable `unknownSince` is still unknown and due, and a fresh bound starts at `now`. It is set once, kept across boots while unknown persists, and cleared in the same write that settles the age. The real age is at least `now - unknownSince`, so the service passes `unknownSince` to `noteUnverifiedAge` (mainHealth.ts:412-418) as a lower bound, and the existing signal fires 3 hours after unknown was first seen. Wherever shown or logged it reads "at least X", never an exact age or zero. The signal detail carries `atLeast: true` while the age is unknown, so its `ageMs` is never read as an exact age.
- One audit line per process start: `main-age-unknown` with the reason (`field-absent`, `file-unreadable`, `future`, `non-finite`, `other-machine`, `carried`).

`now` is still used where the running process itself sees a head it has not verified: when the head leaves green, as today, and at the first observation after a green verify of an older head ended unknown. There the age is young by at most one verify's duration.

### 4. The wait trade

This prevents `main` starvation and does change waits:

- One `main` verify goes first per unknown episode (a boot with no usable value, or a foreign-machine or epoch-gap lease re-acquisition), with error retries keeping priority.
- With a stored value, restarts no longer reset the clock. `main` comes due 90 minutes after the merge was first seen, and the 3-hour signal counts from the same moment.
- A stale stored value (see Failure modes) can schedule `main` early.
- First boot on the new build: the fields are absent, so every agent with unverified merges starts in unknown and one `main` verify goes first. That is intended.

### What does not change

The 90 minutes is `MAIN_FAIR_SHARE_MS` (src/localVerify/LocalVerifyService.ts:534) and the 3 hours is `MAIN_HEALTH_LIMITS.unverifiedSuspectMs` (src/localVerify/mainHealth.ts:66). Both were set by the parent spec, docs/specs/local-verify-merge-authority.md (lines 295 and 246). This spec inherits them unchanged, and changing them is out of scope.

Also unchanged: the resumed-run rule, `oldestUnverifiedAfterGreen`, peers, restart behaviour, routes and config. No new file or alarm.

### Also amended

The registry row `local-verify-main-health` in `src/data/state-coherence-registry.json` lists the file's fields in its description. "the time of the oldest unverified merge, and since when that time is unknown" is added, and the retention note becomes "overwritten atomically on every state or age change".

## Decision points touched

| Decision | Classification |
|---|---|
| When a healthy `main` goes ahead of waiting pull requests (`decideStart`, LocalVerifyService.ts:508-512) | invariant; basis: enumerable-domain; evidence: the input has three states (no age, a known age, unknown) and each has one fixed outcome; the rule and threshold are unchanged, the input becomes durable, and unknown means due. Incident behind it: the 2026-11-18 incident above: 12 boots between 11:20:01Z and 20:41:27Z, none more than 79 minutes apart, each with `main-queued`, and no `main` verify started after 10:44:59Z. |

## Multi-machine posture

Two optional fields in a store already declared machine-local: `src/data/state-coherence-registry.json`, category `local-verify-main-health` (lines 2057-2072), `scope: machine-local`, `transport: none`, `conflictShape: single-writer`. The precedent is `lastGreenHead` in the same file.

A new coordinator has no value of its own, so the age is unknown and one `main` verify goes first. Such a machine is also in `main-suspect` (mainHealth.ts:354-358), where `main` already has priority.

## Failure modes

| Case | Behaviour |
|---|---|
| Fields absent (new build, role just moved) | Unknown, so due. One `main` verify first. |
| File unreadable | Unknown, so due. `load` also enters `main-suspect`, as today. |
| Value in the future or non-finite | Unknown, so due. |
| Stored value is stale (a release-collapse clear fails to write after a set; a failed green write leaves `lastGreenHead` and the age stale together, which is harmless) | Kept. `main` is scheduled early and the 3-hour signal can fire prematurely. Accepted conservative behaviour, ended by the next green `main` verify. |
| Unknown persists across boots (erroring verifies, fast restarts) | `unknownSince` is kept. The signal fires 3 hours after the first unknown. |
| Wall clock jumps (the stored times assume a steady wall clock) | Backward: the value is in the future, so unknown and due. Forward: `main` comes due early. |
| `unknownSince` unusable | Still due. A fresh bound starts at `now`. If the write keeps failing and restarts come under 3 hours apart, the signal is pushed back each time. The existing `main-health-write-failed` audit line is the trace, and `main` stays due throughout. |
| Head equals `lastGreenHead` | Nothing unverified. A pending unknown is dropped; a stored value is kept (the stale case). |
| Crash between a merge and the write | Value missing at boot. Unknown, so due. |
| Write fails | Existing handling (mainHealth.ts:461-472). Healthy state: the old file stays, which is the stale case above. Any other state: the file is removed, so the next boot reads unknown, still due. |

## Tests

Unit, `tests/unit/localVerify/mainHealth.test.ts`:

- `writes oldestUnverifiedAt when it changes and not when it is unchanged`
- `a green verify writes the cleared age with lastGreenHead in one write`
- `load restores a finite past value from this machine's watermark`
- `load drops a future, non-finite or other-machine value`
- `three boots: load's own rewrite keeps both fields`
- `unknownSince is set once and cleared in the write that settles the age`

Unit, `tests/unit/localVerify/LocalVerifyService.test.ts`:

- `two boots: main is due 90 minutes after the first observation`. Observe an unverified head at T, boot a second service on the same state directory at T+50 minutes. At 89 minutes a ready pull request starts first. At 90 minutes `main` starts.
- `no stored value: age unknown, main starts ahead of a ready pull request`
- `unknown persisting across two boots with erroring main verifies raises the signal 3 hours after the first unknown`
- `unknown renders as "at least", never as 0 or an exact age`
- `lease re-acquisition: own machine keeps the age, foreign holder makes it unknown`
- `a release collapse clears the stored value and unknownSince`
- `an unusable unknownSince is still due and restarts the bound at now`
- `foreign re-acquisition sets unknownSince to the earlier own age`
- `a green verify of an older head ends unknown; the next observation sets now`

End to end: `tests/e2e/local-verify-lifecycle.test.ts` already writes `main-health.json` and boots the real wiring (lines 354 and 429-452). One case is added there: a stored `oldestUnverifiedAt` is restored after boot.

## Frontloaded Decisions

1. No new config key. It ships on. A switch's off state would be the known defect.
2. The carrier is the existing `main-health.json`: two optional fields, same writer, version unchanged.
3. A missing or unusable value is unknown, and unknown is due. Never `now` at boot or lease re-acquisition.
4. Unknown is shown as "at least", never as an exact age. It raises the signal 3 hours after it was first seen.
5. The cost is accepted: one `main` verify goes first per unknown episode, including the first boot on the new build.
6. A stale stored value is kept. Early scheduling and a possibly premature signal are accepted.

## Maturation plan

- **test-agent-live:** a throwaway agent with an isolated server: one unverified head, two restarts inside 90 minutes, `main` starts 90 minutes after the first observation. With the fields removed, `main` starts first.
- **dev-agent-live:** Echo's coordinator after the update. The throughput session reads the audit lines.
- **fleet:** no switch. It reaches every agent with the package update.
- **graduation criterion:** the first three coordinator boots after install that have something unverified each show a restored value or `main-age-unknown` in the audit log. When the age is due or unknown, a `main` verify starts by the next slot after any resumed run. Otherwise it starts at the first eligible slot after the threshold.
- **dark-window:** none. It ships on, because a switch's off state is the known defect. Rollback is a code revert.
- **ladder:** localVerify.mainAgeDurable

## Rollback

Revert the commit. The older build ignores the fields and drops them at its next write. The age again resets at each boot.

## Left behind

- The standards gate's repeated flag on the inherited thresholds: `MAIN_FAIR_SHARE_MS` (LocalVerifyService.ts:534) and `MAIN_HEALTH_LIMITS.unverifiedSuspectMs` (mainHealth.ts:66), set by docs/specs/local-verify-merge-authority.md and inherited unchanged. Out of scope. A change to them is its own decision.
- Frequent coordinator lease changes: PR 3460, scaling session.
- The round-3 precision edits were applied without a further review round.

## Open questions

*(none)*

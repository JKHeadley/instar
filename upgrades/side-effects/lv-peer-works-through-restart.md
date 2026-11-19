# Side-Effects Review — Local Verify: a helper machine keeps working while the coordinator restarts

**Version / slug:** `lv-peer-works-through-restart`
**Date:** `2026-11-18`
**Author:** `echo (scaling session, topic 145097)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

This implements the approved spec `docs/specs/local-verify-peer-works-through-restart.md`. Approval: Chief of Staff, 2026-11-18 14:06 PST, with the progress-judgment fold-in. Everything sits behind one live-read setting, `monitoring.localVerify.peerWorksThroughRestart.enabled`. It is absent by default and gives today's behaviour when off.

What it does when the setting is on:

- **A.** The coordinator may dispatch to an idle peer while a planned restart is pending. This does not apply to a forced restart, a verifier already changed on disk, or a `main` entry.
- **B.** An attempt sent during a restart episode does not hold that episode's restart.
- **C.** After the coordinator's own restart, a peer attempt is adopted instead of thrown away. The condition is that PR 3451's holding record shows unbroken holding by this machine since the dispatch epoch (`holding.since <= m.leaseEpoch`, all values safe integers), and that the entry, verifier and policy are unchanged.
- **E.** At the 60-minute review point a peer attempt is ended only on evidence: the run child is gone, no file finished within a stall window, or progress is unknown (today's end). There is a 150-minute backstop.

Files:

- `src/localVerify/peer.ts`: marker fields, `markerCurrent`, `markerEpochDecision`, progress helpers, the epoch line in `importRefusal`, `PEER_LIMITS.backstopMs`.
- `src/localVerify/peerTrust.ts`: `holding.since`.
- `src/localVerify/LocalVerifyService.ts`: dispatch gate, restart episode, `qualifyingPeerAttempts`, `pollPeers`, `remoteEpochCurrent`, `abandonRemote` refund, `checkPeerAttempt`, `peerResult` progress, persistence, status fields.
- `src/localVerify/localVerifyWiring.ts`: live setter; peer client passes `progress` through.
- `src/localVerify/orchestrator.ts`: exports `PROGRESS_MAX_BYTES`.
- `src/core/PostUpdateMigrator.ts` and `src/scaffold/templates.ts`: the CLAUDE.md peer line.
- `src/data/awareness/local-verify-main-on-peers.md` (the restart text is a second paragraph of the existing helper-machine entry, retitled "Local Verify with a helper machine").
- The amendment note in `docs/specs/local-verify-capacity.md`.
- Tests, unit / integration / e2e.

Tier 2; spec converged in 3 rounds plus the approval fold-in.

## Decision-point inventory

- `dispatchOnce` pause gate: **modify**. With the setting on, a pause no longer stops peer dispatch, under the A conditions.
- `qualifyingPeerAttempts` (restart-hold membership): **modify**. A pause-time attempt is excluded only while its episode id equals the current non-null episode.
- `pollPeers` epoch handling and `importRefusal` epoch line: **modify**. A different epoch now resolves to current, wait, adopt or abandon (C.3) instead of always abandon.
- `checkPeerAttempt` and the coordinator run bound: **modify**. The 60-minute bound becomes a judgment point (E), with a 150-minute backstop.
- `abandonRemote` refund: **add**. Refund on `lease-changed:verifier` only, once per entry per head.

---

## 1. Over-block

The change mostly removes blocks: dispatch during pauses, and abandonment across restarts.

What remains is conservative abandonment in two cases, which reject legitimate work:

- Two restarts close together without an intervening tick reset holding, so a good peer run is abandoned (`lease-changed:holding-broken`). That is a lost run, the same as today.
- A peer that reports no progress (setting off on the peer, or unreadable progress files) ends at 60 minutes, as today.

No new over-block beyond today's behaviour.

## 2. Under-block

- A lease store without compare-and-swap (the lease-layer risk, MULTI-MACHINE-LEASE-ROBUSTNESS Problem A) could let two machines write the same epoch. `keep` would then not see the other holder. This spec does not widen that. Adoption still needs the peer's PR 3451-signed record for this coordinator's own dispatch, and every C.3 equality.
- E's stall window could keep a pathologically slow but progressing run up to the 150-minute backstop, occupying the peer. This is accepted: it is bounded and audited (`peer-attempt-judged`).

## 3. Level-of-abstraction fit

The change sits in the Local Verify service, where dispatch, holds and import already live.

- It reuses PR 3451's holding record rather than adding a second record of holding.
- It reuses the run's existing per-lane progress files and `readProgress` for E rather than a new probe.
- The pure decisions (`markerCurrent`, `markerEpochDecision`, the progress judgment) are separate functions with unit tests. The service only wires them.

## 4. Signal vs authority compliance

- [x] No: this change has no brittle block/allow surface of its own.

The new gates are exact equalities on persisted facts: epochs, the holding record, episode ids, head/base/verifier/policy. Each defaults to today's abandon or hold when anything is unknown. That is the deterministic floor the spec classifies as invariant (irreversible-consequence: a wrongly imported result could merge a change). E replaces a pure clock with an evidence check whose unmeasurable case is today's clock, so it narrows authority rather than adding brittle blocking.

## 4b. Judgment-point check

There is no new static heuristic at a competing-signals point.

- The adoption decision is an invariant; its basis is in the spec's decision table.
- E's stall window scales with recorded durations and the run's own measured slowdown, within a fixed 150-minute backstop that is the run child's own longest possible life.
- Reasons for every limit are in the spec's Fixed limits table.

## 5. Interactions

- **PR 3451 (holding record, signatures).** Extended, not changed in meaning. `holding.since` is set inside `resetHoldingState` and on first creation, and kept on `keep`. The import still checks the signed `attempt.leaseEpoch` against the dispatch epoch.
- **PR 3455** (re-run rule, open, edits `importRefusal`). This change touches only the epoch line. Whoever merges second rebases; agreed with the throughput session.
- **PR 3468** (main age survives restarts): no shared function.
- **Restart holds.** Pre-pause attempts still hold up to `PEER_RESTART_HOLD_MS`. A pause-time attempt that finishes green still triggers the 10-minute merge hand-off hold, which is intended.
- **Peer breaker.** Unchanged. Refunds do not count as peer failures.

## 6. External surfaces

- `GET /local-verify` gains marker fields (`sentDuringPause`, `adoptedEpoch`, `restartEpisode`).
- The peer's `peer-result` answer gains a `progress` object; older coordinators ignore unknown fields.
- New audit events: `peer-attempt-adopted`, `peer-attempt-adoption-waiting`, `lease-changed:*` reasons, `restart-episode-ended`, `peer-attempt-judged`.
- The CLAUDE.md peer line is reworded in existing agents by an idempotent, content-sniffed migration step.
- **One behaviour difference with the setting off:** `restart-episode-ended` audit rows are written, and the restart episode shows in status. These are observability only; they give the baseline the graduation numbers need. All lease-change abandons are labelled `lease-changed:disabled` instead of plain `lease-changed`; no consumer matched the old exact string.

## 7. Multi-machine posture

- **Setting:** machine-local by design. Only the lease holder reads it, and a holder with it off behaves as today. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17.
- **Marker fields:** in the coordinator's `queue.json`, lease-holder-local under the same ratification. A new coordinator on another machine has broken holding, so it never adopts.
- **`holding.since`:** one field on PR 3451's already-registered `peer-trust.json`.
- **E:** read on each machine for its own side.
- **Notices, state, URLs:** no user-facing notices, no topic-bound state, no URLs.
- **Status surfaces:** `GET /local-verify` fields describe this machine's queue (the coordinator view), as before.

## 8. Rollback cost

- **Fastest:** switch the setting off. A-level dispatch stops at once, and every not-yet-current marker abandons as today on the next poll.
- **Code revert:** older code reading a marker with the new fields treats a mismatched epoch as `lease-changed` and abandons, which is safe. The extra `since` field in `peer-trust.json` is ignored by older code.
- **No data migration and no user-visible regression.**

## Conclusion

The review found no design change needed beyond the spec. The build made four small decisions, recorded here:

- `progress` is passed through the peer client;
- `PROGRESS_MAX_BYTES` is exported;
- adoption also requires the dispatch epoch to be below the live epoch (guards an epoch going backwards);
- episodes are tracked as audit rows even with the setting off.

The new integration and e2e files were typechecked but not run on this verify machine, by rule; their first run is Local Verify. Clear to ship after the second-pass review below.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only, spawned without this artifact's conclusions; findings in the agent home at `.instar/state/scaling/pr3460-second-pass.md`)
**Independent read of the artifact: concur**

No correctness or safety bug was found. Every epoch comparison was traced, along with the kill-switch path, B's null-id handling, E's backstop on both sides, the refund bound, persistence and the migration's idempotence.

Three of its lesser notes were fixed before commit:
- The on-disk verifier rehash used to measure an episode now runs only with the setting on, at most once a minute, so the off path adds no main-thread cost.
- `adoption-wait-run-bound` is renamed `lease-changed:wait-run-bound`, so the graduation count includes it.
- `peer-attempt-judged` is written only when an attempt's verdict changes.

The other notes are accepted and recorded in the findings file: shutdown counts as a restarted episode; one extra stall window when the setting is turned on mid-run; an empty running list reads as unknown; clock skew in seconds; the guard test's allowlist; a finished answer held while waiting.

## Evidence pointers

- Unit runs (niced, at most 5 files each): `tests/unit/localVerify/peerWorksThroughRestart.test.ts` 40/40; with `peerVerifier`, `LocalVerifyService` and `localVerifyRoutes`, 322/322; `local-verify-peer-trust`, `awareness-entry-registry` and `claude-md-reference-layout`, 134/134; `no-empty-catch-blocks` and `no-silent-fallbacks`, 9/9. Typecheck clean.
- Measured problem: about 105 recoverable M5-minutes a day (11-16 to 11-18), in the spec's Problem section.

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`. The change modifies self-triggered controllers: peer dispatch and peer polling.
- **closure:** `guard`.
- **guardEvidence:** enforcementType `ratchet`; citation `tests/unit/self-action-convergence.test.ts`.
- **howCaught.** Each controller converges:
  - **Dispatch during a pause.** Edge: pending restart → dispatch. Bound: at most one attempt per configured peer, one per entry. Brake: `maxAttemptsPerEntry`, plus at most one refund per entry per head.
  - **Adoption in `pollPeers`.** It acts once per attempt per epoch and then is current. Waiting is bounded by E's judgment and the 150-minute backstop.
  - **E.** It acts once, at the review point or the backstop.

  None loops without a brake.

## Addendum (2026-11-19): maturation ladder entry

`src/data/feature-ladders.json` gains the entry `local-verify-peer-works-through-restart`, which the spec's Maturation plan names. The pre-merge check refused the spec while that entry was missing. Its contents:
- the flag `monitoring.localVerify.peerWorksThroughRestart.enabled`;
- `final: default-on`, risk `sensitive`, since adoption feeds a merge-authorizing import;
- rungs `dev-agent-live` and `fleet`, both advanced by code;
- a "ran" metric (`peer-attempt-adopted` count) and a "harm" metric (adoption waits that ran out, at most 3 in 14 days), read from `.instar/logs/local-verify.jsonl`.

This is data only; no runtime change. Registry tests pass: `feature-ladders-coverage`, `MaturationLadder`, `MaturationLadderService`, 82/82.

## Addendum (2026-11-18 22:10 PST): awareness text moved into the existing entry

The core instruction file on `main` measures 83,999 characters against its 84,000 limit (`tests/e2e/claude-md-reference-layout-init-lifecycle.test.ts`), and every awareness entry's title is listed in that file. A new entry therefore failed the size test (84,052). The restart text is now a second paragraph of `src/data/awareness/local-verify-main-on-peers.md`, whose title is shortened to "Local Verify with a helper machine", so the core file does not grow (it shrinks by 10 characters). No wording of either paragraph's instructions changed apart from the second paragraph's opening clause. The second-pass reviewer did not re-read this relocation; the size test and the awareness registry test were run on it.

## Addendum (2026-11-19 04:45 PST): independent read of the five later commits

After the build's second pass, five commits were added: the ladder registration (640023e57), a merge of `main` (90cf0b9ba: the re-run rule and main-age changes), the awareness text moved into the existing helper-machine entry (d73774a75), and a second merge of `main` (503ffdff3: queue controls). An independent reviewer subagent (general-purpose, fresh context, read-only) read all of them on 2026-11-19 at about 04:40 PST and returned **concur**; nothing blocks merge.

What it confirmed, with its own run (five unit files, 396 passed):

- Every conflict resolution keeps both sides. With the feature off, the hand-off to the peer is identical to `main`. With it on, during a pause, a `main` entry is never handed out, a held change is never handed out, and a fronted change is first among pull requests. The pause is read again before the choice is made again, with nothing awaited between that reading, the re-pick and the stamp; the re-pick is bounded at three per pass and nothing is reserved before it.
- In `peer.ts`, the marker keeps `main`'s offered list and this change's two fields, and the import check applies both rules.
- The awareness text moved without change of meaning and matches the code; the deleted file is referenced nowhere.
- The ladder entry is well formed.

Its notes, none blocking and none changed here:

- The ladder's coded measures are weaker than the spec's graduation criteria (which are judged by hand at the review; nothing advances automatically).
- There are five new tests for the two features together, and none for a pause that begins or ends during the base read with queue controls on; that case was checked by reading.
- A hold does not carry this change's "refunded once" flag, so a refunded change that is held and released could get one more refund: at most one extra peer attempt per hold and release, with no effect on results. Recorded as a three-line fix for a later change to the operator store.

Not checked by the reviewer: `tsc` (run by the merger, clean), the integration and e2e files, and `main`'s own changes outside the conflict sites.

## Addendum (2026-11-19 05:25 PST): the merge with "likely-failing files first" (PR 3497), read by a second reviewer in three rounds

Main gained PR 3497, which can run a lane in two parts (a first part, then the rest) and adds a comparison run. Two conflicts were resolved by keeping both sides: the switch wiring in `localVerifyWiring.ts` (this change's setter and PR 3497's two optional setters) and the three ladder entries in `feature-ladders.json`.

**Reviewer of the merge:** Codex (`codex exec`, read-only, fresh context; it was given the merge delta and the merged files, not this artifact's conclusions). Three rounds; final independent read: **concur**.

- **Round 1: objected, one must-fix, real.** A lane's first part writes its progress to `<lane>-first.progress.json`. This change's progress check turned a file name into a lane by removing a numeric suffix only, so a first-part file with no recorded duration found no lane deadline, the judgment at the 60-minute review point became "unknown", and a healthy first part could have been ended. Fixed in `peer.ts`: `laneOfKey` also removes `-first`, and the stall window looks the lane up through `laneOfKey`, so a raw key reported by a helper that does not have the fix still finds its lane's deadline on the coordinator. Tests: pure cases for both functions and a service test that runs a first part past the review point.
- **Round 2: objected, one must-fix, real, older than this merge.** The test reporter writes progress at most every 5 seconds and wrote nothing at the end, so a process that finished inside that window (a first part is the common case) left a snapshot that still listed finished files as running and counted too few finished files; the progress check would size its stall window on them, which could keep a stalled remainder alive longer (never end a healthy one). Fixed in `unhandledErrorsReporter.ts`: when a process's tests are over it writes one last snapshot outside the throttle, with nothing running and every started file counted as finished. A killed process never reaches that point, so the snapshot the lane-deadline forensics read is unchanged. This runs in every lane with the feature on or off; it changes no verdict input (reports, exit codes and the unhandled-error count are separate files). Tests: the last snapshot after completions inside the throttle; no file without the environment variable.
- **Round 3: concur.** Both findings closed; the last write cannot throw where the reporter did not throw before (the write catches its own errors); no reader of the progress files is harmed.

What the reviewer confirmed besides: adoption keeps its trust checks and counts a helper's failed files once; first-part summaries and file outcomes stay on the helper and are not part of the kept answer; adoption never starts a comparison run; a helper may start a comparison run after its accepted attempt has ended while the coordinator is still down, under the comparison's own holds, which is separate work after the result is kept. Its note, not changed here: with the feature off the merged tree is not byte-for-byte `main` (the `holding.since` field is always written, restart episodes are tracked and audited, abandonment reasons are renamed, the awareness text differs); these are this change's own stated differences, not effects of the merge. Stated plainly: a helper running an older build keeps the first finding on its own side until it is updated; the coordinator's judgment is protected at once.

After the merge and both fixes: `tsc` clean; unit files run on the authoring machine: `peerWorksThroughRestart`, `local-verify-peer-trust`, `LocalVerifyService`, `firstPartService`, `firstPartQueueControls`, `firstPartFlow`, `peerVerifier`, `orchestrator`, `unhandledErrorsReporter-progress`, `runFailedFileDiagnosis`, `feature-ladders-coverage`, `awareness-entry-registry` (both), `claude-md-core-headroom`: all passed. Not run: the integration and e2e files (run by Local Verify).

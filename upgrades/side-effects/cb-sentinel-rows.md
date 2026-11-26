# Side-Effects Review — ContextBudgetSentinel: freshness, hold health, eligible-without-fold rows (Phase 1 S12)

**Version / slug:** `cb-sentinel-rows`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2`

## Summary of the change

This is Phase 1 slice S12 of `docs/specs/context-budget-layered-summaries.md` (§7.8 "What it watches", §17 "Sentinel rows" and "Layer freshness", §14 owner-acts, and the Defaults "Layer freshness target"). It is stacked on S4 and S1. The ContextBudgetSentinel tick and `SentinelStatus` (`GET /context-budget/sentinel`) gain three rows. The sentinel still ships dark (`contextBudget.sentinel.enabled`, default false).

- **(a) Layer freshness** (`checkFreshness`).
  - It covers every topic with a live session on this machine. H1 is read with `contextLayers.h1Freshness` against TopicMemory. H3 reads `unavailable: h3-not-built`, and the row reads `unavailable: layers-off` without the layers.
  - **Over target on an owned topic.** A rebuild REQUEST goes through the `requestRebuild` seam, at most 3 per durable stale episode and 30 minutes apart.
    - Production wires the seam to the new `LayerCaptureWiring.reproject`. It re-runs the H1/H2 projection from the stored awareness, but only when that awareness covers a newer message than H1. It makes no model call and goes through the layer's own writer.
    - The sentinel never writes a layer itself.
    - Until the capture loop is wired, each request is counted as `unavailable`.
  - **The notice.** ONE notice per episode, raised only when the seam could act (`reprojected` or `failed`), an hour after that first request, on a later tick, and not on a tick that just re-projected.
  - **Unknown.** An unknown stamp is counted, with no action.
- **(b) Hold health** (`checkHolds`, plus a second pool-shared `SelfHealGate`, `context-budget-orphan-carrier-clear`).
  - **What is an orphan.** A fold hold or fold marker whose record is ABSENT or TERMINAL, re-read at every gate check and immediately before the release. Its age is measured from the later of its own write and the record's last update, and must be past a 15-minute grace.
  - **Who clears it.** Only the topic's owner. A non-owner reports `observe-only`.
  - **How it is cleared.** Loudly: a DegradationReporter row (`ContextBudgetSentinel.holdHealth`), the status, and an audit event. It uses the gate's brakes (3 attempts per incident, then ONE Attention item, with the exhausted episode retained 7 days) and a governor policy.
  - **Never cleared here:** a live record, a torn or unreadable record, an unknown age, and the unattributable `_malformed` / `_torn` files (left to the boot sweep).
- **(c) Eligible topic without a fold** (`observeEligible`). Observation only.
  - Without the §7.2 benefit estimator, a live topic with no fold for a day reads `unknown: no-benefit-estimator` and is counted. It is never acted on.

Files changed:

- **`ContextBudgetSentinel.ts`**: the rows, the second gate, and the status fields (bounded to 50 detail rows each, with `checkedAt` and `truncated`).
- **`contextBudgetSentinelBoot.ts`**: `productionLiveTopics` and `productionHoldCarriers`.
- **`layerCaptureWiring.ts`**: `reproject`.
- **`contextLayersBoot.ts`**: `h1Freshness` now also returns `userTurnsBehind`.
- **`FoldCoordinator.ts`**: `inspect` reads absent only on ENOENT (any other stat error is torn).
- **`server.ts`**: wiring. The sentinel gets the same `_foldHolds` instance as the outbound checks and its own governor handle, and a late-bound `_layerReproject` seam.
- **`policies.ts`, `selfActionRegistry.ts`**: two controllers and one policy.
- **`templates.ts`, `PostUpdateMigrator.ts`**: the Registry-First row, and an in-place extension for existing agents.

## Decision-point inventory

- **Rebuild request** (add). A bounded ask to the layer's own writer; it changes no message or session.
- **Stale notice** (add). One Attention item per episode.
- **Orphan clear** (add). Releases a hold or marker file. This is the only state-clearing action, gated as described above.
- **Eligible without a fold** (add). Observation only, with no decision.
- **`FoldRecordStore.inspect`** (modify). Absent only on ENOENT. This is stricter, so it holds MORE, never less.

---

## 1. Over-block

- **An orphan clear can only release, never hold.** A wrong "not orphan" verdict leaves a hold in place until the next boot sweep, which is today's behaviour. The `inspect` change makes a permission error keep a carrier at boot instead of releasing it. That is the same direction of failure: containment wins.
- **A failing session listing (`liveTopics` throws) fails the step.** The heartbeat goes stale, so no fold begins on this machine while the listing fails. This is deliberate and matches how the quarantine step treats `candidates()`: a sentinel that cannot see sessions is not a working sentinel. A corrupt episodes file does NOT fail the step; its bad entries are dropped and audited.

## 2. Under-block

- **Orphans that are not cleared.** An orphan whose age is unknown, or whose file is unattributable, is reported and not cleared. It waits for the boot sweep, so a muted conversation could stay muted until a restart. It is visible on the row as `unknown`.
- **Exhausted orphans.** An exhausted orphan ladder is not retried for 7 days: one notice, then the boot sweep. The ring (4 episodes per topic and kind) could evict the oldest exhausted episode if a fifth marker fold on the same topic exhausts, and re-page it. This is recorded, and it is rare by construction.
- **Episode-file corruption.** A corrupt episodes file restarts the stale episodes, and with them their 3-request budget and their notice, once per corruption.

## 3. Level-of-abstraction fit

- The sentinel observes and asks; the layer's own writer (the capture wiring) writes. The orphan release goes through each carrier's own `release`. `FoldHoldStore.release` re-checks the fold id, so a hold for a different fold that replaced the file is untouched.
- **Recorded deviation (reviewer SF3).** The rebuild request carries its own durable counters rather than a SelfHealGate episode. It is §7.8's bounded "ask the session" class, not a heal ladder. Its bound is per episode file, and the registry model says so.

## 4. Signal vs authority compliance

- Freshness and eligible-without-fold are signals: counted and shown, with the only action an ask.
- The orphan clear is an authority over a file. It is held by the topic's owner only, is deterministic (no model), is corroborated (record re-read, carrier re-listed, file-generation fence), and runs under the gate's pre-declared brakes.

## 4b. Judgment-point check

The 15-minute grace, the 3 requests 30 minutes apart, the one-hour sustained window, the 24-hour no-fold window and the 50-row bound are cost and safety defaults. The spec's Defaults table and its "for a day" fix some of them. None of them judges between competing live signals. They are to be revised from S13 measurement. <!-- tracked: CMT-1536 -->

## 5. Interactions

- **Boot sweep.** It releases orphans with no grace at boot. The sentinel is stricter (grace, owner, corroboration) and only runs between boots.
- **Quarantine ladder.** The orphan ladder shares the sentinel's episode store file under its own id prefix. Pruning is per prefix.
- **Outbound chokepoints.** The release goes through the same `FoldHoldStore` instance, so its in-memory known-holds set is dropped too.
- **Capture loop.** A `reproject` runs the same `project` as a turn. A failed one also increments the wiring's `failed` counter (recorded nit).
- **Heartbeat.** The new steps join the tick. A step failure (listing throws, or the orphan episode store fails) leaves the heartbeat stale, which pauses new folds.

## 6. External surfaces

- `GET /context-budget/sentinel` gains `layerFreshness`, `holdHealth` and `eligibleWithoutFold`.
- New degradation feature: `ContextBudgetSentinel.holdHealth`.
- New Attention ids: `context-budget-layer-stale-*` and `context-budget-orphan-*`.
- The CLAUDE.md Registry-First row text changes.
- No new route and no new switch.

## 6b. Operator-surface quality

No dashboard file is touched (the card is S14). The notices are written in plain language with `topicRef()`, and the topic-ref ratchet is green.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Holds, markers and fold records: machine-local.** The owner wrote them, and only `ownsTopic(topic) === true` acts. With pool placement live, production reads ownership as `unknown`, so every machine observes only.
- **Stale episodes, the orphan ladder's episodes and the freshness reading: machine-local by design.** Each machine watches its own live sessions (§14 owner-acts; A13: freshness applies on every machine that owns a topic).

## 8. Rollback cost

- `contextBudget.sentinel.enabled: false` removes all three rows at the next restart.
- New state files: `state/context-budget/layer-stale-episodes.json` and orphan rows in the existing episode DB. Both are inert when the sentinel is off.
- A release revert is clean. The migrator's row extension is text only.

## Conclusion

S12 completes the Phase 1 sentinel rows. Freshness asks, and pages once only when an ask that could help did not. Hold health clears leaked containment loudly, only on the owner, only after corroboration. The eligible-without-fold row is honest about what it cannot measure yet.

## Second-pass review (if required)

**Reviewer:** Fable 5.2

**Pass 1 verdict:** concur-with-fixes. No blocking findings. It found no path that clears a hold or marker guarding a live fold.

Should-fix, all addressed:

1. **The stale notice would fire on normal quiet conversations** (acknowledgements leave H1 where it was, so the seam answers `awareness-behind`). Fixed: the notice requires a request the seam could act on (`reprojected`/`failed`). Other outcomes are counted and never page. Tested.
2. **The notice could land in the same tick as the request it blames, measured from the episode start.** Fixed: it is measured from the first actionable request, on a later tick, and not on a tick that just re-projected. Tests cover the non-owner→owner flip and the re-projected defer.
3. **The rebuild ladder hand-rolls its brakes.** Recorded as a deviation (§3 above); the model comment states the per-file bound.
4. **A corrupt episodes file could fail every tick and stop all folds.** Fixed: entries are validated and dropped (audited). Tested, along with the deliberate listing-throws behaviour.
5. **The race test did not isolate the last re-read.** Fixed: the record comes back at every listing 2–6 (including `clearOrphan`'s own), with a positive control of 7 listings on a clean clear, plus a different-fold-replaces-the-file test.

Nits fixed:

- `inspect` reads absent only on ENOENT (tested with an unreadable directory).
- The exhaustion notice is worded by reason.
- The notice-topic map is pruned to entries still on disk, so a queued-admission notice keeps its topic.
- The flush runs on a per-tick flag.
- `checkedAt` is on all three rows, and the totals are labelled since-process-start.

Nits recorded, not fixed:

- Evidence is recomputed per gate check (fine at current sizes).
- Ring eviction can re-page a fifth exhausted marker fold on one topic.
- `reproject` failures count in the wiring's `failed` counter.

**Resolution check:** CONCUR. Fable 5.2 marked SF1–SF5 and every fixed nit RESOLVED against the current text, re-ran the touched test files and tsc green, and found no new blocking issue. It accepted the three recorded nits as known. Two follow-ups were applied:

- The SF3 deviation is now also stated in the sentinel's header comment.
- A residual is listed below.

Known residual (accepted): a request that answers `reprojected` while H1 is still more than 2 user turns behind can lead to the notice an hour later on a conversation that then sends only acknowledgements. This matches the rule ("the seam acted and it did not help").

## Evidence pointers

- **Unit:**
  - `tests/unit/ContextBudgetSentinel-rows.test.ts` (27 tests). Every row with missing evidence reads unknown, is counted and takes no action. A non-owner observes. Sustained staleness gives exactly one notice, across a restart. An orphan is cleared, a live one is not, and one inside the grace period is not. Terminal-record orphans, markers, torn, malformed and unreadable files, corroboration races, exhaustion with one notice, and eligible-without-fold never acting are all covered.
  - `tests/unit/migrate-context-budget-sentinel-row.test.ts` (3).
  - The existing ones still pass: `ContextBudgetSentinel.test.ts` (32), `FoldCoordinator.test.ts` (32), `FoldHoldStore.test.ts` (21), `self-action-convergence.test.ts` (770), the lint test, and the topic-ref, no-silent-fallbacks, feature-ladders and feature-delivery-completeness ratchets.
- **Integration:** `tests/integration/context-budget-sentinel-rows.test.ts` (4). Uses the real TopicMemory, capture loop and layer store to show stale H1 → seam → fresh, and awareness-behind → no write. An orphan hold is cleared with a real DegradationReporter row, and the route shows the three rows.
- **E2E:** `tests/e2e/context-budget-sentinel-rows-alive.test.ts` (2). The production boot path with the real governor handles shows 200 with all three rows and an orphan cleared, plus WIRED source checks on server.ts.
- **Typecheck:** `tsc --noEmit` is clean.

## Class-Closure Declaration (display-only mirror)

Class `unbounded-self-action`, closure `guard`. Citation `tests/unit/self-action-convergence.test.ts`, enforcement `ratchet`. Both new self-triggered actions (the orphan clear and the rebuild request) are registered controllers in `SELF_ACTION_CONTROLLERS` and settle under sustained pressure.

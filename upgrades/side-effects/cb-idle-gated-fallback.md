# Side-effects review — idle-gated, durable server fallback after a missed compaction seed

**Version / slug:** `cb-idle-gated-fallback`
**Date:** 2026-11-09
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.1 ("If no marker appears, the server-side path runs once … through the idle-gated inject path (`PendingInjectStore`, whose redelivery for this record is released only when `isSessionActivelyWorking()` is false and the pane shows a ready prompt, re-checked each tick within the step bound; … never a bare `injectMessage`), idempotent on the compaction epoch … One injector at a time"), §6 summary line ("the seed fallback goes through the idle-gated inject store, never a bare inject"), §9.3 ("In-flight injects live in `PendingInjectStore`"). Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0, sixth slice; stacked on `cb-precompact-steer`.
**Tier:** 2 (session-lifecycle/recovery injection path, fleet-wide when the switch is on). Size: 8 files, ~760 LOC incl. ~430 test LOC. Effort: one build pass.

## Summary of the change

Before: with `contextBudget.compactionRecovery.enabled` on and a Claude Code session, when the SessionStart(compact) hook's seeded marker did not appear in the seed wait, `CompactionSentinel` ran today's path: `recoverFn` → `recoverCompactedSession` → a bare `sessionManager.injectMessage`, with up to 3 attempts and a working-defer. A server restart during the wait lost the recovery entirely.

After (same switch, same engine; nothing changes otherwise):

1. `CompactionSentinel` gains an optional `fallback` dep (`CompactionFallbackDeps`: build / stage / clear / list / isReadyPrompt / inject) and a new non-terminal status `awaiting-idle` (the zombie-kill veto holds through it).
2. Seed wait ends with no marker → `startFallback(epoch)`, epoch = the compact-boundary entry's uuid (or `t<detectedAt>` when none was seen). Already delivered for this epoch → stand down. `build` → `declined` (no unanswered user message, session gone) closes out exactly as today's `recoverFn declined`; `unsupported` (no Telegram topic, e.g. Slack) runs today's `attemptInjection` path unchanged.
3. The text is **staged durably** in `PendingInjectStore` under its own key `__compaction_fallback__-<tmux>` (never the session's own key, so it cannot overwrite a pending initial message) and `doNotReplay`, so SessionManager's generic boot sweep never re-injects it (it only ages such records out after 24 h).
4. **Gate, re-checked every tick (seedPollMs, 2 s) for up to `fallbackIdleBoundMs` (5 min):** late hook seed for this compaction (same freshness rule as the seed wait, including the boundary rule) → withdraw, `recovered`; session no longer recoverable → withdraw, `failed`; another inject pending for the session (an initial message) → wait, one injector at a time; `isActivelyWorking` false **and** `classifyPaneState === 'ready'` → **rebuild the text at release** (the session may have answered the user meanwhile: `declined` withdraws it, otherwise the fresh text is used), inject once, clear, re-baseline the transcript, verify once. Bound reached while still working → withdraw, stand down `recovered` (same rule as the existing working-defer budget: never interrupt a live turn); bound reached not working but no ready prompt → withdraw, `failed` with that reason.
5. **Once per epoch, no retry:** after the one delivery, a verify window with no transcript growth (baseline taken at delivery, so the compaction's own writes do not count) finalizes `failed` ("fallback delivered once; no output followed") instead of re-injecting. Without a boundary the epoch is only `t<detectedAt>`, so a delivery within the last seed-max-wait + bound window also counts as this epoch.
6. **Restart:** at boot, `resumeStagedFallbacks()` picks staged records up under the same gate, within what is left of the original bound. Switch now off, older than 15 min, the session not running, or another recovery already owning it → withdrawn and reported through `DegradationReporter` (`CompactionSentinel.fallback`), never delivered.
7. **Session end:** `clear()` (wired to `sessionComplete`) withdraws a staged record; `stop()` (shutdown) keeps it for the resume.
8. `server.ts`: `recoverCompactedSession`'s Telegram text builder is extracted into `buildTelegramCompactionText` (same text, same unanswered-message rule) and shared by the direct path and the fallback. New `src/monitoring/compactionFallbackStore.ts` adapts PendingInjectStore.

The payload is today's recovery payload; the spec's standing packet replaces it in Phase 1 (`recoverCompactedSession`'s payload "is retired into it"). <!-- tracked: CMT-1536 (Phase 1 standing packet) -->

## Decision-point inventory

- **Modified:** when the server-side post-compaction fallback types into a session. Before: after the seed wait, immediately unless the footer shows work (bounded defers, up to 3 attempts). After: only at an idle, ready prompt, once per epoch, durably staged. Deterministic predicates over pane/process evidence; no new judgment.
- **Unchanged:** switch off, non-Claude engines, no `fallback` dep, Slack sessions (unsupported) — today's path byte-for-byte.

## 1. Over-block

- A session whose pane never matches the ready-prompt classifier (unusual TUI layout) is not idle-matched for 5 min and the fallback is withdrawn as `failed`. Before, such a session would have been injected into. Evidence: the classifier is the one SessionManager already trusts for readiness before every initial-message inject; the outcome is logged and emitted (`compaction:failed`), so the standing canary (later slice) sees it.
- A session that works continuously for 5 min after compaction gets no fallback (stand down). Same rule the working-defer budget already applies.

## 2. Under-block

- At-least-once window: the record is cleared just after the inject; a crash between the two re-delivers it after the restart (gated). Microsecond window; a duplicate briefing is recoverable noise.
- The delivered-epoch memory is in process; after a restart only the store protects against a second delivery, which is enough because the record is cleared on delivery.
- The spec's "whose seeded marker then makes any late hook seed a no-op" is not built: the server does not write a seeded marker on delivery. A hook seed after the server's delivery is not reachable in practice (the SessionStart(compact) hook runs as compaction completes, inside the 30 s wait), and the canary slice counts double recovery blocks per compaction. <!-- tracked: CMT-1536 (Phase 0 task 10 sentinel canary) -->
- Boot resume relies on `listRunningSessions()` being populated at that point; if not, the record is withdrawn and reported (loud, not silent).

## 3. Level-of-abstraction fit

Right layer: the sentinel already owns the recovery lifecycle, timers, the seed wait and the zombie veto; the gate is one more state in it. The durable store is the existing PendingInjectStore (as the spec names), not a new ledger; the adapter keeps the sentinel free of the store's file format.

## 4. Signal vs authority compliance

No new blocking authority over user messages. The gate only delays/withholds the sentinel's own injection, on deterministic evidence, failing toward not interrupting the session. Complies.

## 5. Interactions

- **RateLimitSentinel bidirectional defer:** unchanged; `awaiting-idle` is non-terminal, so `isRecoveryActive` stays true and the rate-limit sentinel defers.
- **SessionManager.recoverPendingInjects:** sees the record as `doNotReplay` → skipped (and aged out at 24 h). Integration test drives the real sweep.
- **Pending initial-message record for the same session:** separate key; integration and unit tests show both coexist.
- **Seeded marker / consumed set (slice 2):** a late marker withdraws the fallback and is consumed so it cannot cover a later compaction.
- **Zombie-kill veto:** held while staged (non-terminal), released 5 s after `recovered` / 30 s after `failed`, as today.

## 6. External surfaces

New files under `.instar/state/pending-injects/` (existing directory, git-ignored). One new degradation feature name. No route, no user message, no CLAUDE.md change.

## 7. Multi-machine posture

Machine-local by design: the session, its pane and its pending-injects ledger are all on the hosting machine; the fallback is staged and delivered there. A topic that moves machines ends its session here (`sessionComplete` → `clear()` withdraws the record).

## 8. Rollback cost

Low. `contextBudget.compactionRecovery.enabled: false` restores today's path at once (the seed wait, and with it the fallback, no longer runs; a record staged before the switch flipped is withdrawn at the next boot, or delivered under the gate if the server does not restart within its 5-minute bound); or revert (a leftover staged record is `doNotReplay` and the generic sweep ages it out at 24 h). No data migration.

## Evidence

- `tests/unit/CompactionSentinel-idle-gated-fallback.test.ts` (23): re-check at release withdraws when the user was answered meanwhile; rebuilt text delivered; inject not accepted fails without retry; waits behind a pending initial message; an earlier compaction's marker does not withdraw (boundary rule); verify baseline at delivery; resume withdraws for session gone / switch off / newer recovery; plus: delivers once at idle+ready and never calls the bare `recoverFn`; holds while working; holds while not at a ready prompt; stands down after working through the bound; fails honestly with no ready prompt; late seed withdraws; no re-inject after one silent delivery; recovered on growth; once per epoch across two reports; Slack-style `unsupported` keeps the legacy path; `declined` stages nothing; session end withdraws; `clear()` removes vs `stop()` keeps; restart resume under the gate; stale record withdrawn and reported; coexistence with the generic sweep.
- `tests/integration/compaction-idle-gated-fallback-wiring.test.ts` (2): real SessionManager `isSessionActivelyWorking` + `classifyPaneState` (positive control: the real classifier reads the ready pane as `ready`), real store in SessionManager's own directory; real `recoverPendingInjects` replays the initial message and leaves the fallback.
- `tests/e2e/compaction-idle-gated-fallback-lifecycle.test.ts` (2): real disk and timers across a restart (stage while working → process stops → resume → deliver once at idle → verified); `server.ts` wiring check.
- Existing compaction suites re-run green: 4 integration files (10 tests), 6 e2e files (49), sentinel/store unit files (90).

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-09):** "Concern raised." Blocking: (1) the unanswered-message check was frozen at stage time, so a session that answered the user while the fallback waited would get a stale "unanswered message" briefing. Minor: (2) rollback claim false — resume ignored the switch; (3) late-seed check looser than the seed wait (no boundary rule); (4) epoch idempotence partial without a boundary, `deliveredFallbackEpoch` never pruned, server-side seeded marker not built; (5) verify baseline pre-compaction, so "no output followed" was unreachable after a boundary; (6) boot could have two injectors (initial-message sweep + fallback); (7) test gaps. Confirmed clean: identity guards against clear/stop/new report races, refactor behaviour-equivalent, store key coexistence, boot ordering, zombie veto, gate tests sensitive to removal.

**Resolution:** (1) the text is rebuilt at release and a `declined` withdraws it (tests: answered-meanwhile, rebuilt text delivered). (2) resume withdraws when the switch is off; §8 rewritten. (3) shared `seedMarkerCovers` with the boundary rule (test). (4) no-boundary window rule and pruning on clear/stop added; the server-side marker is disclosed and tracked in §2. (5) baseline re-read at delivery (test with a boundary). (6) `otherInjectPending` makes the fallback wait behind a pending initial message (test). (7) tests added for every branch named.

**Reviewer re-check (same reviewer, after the fixes):** "Concur with the review." All seven items confirmed resolved against the code; async re-entrancy safe (identity re-checked after the await, one tick chain per state). New minor notes: a `build()` throw at release read as `recovered` — fixed in this commit (it keeps waiting and retries next tick; test added); a record 5–15 min old at boot gets only a brief window since the bound counts from staging (accepted: by then the conversation has moved on, and the expiry is visible as `compaction:failed`); the no-boundary window can suppress a genuine second compaction within about 8 minutes (fails toward not injecting; accepted); `otherInjectPending` reads the ledger directory every 2 s per staged session (fine at current sizes).

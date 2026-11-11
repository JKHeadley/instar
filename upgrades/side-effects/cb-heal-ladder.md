# Side-Effects Review — the 9.1 fix live: heal ladder by cause, synthetic press, context epoch (context budget Phase 1 S11)

**Version / slug:** `cb-heal-ladder`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2 (independent subagent; see end)`
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.1 (standing canary, context epoch, self-heal ladder by cause and its brakes, "one carrier"), §7.7 (seeded marker), §7.8 (sentinel actions, dev-gated), §9.5, §17 rows "Compaction detected", "Seeded marker / context epoch", "Compaction recovery ran". Phase 1 plan row S11.
**Tier:** 2 (a sentinel action with injection authority into live sessions, plus a `/compact` press; session lifecycle).

## Summary of the change

1. **Context epoch, one derivation** (`src/monitoring/contextEpoch.ts`, new). `deriveContextEpoch` (compaction ⇒ compact-boundary id; fold/clear ⇒ `foldId`; otherwise ⇒ spawn id), `boundaryEpochFor` (a time belongs to the newest boundary at or before it plus 2 s hook slack) and `markerEpoch` (an explicit epoch wins; a compaction marker with an empty epoch binds to its boundary; a server marker is never re-bound by time). Every writer and reader now goes through it: the CompactionSentinel seed wait and fallback, the server's new marker writer, the heal ladder. The two hook writers are unchanged shell/Python: the compact branch still writes `epoch: ''` (it runs before Claude Code flushes this compaction's boundary, measured on 2.1.321) and the clear-seed hook writes `foldId`; a unit test drives both REAL rendered hooks plus the server writer plus the canary and proves they name the same epoch.
2. **Server-written seeded marker** (`compactionSeedMarker.ts` `writeSeedMarkerFile`, `CompactionSentinel` dep `writeSeedMarker`). After the idle-gated path delivers a compaction's context (the existing fallback, or a heal re-inject), the server writes `_seeded/<claudeSessionId>.json` with `epoch = boundary id`, `source: server-fallback | heal`. This closes the gap cb-idle-gated-fallback recorded ("the server does not write a seeded marker on delivery"). A server marker covers ONLY its own epoch: the seed wait accepts it only when the visible boundary's id equals its epoch, never by timing, so it can never stand a newer compaction down.
3. **Heal ladder by cause** (`src/monitoring/canaryHealLadder.ts`, new; ticked by `ContextBudgetSentinel` after the canary scan). Over the canary's SETTLED divergences in the current verification epoch (`CompactionCanary.divergences()`, new):
   - hook family not installed (`compactionHookInstallCheck`: settings SessionStart(compact) and PostCompact entries; session-start.sh with the marker writer and fitter call; compaction-recovery.sh with the recovery marker; the fitter; post-compact.sh) ⇒ **re-run-migration** (`PostUpdateMigrator.repairCompactionRecoveryHooks()`: `migrateHooks` + `migrateSettings` only);
   - installed, no recovery block, or RF's `recoveryTruncated` ⇒ **re-stage-and-reinject-seed**: the topic's standing packet is re-staged (`packetForSession`) with a new heal preamble (`buildHealReseedPayload`: "do not message about this, do not repeat an answer"), filed when large under a HEAL stub (`prepareHealInjectionText` via `healReseedText`, 0600; never the resume stub that tells a session to announce the pause and answer the latest message), and delivered once through `CompactionSentinel.healReinject` — the same idle-gated, durable PendingInjectStore path as the fallback (not working AND ready prompt, re-checked every tick within the 5-min bound, one injector at a time), never through `report`;
   - record-only: block delivered but no PostCompact record; session gone; a throwaway with no packet (`not-reseedable`); a compaction a newer one superseded; a non-Claude engine; a press no boundary followed ("detection without a real compaction").
   Brakes through a pool-shared async `SelfHealGate` (own store `canary-heal-episodes.db`, ring of 4 per session): dedupe key `machine.session.epoch`, `maxAttempts 3`, backoff 10 min then 1 h, wall clock 30 min, latency ceiling 300 s. Beside the gate (as the quarantine ladder's breaker): ≤ 3 runs per session per 24 h, checked BEFORE the gate so a capped session opens no episode (and never pages about tries it never made); the breaker (3 completed heals of one cause in 24 h ⇒ that cause turns record-only and ONE Attention item, raised once per window). Exhaustion ⇒ one Attention item per cause per 24 h (§7.8's same-cause rule; durable pending list, retried). A completed remediation restarts the canary's verification epoch once every divergence in it has been handled, so no other session's divergence is dropped. The ladder waits (spending nothing) until the CompactionSentinel is built later in boot (`ready`). Compensation: a server-written marker for the epoch ⇒ healed without injecting.
4. **Synthetic press** (`src/monitoring/syntheticPress.ts`, new). `pressTargetRefusal` admits ONLY a throwaway: name prefix `cb-press-`, no Telegram topic or Slack channel on the session AND none mapped by the adapter (an adapter that throws counts as bound), not a job, Claude Code with a known engine session, not protected. `SyntheticPress` presses `/compact` through `SessionManager.injectInternalControlCommand` (the closed control-command path) at an idle, ready prompt, calling `canary.recordSyntheticPress` first (its first caller). It presses only while this machine's group has no complete synthetic positive in the epoch and no press is awaiting its boundary; bounded by its own `SelfHealGate` (hardware-bound, one episode per machine per day, 3 attempts, 1 h backoff). The canary's scope now includes press targets (`productionCanarySessions`), and `POST /hooks/post-compact` files a press target's record under `press-<instarSessionId>` (same refusal predicate, protection included) so the positive control can be complete; a press target's span is never archived or chunked. **Nothing in this slice creates a `cb-press-` session**: until one is started (the verification run's job, or by hand through `POST /sessions/spawn` with that name), the press reads `no-target` and `healthy` stays unreachable from presses. <!-- tracked: CMT-1536 (Phase 1: provision the throwaway press target on the dev agent) -->
5. **Gating.** The server-written marker (item 2) is NOT behind the sentinel: it rides the existing fallback, i.e. `contextBudget.compactionRecovery.enabled` (default on), so every agent with recovery on writes a `server-fallback` marker after a fallback delivery and its seed wait takes the exact-epoch branch for such markers. That is the spec's §9.1 one-carrier rule (a bug fix shipped live), not a dark feature. The heal ladder and press are built in `server.ts` only inside the existing `contextBudget.sentinel.enabled` (default false) block AND when the context-budget layers are on (`contextLayersEnabled`, dev-gated); the sentinel ticks heal and press only while `contextBudget.compactionRecovery.enabled` is on. No new switch (both ride `contextBudget.sentinel`, whose feature-ladder entry already covers sub-switches). Two self-action controllers registered (`selfActionRegistry`, governor policies): `context-budget-canary-heal` (relief, pool-shared, open-audited), `context-budget-synthetic-press` (amplifying, hardware-bound, closed-queue).
6. `GET /context-budget/sentinel` now carries `heal` (recent decisions, 24 h counts, open breakers, last run) and `press` (last outcome). Docs: a Context Budget section in `site/src/content/docs/features/memory.md` documents the family's routes.

Files: new `contextEpoch.ts`, `canaryHealLadder.ts`, `syntheticPress.ts`; modified `CompactionSentinel.ts`, `ContextBudgetSentinel.ts`, `compactionCanary.ts`, `compactionSeedMarker.ts`, `contextBudgetSentinelBoot.ts`, `compactionResumePayload.ts`, `PostUpdateMigrator.ts`, `server.ts`, `routes.ts`, `selfaction/policies.ts`, `testing/selfActionRegistry.ts`, docs, tests.

## Decision-point inventory

- **Heal ladder cause → action** — add — deterministic over file evidence (settings, hook scripts), the canary ledger and the session list; no judgment.
- **Whether the server injects a heal re-seed** — add — only rung 2, only through the idle gate, only once per epoch, only on the session's owner.
- **Whether a server-written marker stands the seed wait down** — modify — only for its exact epoch.
- **Press target admission** — add — a closed predicate; refuses by default.
- **Seed-wait short-circuit and fallback** — pass-through — the 30 s bound after the boundary, the idle gate, `PendingInjectStore`, the readiness predicate re-checked each tick and "one injector at a time" are the Phase 0 implementation (cb-one-recovery-carrier, cb-idle-gated-fallback), unchanged except the epoch derivation and the marker write; tests on both sides of the 30 s bound are added.

---

## 1. Over-block

- A heal is refused for a session the cap (3 runs / 24 h), the breaker, or ownership (`poolLive` ⇒ `unknown`) excludes; that session stays without its packet until a new compaction or a fresh session. Intended: the ladder must not loop on a cause it cannot fix.
- The install check is strict on content markers (`'_seeded'`, `fit-recovery-output.mjs`, the recovery marker). A hand-edited hook that still works but lacks those strings reads "not installed" and is overwritten by the migration — the same thing `migrateHooks` does on every update (built-in hooks are always overwritten), so no new loss.
- A throwaway whose name lacks the prefix is never pressed; the canary then cannot reach `healthy` on that machine from presses (natural manual compactions still count only with a recorded press).

## 2. Under-block

- **Rung 1 does not re-seed.** Spec-literal: hook not installed ⇒ re-run the migration. The session whose compaction missed its block is healed only for future compactions; its current context is not re-delivered by this rung (the detection is terminal once the migration heals). Noted for Phase 1 review.
- **Backoff vs wall clock.** The spec's brakes (attempts 3, backoff 10 min then 1 h, wall clock 30 min) make the third attempt unreachable: attempt 2 at +10 min, attempt 3 would be at +70 min, past the 30-min wall clock ⇒ exhausted. Implemented as written; effectively two attempts.
- **Latency notices are audited, not paged.** The gate's 300 s latency notice fires on every second attempt (10 min backoff > 300 s by design); routing it to Attention would page on every slow heal. Exhaustion and the breaker are the operator channel (§7.8 "raise one notice when a ladder is exhausted").
- **Delivery wait.** A remediation waits up to 60 s for the idle-gated delivery; a still-staged delivery is checked on the next attempt (the server marker then reads as healed). If the delivery later fails, the next attempt re-stages it (bounded by the episode).
- **A missing settings file is not recreated.** `migrateSettings` patches an existing `.claude/settings.json` (every agent's `init` writes one); an agent whose file was deleted stays "not installed" and the episode exhausts with one Attention item.
- **One remediation per tick.** Several sessions needing heals are served one per 5-minute tick (the epoch restart waits for all of them).
- **In-memory once-per-epoch.** `deliveredFallback` and `consumedSeedAt` are per process; after a restart only the marker file (and the ladder's handled ledger) protect an epoch. A failed marker write plus a restart could re-deliver once.
- **Press day boundary.** The press episode is keyed on the UTC day, so two presses either side of midnight can be under an hour apart; the governor's 3-per-24 h window is the outer bound.
- **Record-only leaves the canary diverged.** A `session-gone` or `post-compact-missing` divergence is recorded and does not restart the epoch, so the machine reads `diverged` until a remediation completes elsewhere. That is the truth (a hook family missed a recovery), not a notice.
- **Grace-window detections at an epoch restart.** A detection still inside its 10-minute artifact grace when the epoch restarts leaves the epoch; if it later settles diverged it is not served (the next compaction is). Reviewer residual, round 2.
- **Capped or governed rows hold the restart.** A non-terminal `capped`/`governed` row keeps the epoch (and `diverged`) for up to 24 h, until the cap frees or the row resolves.
- **Exhaustion dedupe across a queued admission.** The cause comes from the in-attempt context; a notice raised from a governor-queued admission is not deduped and notifies (fails toward telling).
- **Heal files in /tmp.** A large re-seed is written 0600 under `/tmp/instar-compaction-resume` (the resume path's directory; its 0700 mkdir does not tighten an existing directory) and, like the resume files, is not removed.
- **An unreadable heal ledger** starts over, resetting the per-session cap and breaker counts; the gate's episode store still holds attempts per epoch.
- **Press on a throwaway relies on the name prefix and channel checks.** A session someone deliberately names `cb-press-…` with no channel is treated as throwaway. It must also be idle at a ready prompt, and `/compact` only compacts that session's own context.
- **Late hook seed after a server delivery.** The hook does not read the marker before seeding (it cannot know the epoch); a hook seed after the server's delivery for the same compaction is not reachable in practice (the hook runs as compaction completes, inside the 30 s wait). The marker's compensation is enforced on the server side (seed wait, heal ladder).

## 3. Level-of-abstraction fit

The ladder is a SelfHealGate consumer ticked by the existing sentinel (§7.8: "Each ladder is a SelfHealGate declaration"), not a parallel watcher. The re-inject reuses the CompactionSentinel's idle-gated path (`healReinject` shares `tickFallback`, the durable store, the zombie veto and "one injector"), not a new injector. The epoch is one module every server writer and reader uses. The migration re-run is the migrator's own two steps.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

It blocks no user message. It holds ACTION authority (re-run a migration, type a re-seed at an idle prompt, press `/compact` on a throwaway), each pre-declared and bounded by the gate (Standard B), on deterministic multi-signal evidence, failing toward doing nothing (unknown ownership, unreadable switch, busy pane, unknown channel ⇒ no action).

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The cause classification is an enumerable domain (installed or not; block present, truncated or absent; session live or gone), and the numbers are the spec's declared brakes (§9.1). The press bound (3/day, 1 h) is a safety cap on an amplifying action.

## 5. Interactions

- **CompactionSentinel `report`:** a heal stages under `active`, so a `report` during it returns early (one injector); a heal is refused while a recovery is active. Test: "one injector at a time".
- **Fallback once-per-epoch:** `deliveredFallback` now also blocks a heal for the same epoch (`already-delivered`).
- **Seeded marker file:** one file per engine session; the server write overwrites the hook's marker. The seed wait's `consumedSeedAt` is advanced to the server marker, so it cannot satisfy a later compaction; a server marker needs an exact epoch match (test: a newer compaction 20 s later is NOT stood down).
- **PendingInjectStore boot sweep:** heal records are `doNotReplay` like fallback records (same adapter); `resumeStagedFallbacks` resumes a staged heal (trigger `heal`) with its staged text, never the unanswered-message builder.
- **Canary epoch:** a completed heal restarts it, so a historical divergence stops reading `diverged`; the audit keeps it (heal ledger `canary-heal.json`, canary ledger history).
- **Quarantine ladder:** separate gate, separate store file, separate controller id; the shared outbox is untouched.
- **Press and PresenceProxy/RateLimitSentinel:** a press target has no channel, so neither watches it.
- **PostCompact route:** previously answered `no-topic` for a press-shaped session; now records it under `press-<id>`. Any other channel-less session still answers `no-topic`.

## 6. External surfaces

- Sessions on a dev machine with the sentinel on can receive one re-seed message after a missed recovery (Telegram topics only), at an idle prompt.
- Attention items: "A session did not get its context back after a compaction" (exhaustion) and "Compaction recovery keeps failing the same way on this machine" (breaker), both HIGH, once each.
- New state files under `state/context-budget/` (`canary-heal.json`, `canary-heal-episodes.db`, `synthetic-press-episodes.db`) and `state/context-layers/press-<id>/post-compact/`; all machine-local, under the never-synced state root.
- `GET /context-budget/sentinel` gains `heal` and `press` fields (additive).
- **Operator surface:** no operator-facing actions are added; the notices are informational Attention items.

## 6b. Operator-surface quality

No operator surface touched (no dashboard, approval page or form files).

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local. The heal acts only on sessions live on this machine and is pool-shared (`ownsSession` = `unknown` while pool placement is live ⇒ the gate refuses). The press targets only this machine's throwaways (hardware-bound). Markers, ledgers and episode stores are per machine and never replicate. **Status surfaces:** `GET /context-budget/sentinel` reports this machine only (unchanged scope).

## 8. Rollback cost

Turn off `contextBudget.sentinel.enabled` (or `contextBudget.enabled`, or `contextBudget.compactionRecovery.enabled`) and restart: nothing heals or presses; a heal staged before the restart is withdrawn at boot unless the ladder is wired again (`isHealEnabled`). The server-written marker stops only with `contextBudget.compactionRecovery.enabled` off. Code revert is clean: the only persisted shapes are new files and an optional `source` field on markers (older readers ignore it). The CompactionSentinel changes are inert without the `writeSeedMarker` dep and when no server marker exists.

## Conclusion

Ships the §9.1 heal ladder, the positive control and the shared epoch behind two dev gates and the recovery switch. Known deviations are stated above (rung 1 does not re-seed; the brakes make a third attempt unreachable; latency notices audited).

## Second-pass review (if required)

**Reviewer:** Fable 5.2 (independent subagent)
**Independent read of the artifact: concern**

Read independently: spec §9.1, §7.7, §7.8, §9.5 and the §17 rows; this artifact and the release note; the full diff and the new tests. Tests were read, not re-run. The idle gate, the press target predicate, the server-marker epoch match and the switch gating hold up. One defect should be fixed before this ships, and three claims above do not match the code.

**Blocks-now**

1. **The production heal re-seed is replaced by the ordinary "answer the user" resume stub.** `server.ts` `reseedText` wraps the payload in `prepareInjectionText` (`src/commands/server.ts:13444`), whose file threshold is 500 characters (`compactionResumePayload.ts:109`). `HEAL_RESEED_PREAMBLE` alone is 429 characters, so any real packet goes over and the session is typed the fixed stub at `compactionResumePayload.ts:134-141`: "Your session just went through context compaction... your FIRST sentence must be a brief, calm statement that your session paused... then respond directly to the user's MOST RECENT message", prefixed `[telegram:N]`. The "do not message about this, do not repeat an answer" preamble sits only inside the file. A heal lands 10+ minutes after the compaction, so this makes the session announce a compaction and re-answer a message it may already have answered: a user-visible send the sentinel caused (§7.8 "never ... send to the user outside the one-notice breaker"), and the opposite of what this artifact and the release note claim. No test sees it: the integration rig passes its own `reseedText` (`tests/integration/context-budget-canary-heal.test.ts:104`) and the e2e WIRED test does not look at this closure. Fix: a heal-specific stub (or inline delivery) plus a test that drives the real closure with a realistic packet.

**Major**

2. **A completed heal drops every other outstanding divergence.** `tick` calls `canary.restartEpoch()` and breaks (`canaryHealLadder.ts:333-337`); `divergences()` filters on `d.at >= epochStartedAt` (`compactionCanary.ts:262-266`). So with sessions A, B and C all missing recovery, A is healed and B and C are never served, with no record and no notice. Rung 1 does the same: one migration re-run drops every session's divergence. The artifact's "Several sessions needing heals are served one per 5-minute tick" is not what happens. Either keep unhandled divergences eligible across the restart or state the loss.
3. **Exhaustion notices are not bounded across sessions or epochs.** Each `(session, epoch)` episode that exhausts raises its own HIGH Attention item (`canaryHealLadder.ts:413-426`; the gate's notice id is per key and start time). The breaker counts only completed heals (`:330`, `:276-279`), so a cause that keeps failing (no packet, never idle, marker unwritable) pages once per compaction per session, indefinitely. §7.8's common field is "3 same-cause exhaustions in 24 h ⇒ one notice". Related: when the per-session daily cap refuses (`eligible`, `:215`), the gate has already opened the episode (`SelfHealGate.ts:293`), which then exhausts on wall clock 30 minutes later and pages "three tries ... did not work" with zero tries made.
4. **Nothing creates a `cb-press-` session.** The prefix appears only in `syntheticPress.ts`, tests and docs. In production the press always returns `no-target` unless someone spawns such a session by hand, so the positive control never runs and `healthy` stays unreachable. Not stated above.
5. **The server-written marker is live outside the dev gates.** `writeSeedMarker` is wired unconditionally on the CompactionSentinel (`server.ts:15886-15895`), so every agent with compaction recovery on (default on) now writes a `server-fallback` marker after a fallback delivery, and the new freshness branch (`CompactionSentinel.ts:427-434`) applies fleet-wide. §5 Gating and §8 ("inert without the `writeSeedMarker` dep") read as if this sat behind the sentinel switch. The behaviour looks correct; the claim is not.

**Minor**

6. `POST /hooks/post-compact` for a press target also archives the span and enqueues an LLM chunk build under `press-<id>` when layers and recovery are on (`routes.ts:6991-7033`); the artifact mentions only the record. Worth checking that nothing enumerating `context-layers/*` treats `press-*` as a topic, and that these directories are cleaned up. The route's press check also omits `isProtected`, unlike the canary scope.
7. A heal staged before a restart resumes under `resumeStagedFallbacks` on the recovery switch alone (`CompactionSentinel.ts:685-709`), so "turn the sentinel off and restart: nothing heals" has a window of up to the 5-minute idle bound.
8. `deliveredFallback` and `consumedSeedAt` are in memory only. If the marker write fails and the server restarts, the same epoch can be re-injected once more (bounded by the episode).
9. Until the CompactionSentinel is built later in boot, `reinject` returns `unsupported`, which spends an attempt and a daily run (`contextBudgetSentinelBoot.ts:326-327`).
10. The press episode is keyed on the UTC day (`syntheticPress.ts:161`), so presses either side of midnight can be under an hour apart and reach 6 in 24 h; the governor's 3 per window is the real bound.
11. Record-only causes never restart the epoch, so one `session-gone` or `post-compact-missing` divergence leaves the machine `diverged` with no notice until some remediation completes or the switch toggles.
12. An unreadable `canary-heal.json` starts over (`canaryHealLadder.ts:255`): the per-session cap and breaker counts reset, with only the gate's episode store still holding.
13. No test covers two sessions diverged at once (finding 2), a second exhaustion (finding 3), or the real `reseedText` (finding 1).

**Checked and sound**

- Idle gate: `healReinject` goes only through `tickFallback` (not working, no other pending inject, ready prompt, re-checked each tick inside the bound); no bare inject on the heal path; `unsupported` returns before anything is typed.
- A server marker stands down only its own epoch, by exact boundary id and never by timing; the test for a newer compaction 20 s later is real.
- Press targets: channel binding is checked first and fails closed on an adapter throw; the prefix, job, engine and protection checks are re-run at action time, with an idle check.
- Switches: heal and press are built only inside `contextBudget.sentinel.enabled` and `contextLayersEnabled`, and ticked only with compaction recovery on; pool-live ownership reads `unknown` and the gate refuses before opening an episode.
- The stated deviations (rung 1 does not re-seed, third attempt unreachable, latency notices audited) are accurate.

### Round 2 (second-pass reviewer)

**Independent read of the artifact: concur**

Resolution checked against the code, not the response text. Re-ran `tests/unit/canary-heal-ladder.test.ts` (18), `tests/unit/heal-reseed-text.test.ts` (2), `tests/unit/CompactionSentinel-heal-reinject.test.ts` (10) and `tests/integration/context-budget-canary-heal.test.ts` (4, under the integration config): all pass. The unrelated ratchet fixes from earlier slices were not reviewed.

- **Blocks-now 1: resolved.** `server.ts:13431` calls `healReseedText`, which uses `prepareHealInjectionText` (`compactionResumePayload.ts:151-168`); its stub carries only the heal instructions and the file is 0600. The integration rig now drives the real function.
- **Major 2: resolved.** A heal sets `restartPending`; the epoch restarts only when every current divergence is terminal (`canaryHealLadder.ts`, end of `tick`). The loop no longer breaks after a heal.
- **Major 3: resolved.** Exhaustion notices are deduped per cause per 24 h (`onGateNotice`, `exhaustedRaisedAt`); the per-session cap is checked before the gate, so no episode opens.
- **Major 4: stated**, with a tracking marker (summary item 4). **Major 5: stated** (Gating, Rollback).
- **Minors 6, 7, 9: resolved** (`routes.ts` protection check and no archive/chunk for a press target; `isHealEnabled` at `CompactionSentinel.ts:694`, set at `server.ts:13449` before the sentinel is built; the `ready` dep). Minors 8, 10, 11, 12 are stated.

Residual, none blocking:

1. A detection still inside its 10-minute artifact grace when the epoch restarts falls out of the epoch; if it later settles without its artifacts it is never served. Narrow window; worth a line under Under-block.
2. A `capped` or `governed` row is non-terminal, so one such session holds the epoch restart (and the canary at `diverged`) for up to 24 h. Safe direction.
3. The exhaustion dedupe reads the cause from the in-attempt context. A notice raised from a queued admission (outside `tick`) has no cause and is not deduped; it fails toward notifying.
4. `mkdirSync(..., { mode: 0o700 })` does not tighten `/tmp/instar-compaction-resume` if the resume path created it first with a wider mode; the heal file itself is 0600. Each attempt writes a new file (bounded by the attempt brakes) and nothing removes them.

## Evidence pointers

Commands run (2026-11-10, this worktree, `TMPDIR=/home/echo/echo-test-tmp`, umask 022):
- `tsc --noEmit` (typescript-native): clean.
- Unit, new + touched: `canary-heal-ladder` (19), `synthetic-press` (9), `context-epoch` (5), `CompactionSentinel-heal-reinject` (10), `heal-reseed-text` (2) — all pass.
- Neighbour unit set (every `tests/unit` file matching the changed basenames, 1,468 files, `--maxWorkers=2`): 1 failure, `builtin-manifest` (a stale local gitignored artifact; regenerated with `scripts/generate-builtin-manifest.cjs`, then 10/10 pass); 33,962 others pass.
- Integration (`--config vitest.integration.config.ts`, the 11 context-budget/compaction/layer files incl. the new one): 30/30.
- E2E (`--config vitest.e2e.config.ts`, the 18 context-budget/compaction/layer files incl. the new one): 88/88 after fixing two (the new e2e's settings fixture; the lifecycle WIRED window).
- `node scripts/docs-coverage.mjs --check`: passed (routes 55%).

Also fixed here, from earlier slices in this unmerged stack (found by the neighbour run, red at HEAD a44878764 too): `@silent-fallback-ok` tags on the fitter template's two catches (`PostUpdateMigrator.ts`) and a TokenLedger close; keyword-intent allowlist entries for `chunkBuilder.ts` (a trigger enum) and `standingPacket.ts` (checks over Instar's own rendered packet); `topicRef` in `standingPacketBoot.ts`; `operatorError` in the standing-packet route's 500.

- Unit: `tests/unit/context-epoch.test.ts`, `tests/unit/canary-heal-ladder.test.ts`, `tests/unit/synthetic-press.test.ts`, `tests/unit/CompactionSentinel-heal-reinject.test.ts`.
- Integration: `tests/integration/context-budget-canary-heal.test.ts`.
- E2E: `tests/e2e/context-budget-heal-ladder-alive.test.ts`; updated `tests/e2e/context-budget-canary-alive.test.ts` WIRED strings.

## Class-Closure Declaration (display-only mirror)

Class `unbounded-self-action`, closure `guard`: both new controllers (`context-budget-canary-heal`, `context-budget-synthetic-press`) are registered in `src/testing/selfActionRegistry.ts` and proven to settle by `tests/unit/self-action-convergence.test.ts` (ratchet).

### Author response (round 1)

- Blocks-now 1 (heal text replaced by the resume stub): fixed. `healReseedText` (boot module, used by `server.ts`) files a large payload under a HEAL stub (`prepareHealInjectionText`, 0600). Test: `tests/unit/heal-reseed-text.test.ts` (no "FIRST sentence" / "answer the MOST RECENT" in the typed text; the file holds the heal preamble); the integration rig now uses the real `healReseedText`.
- Major 2 (a heal's epoch restart drops other divergences): fixed. `restartPending` restarts the epoch only once every divergence in it is terminal-handled. Test: "two sessions diverged at once".
- Major 3 (exhaustion notices unbounded; capped sessions page): fixed. Exhaustion notices at most one per cause per 24 h; the per-session cap is checked before the gate so no episode opens. Tests: "a second same-cause exhaustion…", "a capped session opens no episode…".
- Major 4 (no `cb-press-` session is created): stated in the summary as a tracked gap.
- Major 5 (server marker outside the dev gates): artifact corrected (Gating, Rollback).
- Minor 6: press-target PostCompact now checks protection and skips the span archive/chunk. Minor 7: staged heals resume only when the ladder is wired this boot (`isHealEnabled`; test added). Minor 9: `ready` dep, the ladder waits until the CompactionSentinel exists (test added). Minors 8, 10, 11, 12: stated under Under-block.


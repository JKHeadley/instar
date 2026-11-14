# Side-Effects Review — Codex compaction detection and post-compaction producer (Phase 1 S16)

**Version / slug:** `cb-codex-detect`
**Date:** `2026-11-10`
**Author:** `Echo (builder session)`
**Second-pass reviewer:** `Fable reviewer subagent (see below)`

## Summary of the change

Phase 1 slice S16 of `docs/specs/context-budget-layered-summaries.md` (§9.6 Codex column, §9.1 canary, §16 Phase 1 Codex bullet). **Evidence for plan item A1 came first.** Read-only measurement of this machine's Codex rollouts (structure and counts only, no content): event-type census over 207 recent large rollouts plus a 606-file sample across `~/.codex` and the `~/.codex-followme-*` homes, Codex CLI 0.156.1 / 0.166.0 / 0.167.0. **Codex writes an engine-native `compacted` entry** (95 in 66 of 207 recent files; 173 in the wider sample). Every entry had a `window_id` and an empty `message`. Fork copies: a forked subagent rollout (`session_meta.forked_from_id`) copies its parent's `compacted` entries before its first `token_count`. That held for 11 of 11 pre-usage entries, and 0 such entries appeared in root rollouts; in the 606-file sample the only duplicate `window_id`s were these copies. The usage reading just before a compaction was 84–95% of `model_context_window` (258,400 for every pair, 162 pairs). **Under §9.1, A1 resolves to "an engine-written entry exists"**: detection is a transcript-channel detection (`supported`), and the token_count-drop detector (and its switch, which would have needed the operator's yes) is **not built**.

Built:
- `src/monitoring/CodexRolloutParser.ts`: `classifyCodexRolloutEntry` and `codexRolloutLineMayMatter` (the rollout parser change).
- `src/providers/adapters/openai-codex/control/compactionLifecycle.ts`: `trackContextUsage` takes the engine-reported window and returns whether it fired. New `emitPostCompactFromTranscript` is the first producer for `postCompactEmitter`. It sends `summary: null` and re-arms the pre-compact notice.
- `src/providers/primitives/control/compactionLifecycle.ts`: optional `summary` on `PostCompactNotice`.
- `src/monitoring/compactionCanary.ts`: per-engine `EngineCanaryProfile`; a Codex branch of the transcript scan; signals; group `marking`/`profile`/`synthesizedSignals`; a new `counted` state.
- `src/monitoring/contextBudgetSentinelBoot.ts`: the Codex scope behind a gate, `codexHomeForTmuxSession`, and a bounded `makeCodexRolloutFinder`.
- `src/commands/server.ts`: the gate is `contextLayersEnabled` (resolveDevAgentGate on `contextBudget.enabled`, read live).
- Agent awareness: the CLAUDE.md template row, the `migrateClaudeMd` refresh and the CapabilityIndex description.

## Decision-point inventory

- Canary detection rule (`compactionCanary.scanTranscript`): **modify** — adds the Codex rule: `compacted` alone is a detection, after the rollout's first usage reading, deduped on `window_id`.
- Canary group state (`report`): **modify** — an engine whose profile says recovery is not verifiable reads `counted`, never `diverged` or `healthy`.
- Synthesized pre-compaction signal (`trackContextUsage`): **modify** — 85% of the reported or assumed window, once per cycle; it is a signal and never a detection.
- Canary scope (`productionCanarySessions`): **modify** — Codex topic sessions are added only while the dev gate resolves on.

---

## 1. Over-block

No block/allow surface. Over-block does not apply. Everything here observes and counts.

---

## 2. Under-block

No block/allow surface. Under-detection cases, stated plainly:
- A compaction during server downtime longer than `CHANNEL_FRESH_MS` (10 min) is counted, but the producer never announces it, by design (history is never announced as new).
- A forked rollout's own compaction that happens before its first usage reading would be missed. That cannot occur in practice: a compaction needs model calls, and model calls write `token_count`.
- A Codex version that renames `compacted` or `window_id` reads as zero detections (`uninitialized`), not as an error. The adapter verification suite (S17) is the drift check.
- Codex sessions older than 7 days whose rollout is outside the recent-day window are found by the full walk, at most once an hour per session.

---

## 3. Level-of-abstraction fit

The rollout parsing lives with the existing Codex rollout parser (`CodexRolloutParser.ts`). The threshold and the emitters stay in the adapter (`compactionLifecycle.ts`), which owns them. The canary is the one transcript-channel reader (§9.1) and drives the adapter through an injectable `CanaryEngineHooks` seam. It defaults to the adapter's real functions, so no caller can leave the hooks unwired. The canary's engine-specific knowledge is a profile table plus one branch. A further engine adds a profile and a branch. No second rollout scanner was introduced.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The canary only records. The `counted` state and `healByInjection: false` actually remove a future heal path from Codex: the profile states that no injection-based heal may target this engine (§9.1, "synthesized ⇒ counted, never healed by injection").

---

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Each threshold is an engine invariant, measured above. The 85% ratio is the spec's existing synthesized-signal constant. The fork guard is an invariant of how Codex builds rollouts (an inherited prefix has no usage reading). The 10-minute fresh window bounds announcement only and never affects counting.

---

## 5. Interactions

- **Shadowing:** the Claude Code scan path is unchanged; the Codex branch returns before it. PostCompact record matching now skips detections from unverifiable engines, so a Codex detection never claims a Claude record.
- **Double-fire:** `trackContextUsage` has an in-process once-per-session guard. The canary adds a durable `armed` flag per transcript, so a restart does not re-signal the same cycle. The producer fires once per `window_id`, because detections are deduped.
- **Races:** the canary ledger is written by one process per machine, the sentinel's tick, with tmp-then-rename. Unchanged.
- **Feedback loops:** none. Nothing subscribes to the Codex notices in production yet. The S17 next-prompt seed is the intended consumer.

---

## 6. External surfaces

- `GET /context-budget/sentinel`: canary groups gain `marking`, `profile` and `synthesizedSignals` (additive). A Codex group can read `counted`, a new value of the state enum. The only readers are the route and agents reading it, and the CLAUDE.md row and CapabilityIndex now describe it.
- CLAUDE.md: the template row names `counted`. Existing agents get an idempotent `migrateClaudeMd` refresh, sniffed on the old row's closing words.
- Persistent state: `state/context-budget/canary.json` gains `channel` and `signals` (bounded, optional, and back-filled on load).
- Rollouts are read-only. Each tick runs one `tmux show-environment CODEX_HOME` per Codex topic session (2 s timeout).
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture

**Machine-local by design.** A compaction happens in a process on one machine, and that machine's rollout records it. The canary groups by `(machine, engine, version)`, as the Claude path already does. No notices are emitted, and the canary ledger does not strand on a topic transfer: the new owner's canary sees the session's future rollout lines. Status surface: `GET /context-budget/sentinel` reports this machine only, as before, and each group names its machine.

---

## 8. Rollback cost

Pure code change; revert and ship a patch. The added ledger fields are ignored by older code (unknown JSON fields). The `counted` sentence in CLAUDE.md would be left behind (harmless text). The live kill switch is `contextBudget.enabled: false`, read live per tick: on the next tick the canary drops every known Codex transcript, so scanning and the side-channels stop (fixed after the second pass, M1).

---

## Conclusion

The review found A1 answered by evidence, so the build follows the "entry present" branch: a transcript-channel detection, with no drop detector and no switch needing the operator. Two design choices came from the measurement: the fork-prefix guard and the `window_id` dedupe, because forked rollouts replay parent compactions with fresh timestamps; and the reported window, because 85% of an assumed 200K would fire at about 66% of the real 258,400 window. Known gaps for later slices:
- The Codex row reads `counted` until S17's seed delivery gives a verifiable recovery artifact.
- The detection and producer run only where the context-budget sentinel runs (`contextBudget.sentinel.enabled`, dark by default). S17's seed needs that either moved or turned on.
- `productionSentinelSessionDeps.candidates` still resolves Codex transcripts with the full walk; that is untouched and out of scope.

---

## Second-pass review (if required)

**Reviewer:** Fable second-pass reviewer
**Independent read of the artifact: concern** (one narrow major, M1; everything else concurs)

Read independently: spec §9.1, §9.6, §16; the full source and test diff; and a read-only structure probe of my own over 40 real rollouts (43 `compacted` entries).

Confirmed:
- **A1 evidence holds.** Codex writes a top-level `compacted` entry. In my sample every `window_id` was a 36-character UUID (43 of 43), none repeated across files, and the first usage reading after a compaction was below 85% of the window in 43 of 43, so the re-armed signal does not fire falsely right after a compaction. Three post-usage compactions sat in forked rollouts, which the fork guard counts correctly. Building transcript-channel detection and no drop detector is the right reading of §9.1 ("the engine-written entry alone is a detection").
- **Claude path unchanged.** The Codex branch returns before the Claude loop (`compactionCanary.ts:289`). The PostCompact skip (`:256`) cannot affect a `claude-code` detection. The ledger back-fill on load is additive and older code ignores the new fields.
- **Dev gate wiring** is `resolveDevAgentGate` through `contextLayersEnabled`, read live (`server.ts:13394`), framework-discriminated in `productionCanarySessions` (`contextBudgetSentinelBoot.ts:139`). A gate that was never on gives exactly the prior scope.
- **Agent Awareness / Migration Parity**: template row, idempotent `migrateClaudeMd` refresh (tested twice-run) and CapabilityIndex are all present. No other copy of the row exists in `src/`.
- **`counted` is an honest reading.** §9.6 gives Codex no post-compaction hook, no summary and no compaction seed, so the literal §9.1 states would report a permanent false `diverged`. The spec itself uses "counted ... never healed by injection" for this engine. See m4 for the paper trail it still needs.

Findings:
- **M1 (major) — turning the gate off does not stop Codex scanning for up to 24 hours.** `scan()` iterates every transcript in the ledger's `known` map (`compactionCanary.ts:244`), not just this tick's sessions. A Codex rollout seen while the gate was on keeps being scanned, keeps recording detections and keeps firing `trackContextUsage` and the post-compaction producer until `KNOWN_IDLE_MS` (24 h) expires. Section 8 above ("takes Codex out of the canary's scope immediately") and the release note's "With the gate off the canary's scope is exactly Claude Code's" are true only for a gate that was never on. Harm is low today (observation only, no production subscriber), but S17 adds a subscriber and this is the stated kill switch. Fix: have `scan` skip or drop known entries whose engine is out of scope this tick, and add an on-then-off test; or, at minimum, correct both sentences.
- **m1 (minor) — a historical detection re-arms the durable flag but not the adapter's in-process guard.** `st.armed = true` (`compactionCanary.ts:365`) runs before the freshness check, while `lastNoticeBySession.delete` (`openai-codex/control/compactionLifecycle.ts:79`) runs only through `onCompaction`, which historical detections skip. After a scan gap over 10 minutes without a restart (a stalled tick under load), the next cycle's signal is silently dropped. It self-heals at the next fresh compaction.
- **m2 (minor) — a Codex-only epoch hides the Claude row.** The default `claude-code` `uninitialized` row is emitted only when there are no groups at all (`compactionCanary.ts:410`). Once a Codex group exists and Claude has no detections, the report shows only `counted`.
- **m3 (minor) — one synchronous tmux call per Codex topic session per tick, never cached** (`contextBudgetSentinelBoot.ts:142`, `:72`; 2 s timeout each on the server's event loop). The rollout cache is keyed on the home, so the lookup repeats even when the path is already known. Cache the home per tmux session.
- **m4 (minor) — `counted` is not in §9.1's state set** (neither is the pre-existing `accruing`). Record it in the spec. Nothing structural forces S17 to flip `recoveryVerifiable`; if it is forgotten Codex stays unjudged forever. Also `marking: "synthesized"` beside `detection: "supported"` is only explained by the profile; the CLAUDE.md row does not say what the marking covers.
- **m5 (minor) — version is pinned to the first `session_meta`** (`compactionCanary.ts:342`), so a session resumed under a newer Codex is grouped under the old version. A truncated rollout (`:277`) re-reads from zero without resetting the channel state; negligible.
- **m6 (minor) — test gaps.** No gate on-then-off case (M1). No `token_count` with `info: null`. The "historical compaction is counted" test (`tests/unit/codex-compaction-channel.test.ts:169`) asserts only that nothing is announced, not that it was counted. The e2e "WIRED" case (`tests/e2e/context-budget-codex-canary-alive.test.ts:112`) is a source-string match. Otherwise the three tiers cover both sides of each boundary.
- **m7 (note for S17) — the 85% signal has little lead.** The artifact's own measurement puts compactions at 84–95% of the window (`compactionLifecycle.ts:39`), so some cycles compact with no signal and the rest get it at most a few turns ahead. It is the spec's constant; S17 should not rely on it as an early warning.

Not blocking: none of these is blocks-now. M1 should be fixed or the two sentences corrected before merge; the minors can queue.

**Builder response (round 1):**
- M1, fixed. `CompactionCanary` takes `engineInScope`, read each tick. An out-of-scope engine's known transcripts are dropped at once, along with their offsets, open boundaries and channel state, so turning the gate off stops scanning and side-channels on the next tick. Production passes the same live gate (`codexCanaryOn`) to both the scope and the canary. Tested in the unit test "gate on, then OFF…", which also covers turning it back on.
- m1, fixed. A historical detection calls the new `onRearm` hook, which runs the adapter's `rearmContextUsage`, so the in-process guard and the durable flag both re-arm. Tested.
- m2, fixed. The Claude Code row is always present. Tested.
- m3, fixed. The CODEX_HOME read is cached per tmux session (bounded at 500). Tested ("reads a session's CODEX_HOME once").
- m5, fixed. The version follows the latest `session_meta`, and a truncated rollout resets its channel state.
- m6, fixed. Added the on-then-off, `info: null` and historical-counted tests. The WIRED e2e case stays a source match, as the existing canary e2e does; the behaviour is exercised by the e2e production-path run.
- m4, queued for S17. Recording `counted` in §9.1 and flipping `recoveryVerifiable` belong to S17's seed delivery, which produces the artifact. This slice does not edit the approved spec.
- m7, noted for S17.

**Round 2: concur** (Fable second-pass reviewer; resolution-checked against the code, tests not run by me)
- M1 resolved: `scan()` reads `engineInScope` once per engine per tick and drops an out-of-scope engine's known transcripts with their offsets, open boundaries and channel state (`src/monitoring/compactionCanary.ts:257-261`); `server.ts` passes the same live `codexCanaryOn` to the canary and to the scope. Section 8's "immediately" now holds to within one tick.
- m1, m2, m6 resolved as described (`onRearm` → `rearmContextUsage`; the Claude row is always appended; on-then-off, `info: null` and historical-counted tests are present). m4 and m7 are correctly queued for S17.
- New, minor (r2-a): the CODEX_HOME cache is keyed on the tmux session name alone and also caches the fallback (`src/monitoring/contextBudgetSentinelBoot.ts:136-144`). A tmux read that fails once pins `~/.codex` for that name for the life of the server, and a topic session respawned under the same tmux name on a different account home keeps the old home, so its rollout is searched in the wrong root and the session silently drops out of the canary. Key it on tmux name plus session id, and do not cache when `homeForSession` returned nothing.
- New, minor (r2-b): "latest meta wins" (`src/monitoring/compactionCanary.ts:358`) picks the PARENT's version in a forked rollout when the inherited prefix carries the parent's `session_meta` after the fork's own (the shape the fork unit test itself uses). First meta until the first usage reading, latest after it, serves both the fork and the resume case. Grouping only.
- Neither blocks; both can ride this slice or queue.

**Builder response (round 2):**
- r2-a, fixed. The CODEX_HOME cache is keyed on the tmux name plus the session id, and only a real tmux answer is cached; a failed read is retried next tick. Tested.
- r2-b, fixed. The version comes from the first `session_meta` until the first usage reading, then from the latest. The fork test now gives the inherited meta a different version and asserts the fork's own.

**Round 3: concur** (Fable second-pass reviewer; resolution-checked against the code, tests not run by me)
- r2-a resolved: the cache key is tmux name plus session id and only a real tmux answer is stored (`src/monitoring/contextBudgetSentinelBoot.ts:137-146`). Residual, accepted: a session whose `CODEX_HOME` is genuinely unset is re-read every tick (one tmux call each), since "unset" and "failed" both return nothing.
- r2-b resolved: first meta until the first usage reading, latest after (`src/monitoring/compactionCanary.ts:359`); the fork test asserts it. The own-meta-first ordering in a fork's prefix is assumed, not measured; S17's suite should confirm it. Grouping only.
- The updated WIRED assertions in `tests/e2e/context-budget-canary-alive.test.ts` match `src/commands/server.ts:13390-13391`.

---

## Evidence pointers

- Rollout census (structure and counts only, via read-only scripts over `~/.codex*/sessions`): `compacted` entries 95/66 files of 207 recent rollouts; 173 in the 606-file sample; `message` empty 95/95; `window_id` present 173/173; pre-usage entries 11, all in forked rollouts; usage before compaction at 84–95% of a 258,400 window (162 pairs).
- Test runs (all `--maxWorkers=1`, behind the load gate, after the final source edit): tsc clean. Unit: 5 files, 350 tests passed (codex-compaction-channel 25, compaction-canary 21, migrate-context-budget-sentinel-row 3, ContextBudgetSentinel 32, feature-delivery-completeness 269). Integration: context-budget-sentinel-route, 5 passed. E2E: context-budget-codex-canary-alive 3, context-budget-canary-alive 2, adapter-suite-lifecycle 2 and context-budget-sentinel-lifecycle 3, 10 passed. The first e2e run caught a stale WIRED string in context-budget-canary-alive (the `productionCanarySessions` call is now multi-line); it was fixed and re-run green. Neighbours: CodexRolloutParser 8, TokenLedger-codex 10, dev-preflight 4, context-layer-kind 15, initiative-discoverability 2, and integration tokens-codex-routes 3, all passed.
- Tests: `tests/unit/codex-compaction-channel.test.ts`, `tests/unit/compaction-canary.test.ts`, `tests/unit/migrate-context-budget-sentinel-row.test.ts`, `tests/integration/context-budget-sentinel-route.test.ts`, `tests/e2e/context-budget-codex-canary-alive.test.ts`, `tests/e2e/context-budget-canary-alive.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed, so this does not apply. The canary is a self-triggered observer, but it fires no restart, swap, spawn, notify, retry or kill. Its only new side effect is an in-process event emission with no production subscriber, so it is not in the `unbounded-self-action` class.

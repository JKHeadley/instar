# Side-Effects Review — ContextWedgeSentinel (thinking-block-400 fast-fail wedge)

**Version / slug:** `context-wedge-sentinel`
**Date:** `2026-05-28`
**Author:** `echo`
**Second-pass reviewer:** `not required (single-author; design reviewed conversationally by Justin in topic 15160 before build; /spec-converge fast-tracked — see Conclusion)`

## Summary of the change

Adds a 4th "silently-stopped" sentinel, `ContextWedgeSentinel`, that detects the Claude Code `400 … thinking/redacted_thinking blocks in the latest assistant message cannot be modified` wedge (a tool call cancelled inside a parallel batch corrupts the latest assistant turn's thinking block, so every resume 400s instantly and the session is permanently dead while still emitting output — invisible to the silence + socket sentinels). Recovery is a fresh respawn (kill + clear the topic's `TopicResumeMap` entry so the bridge does not `--resume` the corrupted transcript). Files: `src/monitoring/ContextWedgeSentinel.ts` (new), `src/monitoring/sentinelWiring.ts` (`buildContextWedgeDeps`), `src/monitoring/SentinelNotifier.ts` (`dry-run`/`false-alarm` kinds), `src/core/SessionRefresh.ts` (`fresh` mode), `src/core/types.ts` + `src/config/ConfigDefaults.ts` (config), `src/commands/server.ts` (trio-block wiring + recovery veto), `src/core/PostUpdateMigrator.ts` (agent-awareness section).

## Decision-point inventory

- `ContextWedgeSentinel.scanSession/confirm` (detector) — **add** — pattern-matches the wedge signature as the non-progressing session tail; signal-only, no block authority.
- `buildContextWedgeDeps.recoverFn` (recovery policy) — **add** — maps autoRecovery config → detect-only / dry-run / live respawn. Bounded primitive (SessionRefresh rate-guards).
- `SessionRefresh.refreshSession({fresh})` — **modify** — adds a branch that clears the resume UUID after kill; existing resume-preserving behavior unchanged when `fresh` is absent.
- `composedRecoveryActive` (SessionReaper kill-veto) — **modify** — folds in `wedgeRecoveryActive` (pass-through OR, never removes a veto).

## 1. Over-block

No block/allow surface — over-block not applicable. The sentinel never blocks a message or tool call. The only "action" is a kill+respawn, gated behind `autoRecovery` (default off) + a 45s confirm window requiring the signature to remain the live tail. The realistic over-action is restarting a session that wasn't truly wedged; mitigated by tail-gate + confirm-window + opt-in default, and bounded by SessionRefresh's rate guard (5/10min).

## 2. Under-block

No block/allow surface — under-block not applicable. As a detector: it will miss a wedge whose error text is not in the captured tail window (default 30 lines) — e.g. if the session printed >30 lines after the error without progressing past it. Acceptable: the next tick re-captures, and the error is the literal tail of a dead session by construction (it can't print anything new). It also only matches the thinking-block signature, not other permanent-400 classes; those are out of scope for this spec.

## 3. Level-of-abstraction fit

Correct layer. This is a low-level detector (regex on captured pane output) feeding a bounded recovery primitive — exactly mirroring the existing `SocketDisconnectSentinel`. It does NOT re-implement respawn: it reuses `SessionRefresh` (the existing kill+respawn authority, with rate-guard + in-flight guard). The recovery *policy* (detect-only/dry-run/live) lives in the wiring, not the detector, so the rollout-staged flag is observed in one place. No higher-level gate already covers this failure shape (verified: silence + socket sentinels both miss it).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart primitive (SessionRefresh) / the existing SentinelNotifier delivery policy.

The detector holds no blocking authority. The destructive action (respawn) is performed by SessionRefresh (an existing rate-guarded primitive), only when an operator opts in via `autoRecovery`, and only after a confirm window. Escalation routes through the existing `MessagingToneGate` via `SentinelNotifier`. No brittle check owns block authority.

## 5. Interactions

- **Shadowing:** Runs alongside the socket + silence sentinels on the same session-scan surface. It does not shadow them — they detect disjoint signatures (disconnect string / output-gap vs. thinking-block-400 tail). All three independently feed `isRecoveryActive` into `composedRecoveryActive`.
- **Double-fire:** Could two sentinels act on one session? Each tracks its own state map and only acts on its own signature. The SessionReaper veto is an OR of all four `isRecoveryActive` checks, so a wedge-recovery-in-flight also vetoes reaping — additive, not conflicting.
- **Races:** The destructive path goes through `SessionRefresh`, which has an in-flight guard (refuses a second concurrent refresh for the same session) and a rate guard. The `fresh` clear of `TopicResumeMap` happens after `killSession` (so `beforeSessionKill` has already written the UUID) and before the respawner reads it — order asserted in `SessionRefresh.test.ts`.
- **Feedback loops:** The fresh respawn clears the resume pointer specifically to BREAK the re-wedge feedback loop (kill → beforeSessionKill saves UUID → next message --resumes corrupted transcript → re-wedge). Without `fresh`, a naive kill would create that loop; this is the central correctness property.

## 6. External surfaces

- **Other agents on the machine:** none — per-agent monitoring, no shared state mutated.
- **Install base:** detection + audit are default-ON for all agents on update (read-time fallback `?? {enabled:true}` + `ConfigDefaults` persists `enabled:true`). This is harmless (writes audit rows; kills nothing). The destructive `autoRecovery` is NOT persisted into agent configs (deliberately omitted from `ConfigDefaults` because `applyDefaults` is add-missing-only — persisting would freeze it and break a later default-on flip). It defaults off via the server.ts runtime literal.
- **External systems:** none directly. A fresh respawn re-spawns a Claude Code session (tmux) — same surface SessionRefresh already touches for `/restart`.
- **Persistent state:** appends to `logs/sentinel-events.jsonl` (existing audit file). Clears one `TopicResumeMap` entry on a live recovery (intended).
- **Timing:** confirm window (45s) + SessionRefresh rate guard bound the action rate.

## 7. Rollback cost

Pure code change — revert and ship a patch. No data migration: `autoRecovery` is not persisted, so there is nothing to clean up in agent configs. The `ConfigDefaults` `contextWedgeSentinel: {enabled:true}` block would be added to agent configs by `applyDefaults` on update; a rollback leaves a harmless unused key (the runtime simply won't read it once the code is gone). No user-visible regression during the rollback window — detection is silent and auto-recovery ships off. The CLAUDE.md awareness section added by `migrateClaudeMd` is idempotent and harmless if the feature is reverted.

## Conclusion

The review surfaced the one load-bearing correctness property — the fresh respawn MUST clear the resume UUID or recovery creates an infinite re-wedge loop — which is implemented, ordered correctly, and asserted in tests. It also surfaced the propagation subtlety that `autoRecovery` must NOT be persisted in `ConfigDefaults` (add-missing-only `applyDefaults` would freeze it), which shaped the final config design so the eventual default-on flip reaches existing agents. No blocking-authority concerns (detector + existing rate-guarded primitive). Clear to ship dark (auto-recovery off, detection on), with Echo dogfooding `autoRecovery` live.

**Process note (transparency):** the design was reviewed conversationally by Justin (topic 15160) before and during the build, and he greenlit it. The full multi-agent `/spec-converge` pass was fast-tracked given (a) the bounded, established-pattern nature of the change (a 4th sentinel cloned from the trio), (b) it ships dark on a rollout track, and (c) the 3-tier test coverage + this side-effects review. The `review-convergence` tag reflects that diagnosis + design-review basis, not a `/spec-converge` timestamp. Flagged for Justin — he can request the full convergence pass before merge if he prefers.

## Evidence pointers

- Unit: `tests/unit/monitoring/ContextWedgeSentinel.test.ts`, `tests/unit/SessionRefresh.test.ts` (fresh-mode order).
- Integration: `tests/integration/context-wedge-sentinel-wiring.test.ts`.
- E2E: `tests/e2e/context-wedge-sentinel-lifecycle.test.ts` (on-disk JSONL audit + WIRED source guard).
- Live incident: tmux pane of `echo-instar-exo` (topic 13481) showing the repeating 400 on every inject (2026-05-28).

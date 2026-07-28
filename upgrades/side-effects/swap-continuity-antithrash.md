# Side-Effects Review — swap-continuity anti-thrash brakes + in-flight work deferral

Spec: `docs/specs/swap-continuity-antithrash.md` (converged round 6, approved).
Roadmap: Session A item 4.4 + operator-priority thrash brake (2026-07-02 incident).

## What changes at runtime

1. **New durable state file**: `state/swap-ledger.jsonl` (single writer:
   `SwapLedger`; O(1) segment rotation, 10 MB × keep 2). Absence = cold start
   (dwell un-primed for the first 45 min — the §9 accepted one-time gap).
2. **Proactive swap decisions** (only when `subscriptionPool.proactiveSwap.enabled`
   is already opted into — fleet-dark today):
   - antiThrash resolves `enabled:true, dryRun:true` when the block is absent →
     the ONLY immediate effect on an opted-in install is dry-run ledger rows +
     status counters (rung-1 honesty, §10). Decision behavior stays
     byte-identical to v1.3.722 until a deliberate `dryRun:false`.
   - Live (`dryRun:false`): untagged sessions leave the proactive candidate set
     (I10); refusals (all-hot / dwell / no-material-target / target-unmeasured /
     reversal / thrash-breaker / ledger-lost) bind; the executed target is the
     brake-checked target (I1) with execute-time revalidation.
3. **Reactive path**: decision behavior byte-identical (I6). Additive
   observation only — reactive swaps write ledger rows; execution failures
   (previously a silently-discarded promise) write `failed` rows and can raise
   ONE deduped attention item per streak/hop-cascade/rate-cap-strand.
4. **Session-killing mutations** (`SessionRefresh.refreshSession`): a work gate
   consults in-flight state when `swapContinuity` resolves live (dev-agent gate
   — key OMITTED from shipped config, dark on fleet). Caller classes:
   proactive-swap defers; reactive-swap gets a bounded grace (≤120 s) then
   proceeds WITH mitigations; interactive-refresh (the default for every
   unlisted caller) gets a structured `session-busy` refusal + `force`;
   recovery is exempt. Forced kills carry the F3 mitigation payload
   (enumerated killed subagents + re-injected unanswered inbound, quoted-data
   envelope).
5. **HTTP surface**: `/subscription-pool/proactive-swap` gains additive
   `brakes`/`deferrals` blocks; `/sessions/refresh` gains a pre-202 409
   `session-busy` refusal + optional `force:true` (bearer-level, recorded as
   such). No route renamed; nothing 503s that didn't.
6. **Attention items**: one per thrash episode / failure streak /
   measurement-blind episode / ledger-loss episode — episode-deduped (P17),
   restart-proof via episodeId derivation from the ledger.

## Failure directions (the load-bearing ones)

- Ledger UNWRITABLE ⇒ proactive optimization PAUSES (`ledger-lost`,
  counter-only), level-triggered resume + one `outage-summary` row; reactive
  untouched (I12).
- Quota reading ABSENT/STALE ⇒ NOT under the ceiling; counts toward all-hot;
  never treated as 0% (bound 0, R4-M1). Whole-pool blindness pauses the
  optimizer AND says so (I13).
- Work-gate uncertainty ⇒ BUSY for optimization callers ('absent' behaves like
  'indeterminate', R5-M1), busy-for-grace for reactive (never strands — the
  grace deadline always proceeds).

## Rollback levers

- `antiThrash.dryRun:true` restores v1.3.722 decision behavior (keeps
  observability). `antiThrash.enabled:false` disables the engine's binding
  entirely (legacy path incl. legacy 10-min cooldown).
- Removing the dev agent's `swapContinuity` enablement un-wires the gate
  (SessionRefresh reverts to unconditional kill). `subagentIdleLeg` stays a
  concrete `false` default on the model-swap block (rung 3a flip only).
- Deleting `state/swap-ledger.jsonl` = cold start (bounded, logged, §9).

## Blast radius

Machine-local by design (§8): per-machine ledger, per-machine breaker, no
cross-machine state. No egress, no spend, no credential surface. The only
processes touched are the agent's own tmux sessions, and only through the
pre-existing SessionRefresh funnel with strictly ADDED protection.

## Wiring completion (second commit of this build)

The core modules landed first (2866f1073); the wiring commit binds them:
server.ts spine (unconditional ledger+engine hydration, live-knob getters,
scheduler/monitor/SessionRefresh hooks), the SessionManager tri-state work
probe (shared ps snapshot), the /sessions/refresh pre-202 409 + force,
the AgentServer ModelSwapService subagent-leg probe (Q5 dark micro-flag),
DEV_GATED_FEATURES + guard-manifest registration, CLAUDE.md template +
PostUpdateMigrator awareness, and the release-note fragment. No new runtime
side effects beyond those reviewed above — this section records that the
dark/dry-run posture described above is now actually reachable end-to-end.

## CI-green follow-up (third commit of this build)

Scope: zero-runtime-behavior commit that turns the two red unit shards green.
(1) Two pre-existing tests asserted the PRE-brake `/sessions/refresh` call
shape (`refreshSession({ sessionName, followUpPrompt, reason, fresh })` and
the exact-args spy without `force`); both now assert the documented §4.5
shape (fresh forwarded, `force` pinned to a strict boolean, default false).
(2) The no-silent-fallbacks ratchet counted 503 vs baseline 491: a
base-vs-HEAD set-diff of the exact test heuristic showed the PR added 13
genuinely-new flagged catches (every other +entry is a symmetric line-shift
artifact — 59/59 commands/server.ts, 31/31 AgentServer.ts, 19/19 routes.ts,
7/7 SessionManager.ts, 5/5 PostUpdateMigrator.ts). All 13 are the feature's
DESIGNED fail-safes, each failing toward the safe direction: SwapWorkGate
probe legs → indeterminate reads BUSY (I7, defer — never a wrong kill);
SessionRefresh work-gate knob/probe/mitigation arms → gate-dark or refusal
(the gate is ADDITIVE, §4.5 — a broken gate must never block a refresh, and
mitigations never gate the respawn); ProactiveSwapMonitor safe-knob reads →
feature-dark (legacy behavior holds); SwapLedger append/hydrate → loud warn
+ I12 optimization pause + counted loss classes (R4-m1), partial hydration
surfaced via coveredWindow/corrupt. Each now carries an in-brace
`@silent-fallback-ok` justification; the heuristic count returns to 490
(≤ 491 baseline) — no baseline bump.

Side-effects review of THIS commit: over-block — none (comments + test
expectations only; no input is newly rejected). Under-block — none (no
detector logic changed). Abstraction fit — the tags are the ratchet's
designed exemption mechanism for reviewed fail-safes. Signal-vs-authority —
no authority added; the tagged catches remain signal-preserving fail-safes
(refusals/warns/counters are the loud surfaces). Interactions — none; the
tags are inert at runtime. External surfaces — none. Multi-machine — n/a
(no behavior change; feature posture unchanged, machine-local by design §8).
Rollback — revert the commit; nothing durable depends on it. Second-pass —
not required: although the touched files include gate/monitor modules, the
source diff is comment-only (verified: `git diff` shows no executable-line
changes in src/ beyond comment insertion) and the test diff asserts the
already-reviewed §4.5 behavior.

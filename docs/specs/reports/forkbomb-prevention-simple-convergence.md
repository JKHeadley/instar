# Convergence Report — Fork-Bomb Prevention (SIMPLE)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-5.5 external pass (via the agent's codex CLI) ran on this spec. It is the load-bearing
review of this convergence: it is what caught that the *predecessor* design was over-engineered, and
it validated the simplification (SERIOUS on the elaborate spec → MINOR on this one → consistency-clean
after the MINOR findings were applied). Gemini-2.5-pro also ran on the elaborate spec (SERIOUS,
concurring) and was attempted on the simple spec (degraded: timeout) — codex is the authoritative
external read here.

## ELI10 Overview

The agent crashed its computer by launching hundreds of AI subprocesses at once (a "fork bomb") until
memory ran out. This spec puts a permanent cap back: a host-wide limit on how many AI subprocesses
run at the same time (8), a lock so only one copy of each agent's server runs (the original crash had
three copies each flooding), and a rule that when the cap is full, requests wait briefly then take a
*safe* action (a safety check is held, not waved through; background work just slows down) — never an
endless in-memory waiting line. It deliberately leaves out the clever machinery an earlier draft had,
because two outside AI models said that draft was over-engineered and the simple, OS-aligned controls
are the robust fix.

## Original vs Converged

The original was a different *spec entirely* — `forkbomb-prevention.md`, 2,400 lines, 17 internal
review rounds, an elaborate in-process design (custom lane-aware semaphore, reserved interactive
slots, acquire-budget timeout math, per-gate typed-shed dispositions, free-memory hysteresis). The
internal Claude rounds refined *within* that frame and never questioned it. The cross-model pass
(GPT-5.5 + Gemini) returned **SERIOUS ISSUES** on the same frame-level critique: over-engineered,
the per-process cap is the wrong PRIMARY primitive for a host OOM, and the last internal "fix" had
reintroduced an unbounded-heap risk. The converged spec is the **simple replacement**: three sturdy,
OS-aligned primitives (host-wide counting semaphore + single-instance lock + bounded ingress), the
elaborate machinery explicitly out-of-scope. This is the spec-converge process working as intended —
the external reviewer caught a Claude-family blind spot (over-relying on LLM gates + over-building)
that 17 same-family rounds could not.

## Iteration Summary

| Iteration | Reviewers | Material findings | Changes |
|-----------|-----------|-------------------|---------|
| (predecessor, 17 rounds) | 6 internal Claude × rounds + cross-model | culminated in cross-model SERIOUS | superseded — pivot to simple design |
| Simple r1 | cross-model (codex) | 5 MINOR (semaphore terminology, compliant-processes honesty + ulimit, holder-SET crash-safe model, poll-retry-not-queue, deploy-handoff) | all applied |
| Simple r2 | cross-model (codex) | 3 MINOR consistency (token-bucket rename, ulimit-in-PR consistency, held-message-no-replay) | all applied |
| Simple r3 | lessons-aware (internal, non-skippable) | 3 must-fix (outbound CoherenceReviewer 4th fail-closed branch; P1 per-evaluate wrapper not build-time; emergency-stop deterministic exempt) + migrateConfig | all applied |
| Simple r4 | (converged) | 0 | none — all dimensions SOUND |

## Full Findings Catalog

**Cross-model (codex gpt-5.5), simple spec, applied:** P1 "token bucket" → counting semaphore
(occupancy not rate); "for compliant Instar processes" honesty + OS `ulimit` promoted into the PR;
holder-SET crash-safe model (count live holders, unique-id release, atomic temp+rename) instead of
decrement/increment math; poll-retry instead of an in-memory waiter queue (no per-waiter heap); deploy
-handoff grace + operator override on the single-instance lock; held message is terminal (not
re-injected into the replay loop).

**Lessons-aware (internal), simple spec, applied (all code-grounded):**
- HIGH — the outbound CoherenceReviewer path was NOT already fail-closed (`CoherenceGate._evaluate`
  returns `pass:true` on fail-open branches), so a capacity shed there would deliver un-reviewed.
  Added a fourth fail-CLOSED capacity-shed branch (`pass:false`); corrected the "only inbound change"
  wording to FOUR catch additions.
- MEDIUM — P1 made unambiguously a per-`evaluate()` wrapper provider (acquire around the spawn,
  factory is the install-point only), so the cap binds CoherenceGate's shared-instance ~10-reviewer
  fan-out (the primary incident driver).
- MEDIUM — emergency-stop deterministic keyword pre-check is exempt from the cap, so a "stop
  everything" halt is never gated on LLM spawn capacity.
- Minor — `intelligence.spawnCap.*` defaults added to `migrateConfig()` (Migration Parity).

**Dimensions confirmed SOUND (no finding):** Structure-beats-Willpower (cap enforced by lint + funnel,
unconditionally ON); never-ship-a-safety-floor-dark (plain `?? default`, not the dev-agent gate);
heuristic-fallback-last-resort / prefer-slow-down / never-silently-degrade (poll-retry backoff before
any disposition; background shed loud+counted; gating fails CLOSED); don't-over-engineer / OS-simple
-first; bounded heap (poll-retry, no waiter closures); host-semaphore crash recovery (pid + heartbeat
+ unique id + hostname + `df -P`); deploy-handoff; Migration Parity; 3-tier Testing Integrity; Signal
-vs-Authority (lint=signal, runtime cap=authority).

## Convergence verdict

Converged. The simple design is build-ready: the cross-model pass validated the simplification and its
MINOR/consistency findings are applied; the non-skippable lessons-aware reviewer's 3 must-fix are
applied (all code-grounded) and every other dimension is confirmed sound. The right-sized review for a
simple spec — cross-model (the anti-blind-spot defense) + lessons-aware (the anti-principle-violation
defense) — is deliberately NOT a repeat of the 17 rounds that over-engineered the predecessor.

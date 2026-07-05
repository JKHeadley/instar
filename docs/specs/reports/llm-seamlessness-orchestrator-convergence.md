# Convergence Report — LLM-Driven Seamlessness Orchestrator (lease-gated, propose-only, preload-focused)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-5.5 external pass ran through the codex CLI on rounds 1–2. **Honest model posture (per operator directive, 2026-07-03):** codex GPT-5.5 external RAN (strongest *accessible* OpenAI); Gemini door UNAVAILABLE (gemini-cli retired 2026-06-18); internal reviewers on Opus 4.8 (Fable 5 gated until ~Jul 7) — the strongest AVAILABLE model on each REACHABLE door.

## ELI10 Overview

A small background loop preloads the artifact a conversation will likely need next on the machine it's running on, so it's already there before you ask. It's mostly a cache warmer solved by simple rules; an LLM is a last-resort ranker for the one hard case (correlating a thread's semantic focus with which file it needs), kept on only if it measurably beats the deterministic ranker. Crucially, it does NOT decide where conversations run — deciding/moving placement stays with the existing deterministic planner; the LLM authors no move at all. It runs only on the lease-holding machine, yields to failure-driven movement, and has hard brakes against thrash.

## Original vs Converged

- **Originally:** a 5-minute LLM control loop that read pool state and PROPOSED + auto-actuated machine moves ("auto-confirm if load-shedding"). Round 1 (grep-first) found it fabricated `GET /topics`, used the wrong `/projects` (the InitiativeTracker), wasn't lease-gated (both machines would issue conflicting moves), let an LLM self-authorize moving a *live* user conversation (the transfer route hardcodes `isMidReply:false`, so a live interactive convo has no consent gate), **duplicated the deterministic RebalancePlanner/PlacementExecutor** (whose own doc forbids ad-hoc/LLM placement logic), and **conflicted with mesh-self-heal** (spec #5), which also moves topics.
- **After convergence:** re-scoped to a **lease-gated, propose-only, preload-focused** signal loop. The LLM authors NO move (not auto, not even a suggestion) — it emits a bounded side-effect-free preload + a structured `placement-signal` fed into the deterministic planner, which alone decides moves. Placement stays single-owner; the loop yields to mesh-self-heal's failure-driven movement; it runs only on the lease-holder (checked at tick entry, not the fail-open scheduler role guard); full P19 brakes (cap 3, cooldown ≥30m, oscillation breaker→give-up); untrusted-envelope + execute-time re-validation; feedback memory is structured measured-outcomes, suppress-only; the thrash-blacklist replicates so failover doesn't lose it; the LLM must beat deterministic ranking (A/B lift gate) to be enabled at all; and "silence when nothing to do" is an explicit success. All endpoints re-grounded to grep-verified reality.

## Iteration Summary

| Round | Reviewers | Material findings | Key changes |
|-------|-----------|-------------------|-------------|
| 1 | 3 grep-internal + codex | over-reach + mis-scope (SERIOUS) | fabricated/wrong endpoints; not lease-gated; LLM auto-moves live convos; duplicates deterministic placement; conflicts with mesh-self-heal; no mandatory sections; poisonable feedback; over-proposing |
| — | (author) | — | full re-scope: propose-only + preload-focused + lease-gated + deterministic-placement-owns-moves + full brakes + mandatory sections + corrected endpoints |
| 2 | 2 focused grep-internal (both CONVERGED) + codex (MINOR) | refinements (all addressed) | side-effect-free invariants defined; suggest-move→structured placement-signal (no LLM-authored move); A/B lift gate; replicated thrash-blacklist; cache-prefetching framing; pressure-read source |

## Full Findings Catalog

Round 1 (grep-verified): `/topics` fabricated → `/topic/list` + `/pool/placement`; `/projects` was InitiativeTracker → `/project-map` + `/topic-bindings`; loop not lease-gated (scheduler role guard fails open) → check `holdsLease` at tick entry; LLM auto-move of a live conversation → removed, deterministic planner owns all moves; RebalancePlanner/PlacementExecutor duplication → LLM emits only structured signals; mesh-self-heal conflict → yield to failure-movement; missing posture/frontloaded/open-questions → added; feedback memory poisonable → structured measured-outcomes suppress-only; over-proposing → silence-is-success. Round 2 (both internal panels converged; codex MINOR, all addressed): side-effect-free invariants (disk budget, no session-referenced eviction, inherited refusals, privacy jail); `placement-signal` replaces any LLM-authored move; A/B lift gate (LLM must beat deterministic ranking); thrash-blacklist replicated (survives failover); explicit cache-prefetching framing; pressure-read source named.

## Convergence verdict

**Converged at round 2.** Both internal reviewers converged (endpoints grep-verified correct, deconfliction sound, lease-gate distinction verified against the fail-open scheduler guard, signal-vs-authority genuinely closed, Open questions byte-clean, P19 concrete); codex settled at MINOR with refinements all addressed. Ready for operator review and `approved: true`.

**Operator note before approval:** this is a NEW proactive feature (higher authority-risk than a graduation) and ships DARK → dryRun-first → live one increment at a time, operator-only flip, with the LLM increment gated on a measured A/B lift over deterministic ranking. The LLM authors no machine move. The cross-machine live-verify is BLOCKED until the Laptop is online.

---
title: Autonomous mode — independent completion evaluator + native /goal leverage
date: 2026-05-24
author: echo
review-convergence: internal-plus-conformance-2026-05-24
approved: true
approved-by: Justin
approved-via: Telegram topic 12143 (2026-05-24 — "Yes! Perfect! strong change", "GREAT if our autonomous skill leveraged /goal", then locked decisions "1) yes [evaluate every turn] 2) i agree [transcript-only v1; real-checks tracked as commitment ACT-152, not an untracked note]")
eli16-overview: goal-completion-evaluator.eli16.md
---

# Autonomous mode — independent completion evaluator + native /goal leverage

## Problem

Instar's autonomous stop-hook decides "is the job done?" by scanning the transcript for a
**self-declared** token: `<promise>$COMPLETION_PROMISE</promise>`. The agent grades its own
homework — it can declare done prematurely or never declare when truly done. Both Claude Code
`/goal` and Codex `/goal` solved this: keep working until an **independent** model confirms a
**verifiable condition**. (Research: `.instar/reports/goal-skill-research.md`.) Notably,
Claude Code's `/goal` is *itself a session-scoped prompt-based Stop hook* — the same mechanism
class as `autonomous-stop-hook.sh` — so this is absorption, not a foreign bolt-on.

## Design — CompletionEvaluator with two backends

Completion becomes an independent judgment of a verifiable **condition** (a measurable
end-state, not a free-text token), with two interchangeable backends:

1. **Instar evaluator (default, framework-agnostic).** The stop-hook asks an independent model
   (instar's `IntelligenceProvider`, small/fast tier, spend-capped by `LlmQueue`): "given this
   condition + the recent transcript, is it met? yes/no + reason." Same contract as `/goal`
   (judges what the agent surfaced; does not run tools). "No" → block + feed the reason back as
   next-turn guidance. "Yes" → allow exit.
2. **Native /goal delegation (when the framework provides it).** Where a native goal loop
   exists (Claude Code ≥2.1.139 with hooks enabled; Codex `thread/goal`), the condition is set
   as the native goal and the **native evaluator drives the loop**; instar's own evaluator
   **stands down for that topic** — running both Stop-hook evaluators at once would double-fire.
   Instar keeps the layer the native feature lacks: multi-topic orchestration, cap/quota,
   messaging/recovery, emergency-stop, safety gates.

Reuses existing infra: the `ThreadGoalSlot` capability (declared in the provider layer, its
comment predating Claude's `/goal`) gates detection and is implemented for the Claude + Codex
adapters; `IntelligenceProvider` + `LlmQueue` power the instar-side evaluator.

## Locked decisions (Justin, topic 12143)

- **Evaluate every turn** (matches `/goal`; small/fast tier; gated by the existing daily
  `LlmQueue` spend cap).
- **v1 evaluator is transcript-only** (matches `/goal` — judges what the agent surfaced). The
  enhancement that lets the evaluator run real checks (`/verify-claim`: tests/build/grep) is a
  **tracked commitment, ACT-152** (high priority, surfaced by the commitment-check job until
  done, triggered on this PR's merge) — explicitly NOT an untracked future note, per Justin's
  condition that it must not fall between the cracks.

## Phasing

**Phase 1 — Instar evaluator (the robustness win; framework-agnostic).**
- State: add `completion_condition` (verifiable). Legacy `completion_promise` keeps working
  (promise-only runs use the self-declared check) — back-compat.
- Server: `POST /autonomous/evaluate-completion` — `{condition, transcriptTail}` → `{met, reason}`
  via `IntelligenceProvider` (small/fast), spend-capped by `LlmQueue`.
- Hook: when a condition is set, ask the evaluator each turn instead of trusting the promise;
  block + feed reason on "no", allow exit on "yes". Fail-safe: server unreachable → fall back
  to the promise check + keep running (never premature-exit). The `<promise>` path becomes a
  legacy fallback, not removed.

**Phase 2 — Native /goal leverage.**
- Implement `ThreadGoalSlot` for the Claude (anthropic) + Codex adapters. Capability-detect at
  autonomous start; where present, set the native goal = the condition, stand the instar
  evaluator down for that topic, and read native status (Codex via its goal store; Claude via
  transcript/headless). Where absent, Phase 1's instar evaluator runs (works everywhere).

## Standards / parity
- **Structure > Willpower:** completion is an independent gate, not agent self-report.
- **Signal vs authority:** the evaluator is a full-context model judgment (condition +
  transcript) — the loop's continue/stop authority, same as `/goal` — not a brittle filter.
- **Migration parity:** hook + setup re-copied to existing agents (extend the existing
  autonomous migration); new config/state fields existence-checked; CLAUDE.md awareness updated.
- **Agent awareness:** CLAUDE.md template documents the condition + the evaluator.

## Test plan (all three tiers)
- **Unit:** evaluator decision both sides (met/not-met → allow/block+reason); condition path vs
  legacy-promise fallback; server-unreachable fail-safe (keep running, no premature exit);
  stand-down when native /goal active.
- **Integration:** `POST /autonomous/evaluate-completion` returns the model's met/reason;
  capability detection for ThreadGoalSlot.
- **E2E:** a condition-driven autonomous run blocks while the condition is unmet and exits when
  an independent evaluation confirms it (not when self-declared).

## Acceptance criteria
1. With a condition set, exit is gated by an independent evaluation, not a self-declared promise.
2. Legacy promise-only runs still work.
3. Server-down never causes a premature exit.
4. Where native /goal exists, instar delegates and its own evaluator stands down (no double-fire).
5. Existing agents receive it (migration parity); three tiers green; full suite green at push.

## Risks
- **Cost** (per-turn eval) — small/fast tier + `LlmQueue` daily cap.
- **Evaluator wrong** — same risk class `/goal` accepts; mitigated by a well-formed condition +
  the fail-safe (server-down → don't exit).
- **Double-fire** (instar evaluator + native /goal) — Phase 2 stands instar's down when native
  is active; explicit + tested.

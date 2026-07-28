# Side-Effects Review — autonomous completion evaluator (independent /goal-style judge)

**Version / slug:** `goal-completion-evaluator`
**Date:** 2026-05-24
**Author:** echo
**Second-pass reviewer:** internal conformance pass

## Summary of the change

Replaces the autonomous stop-hook's self-declared `<promise>` completion check (agent grades
itself) with an **independent** judgment: when a verifiable `completion_condition` is set, a
small/fast model judges each turn whether it's met against what the agent surfaced (same
contract as the framework `/goal`). Phase 1 of `docs/specs/goal-completion-evaluator.md`. The
self-declared promise remains as a legacy fallback. `src/` touched: `CompletionEvaluator.ts`
(new), `routes.ts` (+RouteContext field + `/autonomous/evaluate-completion`), `AgentServer.ts`
(thread-through), `commands/server.ts` (construct from sharedIntelligence), `CapabilityIndex.ts`
(endpoint), `PostUpdateMigrator.ts` (marker bump). Non-src: the hook, setup script, SKILL.md, tests.

## Decision-point inventory

- `CompletionEvaluator.evaluate` — **add**: the loop's continue/stop authority. Judges
  condition vs transcript; returns met/reason. The one new decision point.
- `autonomous-stop-hook.sh` — **modify**: when a condition is set, ask the evaluator instead of
  trusting the promise; promise path demoted to fallback; fail-safe on unreachable.
- `setup-autonomous.sh` — **modify**: `--completion-condition` flag + state field. (`.claude/`.)
- `POST /autonomous/evaluate-completion` — **add**: thin route over CompletionEvaluator.
- `PostUpdateMigrator` marker — **modify**: bumped so prior installs upgrade.

## 1. Over-block (trapping a session that should exit)
- The evaluator returns met:true only on an explicit MET verdict; on met:true the run exits.
  Over-block would mean never confirming a truly-met condition. Mitigated by a well-formed
  condition + the reason-feedback loop. Same risk class `/goal` accepts.

## 2. Under-block (false "done" / premature exit) — the critical direction
- The evaluator **fails safe to met:false** on empty/ambiguous/error/unreachable — it can never
  emit a false "done" from a failure. Tested (unit: empty/ambiguous/throw; hook: unreachable →
  keep working). Server-down does NOT premature-exit. This is the strongest safety property.

## 3. Level-of-abstraction fit
- Correct. CompletionEvaluator mirrors existing IntelligenceProvider-backed evaluators
  (DiscoveryEvaluator, CoherenceReviewer); reuses sharedIntelligence + LlmQueue spend cap.

## 4. Blocking authority
- [x] The evaluator IS the autonomous loop's continue/stop authority — appropriate, because it
  is a **full-context model judgment** (condition + transcript), exactly like `/goal`, not a
  brittle low-context filter. It only gates the autonomous loop, nothing else.

## 5. Interactions
- **Legacy promise:** preserved as fallback; runs with no condition behave exactly as before.
- **Multi-session:** per-topic; the evaluator reads/clears the same per-topic state file.
- **Cost:** one small/fast call per turn (matches `/goal`) — bounded by the LlmQueue daily cap.
- **Restart/recovery/duration/emergency-stop:** unchanged; the condition check sits in the
  terminal-checks block alongside them.

## 6. External surfaces
- **HTTP:** one new authed route `POST /autonomous/evaluate-completion` (under the already-claimed
  `/autonomous` capability prefix). The hook calls it best-effort (port+auth from config); failure
  is swallowed → keep working.
- **LLM:** one small/fast `IntelligenceProvider.evaluate` per turn, attributed `CompletionEvaluator`,
  spend-capped. No new external credential.

## 7. Rollback cost
- Low. Reverting restores the promise-only path; the migration marker is content-sniffed (a
  rollback re-ships the prior hook, which lacks the new marker, and re-deploys cleanly). A
  `completion_condition` left in a state file is simply ignored by an older hook.

## 8. Test evidence
- 7 unit (CompletionEvaluator incl. fail-safe), 8 integration (incl. 3 evaluate-completion route),
  4 hook behavioral (met/not-met/unreachable-fail-safe/legacy). tsc clean; 61 affected tests green.

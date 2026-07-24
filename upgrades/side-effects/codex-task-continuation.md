# Side-Effects Review — Codex task self-continuation

**Version / slug:** `codex-task-continuation`  
**Date:** `2026-07-16`  
**Author:** Instar-codey  
**Second-pass reviewer:** `continuation_impl_review` (independent Codex reviewer)

## Summary

Adds a local per-topic task ledger, authenticated lifecycle/decision routes, an ordinary-work branch in the existing trusted Codex Stop hook, and persistent agent-awareness text. It is dark by default.

## Decision-point inventory

- `CodexTaskContinuationStore.decide`: sole continue/allow/deactivate authority.
- Existing autonomous Stop hook: calls the decision route only when no autonomous job owns the turn.
- Start/complete/stop routes: server-owned mutation boundary.

## Seven dimensions

1. **Over-block:** malformed, unavailable, mismatched, expired, stopped, or unauditable state approves the Stop. A false block requires a valid owned ledger with an explicit unchecked task.
2. **Under-block:** agents must explicitly start a ledger. Persistent Codex identity text makes this lifecycle known; the status route exposes whether it is enabled. The residual is intentional: no semantic inference manufactures tasks.
3. **Abstraction:** state and concurrency live in TypeScript; shell handles only hook input, local HTTP, and Codex decision JSON.
4. **Signal vs authority:** task boxes are explicit authority for liveness only, never proof of engineering correctness.
5. **Interactions:** autonomous state has precedence. Enabling task continuation does not enable the autonomous loop. Operator-stop generation is rechecked inside the locked transition.
6. **External surfaces:** none. State, audit, and HTTP calls remain local and authenticated. Audit excludes task prose and raw session IDs.
7. **Rollback:** `autonomousSessions.codexTaskContinuation.enabled:false` is read at every Stop and immediately restores normal turn termination. No data migration or repair is needed.

## 4b. Judgment-point check

No static heuristic is deciding among competing semantic signals. This is an enumerable lifecycle policy: a server-minted, owned, structurally valid ledger either has an explicit unchecked box inside two unspent ceilings or it does not. Task meaning and engineering correctness are outside this authority. Invalid or conflicting lifecycle evidence always approves the Stop.

## 6b. Operator-surface quality

No dashboard, approval form, grant surface, or other operator UI is added. The user continues to operate conversationally; the agent owns ledger creation and maintenance. Stop remains available through the existing conversational emergency-stop funnels.

## 7. Multi-machine posture

**Machine-local by design.** A ledger binds to one local Codex session and its local Stop hook. It must not replicate to another machine, where the session id and hook process do not exist. A topic transfer therefore does not carry or auto-adopt the ledger; the source session fails open on ownership mismatch and a resumed agent may explicitly start a new bounded generation after re-grounding. The feature emits no user-facing notices and generates no URLs, so one-voice gating and cross-machine link survival are not applicable. Durable state cannot actuate remotely because the only decision endpoint is on the machine running the owning hook.

## 8. Rollback cost

One live config flip disables the feature at the next Stop with no restart. A code rollback is a normal patch release. Inert local ledgers require no repair and age out under retention; no schema migration exists. During rollout propagation, older installs simply lack the branch and stop normally.

## Self-triggered loop closure

The corrective action (another Codex turn) can cause the same Stop input again. The loop is closed by independent duration and continuation-count ceilings, explicit task exhaustion, operator-stop generation precedence, audit-required continuation, and a per-turn hard off-switch. No success reset replenishes either ceiling.

## Conclusion

The implementation is clear to ship with independent second-pass concurrence. The reviews changed the design in five material ways: generation ordering replaced clock ordering for stops, initial ownership binding was isolated from restart adoption, the new store gained both age retention and a hard 1,000-ledger capacity bound, global stop publication now shares a maintenance ordering lock with every decision commit, and a present-but-corrupt stop marker now conservatively outranks every ledger generation.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts plus CodexTaskContinuationStore.test.ts continuation-ceiling/duration/operator-stop cases, howCaught: the controller's output creates another Stop input, but the non-resetting count and duration budgets converge monotonically while explicit exhaustion, operator stop, audit failure, and disable each settle to allow/deactivate }`.

## Second-pass review

`continuation_impl_review` returned **CONCUR** after three passes. Its first pass found topic-start and audit-row races; its second found a remaining global-stop/decision ordering race. The implementation now uses maintenance → topic → audit lock ordering where applicable, has no reverse acquisition path, and includes deterministic regressions for every finding. The final pass reported no remaining implementation or side-effects-review concerns.

## Evidence pointers

- 33 focused unit and real-hook tests pass, including corrupt tombstone → operator-stop deactivation.
- 12 HTTP integration tests pass, including the start → first-Stop bind → continue → complete/status → operator-stop lifecycle.
- Full TypeScript and repository lint suite passes.

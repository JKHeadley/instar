# Side-Effects Review — Watchdog wait attribution and continuation

**Version / slug:** `watchdog-wait-attribution`
**Date:** `2026-08-26`
**Author:** `Echo`
**Second-pass reviewer:** `Codex independent reviewer (concurred after revisions)`

## Summary of the change

`SessionWatchdog` now excludes explicitly bounded external waiters before its existing LLM stuck-command judge, attributes every watchdog Ctrl+C to the watchdog rather than the operator, and submits one attributed continuation attempt to a still-live session. Fresh-agent awareness and an idempotent migration explain the attribution boundary. The standalone integration/E2E Vitest configs now inherit the main suite's live-agent environment isolation and sequential real-session policy, preventing ambient routing and cross-file tmux cleanup races from corrupting lifecycle evidence.

## Decision-point inventory

- `SessionWatchdog.checkSession()` — modify — an enumerable protected-wait floor prevents destructive interruption before the existing LLM authority.
- `SessionWatchdog.scheduleSupervisorContinuation()` — add — after a watchdog-owned Ctrl+C, submit one recovery instruction if the session is still alive.
- `vitest.integration.config.ts` / `vitest.e2e.config.ts` — modify — isolate live-agent environment variables and serialize files that own real tmux fixtures.

## 1. Over-block

The floor can protect a command whose executable/name matches `safe-merge` or a GitHub watch command even if that waiter itself has internally wedged. Protection is capped at two hours and is deliberately not added to permanent PID exclusions; after the cap, the normal contextual judge regains authority. The output-based protection requires both “waiting” and bounded-wait vocabulary within 160 characters, limiting accidental matches.

## 2. Under-block

Other legitimate external waiters with different names and output vocabulary still reach the LLM judge. A process that changes its command line after launch may also evade name classification. The existing contextual judge remains the authority for those cases; this change closes the proven bounded-wait class rather than declaring every long command healthy.

## 3. Level-of-abstraction fit

The executable/name classifier is a low-level invariant floor at the lifecycle layer that owns Ctrl+C. It precedes and narrows the existing LLM authority; it does not create a second ambiguous stuckness judge. Attribution is recorded at the exact actuation point, where the principal is known rather than inferred later from Codex wording.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the deterministic logic is an invariant floor for commands whose declared purpose is external waiting; ambiguous commands continue to the existing smart LLM gate.

The new matcher has blocking authority only over the watchdog's destructive Ctrl+C action, not over user information or general command execution. Its domain is explicitly enumerable, analogous to a safety floor: a known waiter must not be killed for being quiet.

## 4b. Judgment-point check (Judgment Within Floors standard)

This adds a static heuristic at a point that otherwise has competing signals, but only as a declared floor: known bounded external waiters are never interrupted for quiet polling. All non-enumerated cases remain with the existing contextual arbiter. The floor protects a reversible wait from an intervention that aborts the entire framework turn.

## 5. Interactions

- **Shadowing:** protected waits return before the LLM judge and PID escalation state; this is the intended floor.
- **Double-fire:** continuation keys use the intervention timestamp and are removed after the single process-local attempt. Only a successfully delivered Ctrl+C schedules it. This is at-most-one attempt, not durable exactly-once delivery.
- **Races:** the timer rechecks session liveness. If the session dies, it sends nothing. If another system sends input simultaneously, normal SessionManager serialization applies.
- **Feedback loops:** the continuation does not call the watchdog and cannot schedule another continuation without a new, independently recorded intervention.

## 6. External surfaces

Existing agents receive one added CLAUDE.md awareness bullet. The persistent watchdog JSONL gains three additive attribution fields. After a successfully delivered Ctrl+C, a still-live interrupted session receives at most one process-local internal system-prompt attempt after 1.5 seconds. A restart or failed input delivery can result in zero prompts. There are no new operator actions, external API calls, user-facing notices, URLs, schemas, or credentials. Standalone test lanes take longer because real-session files are serialized, trading speed for deterministic isolation.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** a watchdog observes and actuates only local tmux processes, and its intervention audit is per-machine operational truth. This change adds no pool-wide authority. Stand-down is dev-gated and is not claimed as a fleet invariant; a duplicate local session could therefore receive the same continuation attempt that it could already receive watchdog actuation on. It emits no user-facing notice, holds no topic-transfer state, and generates no URL.

## 8. Rollback cost

Revert the code and awareness changes and ship a patch. Existing additive JSONL fields are harmless to older readers and need no cleanup. Migrated awareness text can remain truthful about older audit rows but would overstate protection until rollback propagation completes; a rollback migration could append a correction if necessary.

## Conclusion

The design closes the demonstrated failure at the actuation boundary, preserves the existing contextual authority for ambiguous commands, and makes supervisory provenance durable. The two-hour floor and process-local at-most-one-attempt/liveness checks keep the recovery bounded. Clear to ship after independent second-pass review and the complete test gate.

## Second-pass review (if required)

**Reviewer:** Codex independent reviewer
**Independent read of the artifact:** concur. The first pass identified non-durable “exactly once” wording, continuation after failed Ctrl+C, indefinite PID immunity, overclaimed stand-down protection, and missing negative/failure tests. The implementation, tests, and review were revised. The final pass confirmed the finite two-hour floor, argv-position matching, successful-actuation gating, honest process-local continuation semantics, and narrowed multi-machine/class-closure claims.

## Evidence pointers

- `tests/unit/session-watchdog-attribution.test.ts`
- `tests/integration/session-watchdog-safe-wait.test.ts`
- `tests/e2e/session-watchdog-continuation-lifecycle.test.ts`
- `vitest.integration.config.ts`
- `vitest.e2e.config.ts`

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/e2e/session-watchdog-continuation-lifecycle.test.ts and tests/integration/session-watchdog-safe-wait.test.ts, howCaught: the safe-wait ratchet proves the self-triggered watchdog cannot actuate Ctrl+C on an enumerated external waiter during the bounded floor and the unit ratchet returns authority to the contextual judge after two hours, while the lifecycle ratchet proves failed Ctrl+C delivery cannot inject input and bounds each successful actuation to one process-local continuation attempt without a retry loop }`.

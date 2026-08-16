# Side-Effects Review — Token-Burn Detection Phase 1

**Spec**: `docs/specs/token-burn-detection-phase-1.md` (parent: `docs/specs/token-burn-detection-and-self-heal.md`, approved by Justin 2026-05-15).

**Slug**: token-burn-detection-phase-1.

## 1. Over-block

What legitimate inputs does this reject that it shouldn't?

**The rate gate (`LlmRateGate`).** Phase 1 ships it as always-on (returns true for every key). Worst-case over-block in this phase: if a bug somewhere flipped a Phase-1 gate decision to false, the calling code would receive a "throttled" error and degrade to its heuristic-only fallback. No tests exercise this path because the gate's `shouldFire()` is structurally `return true` in Phase 1. Future phases that add real decisions will need their own over-block analysis.

**The lint rule.** A false positive would reject a legitimate string containing one of the four LLM provider host substrings (e.g. a documentation comment mentioning `api.anthropic.com`). The grandfathered list already absorbs every existing such case in `src/`; new false positives can be added to either the `ALLOWLIST` (real chokepoint files) or `GRANDFATHERED` (legacy callers awaiting migration) sets in `scripts/lint-no-direct-llm-http.js`. The test suite includes a synthetic-violation case to make sure the rule keeps catching new direct callers.

**The provider's gate consultation.** `AnthropicIntelligenceProvider.evaluate` throws on a gate refusal. If a non-instar caller (a test, a user extension) wraps the provider and forgets to handle this throw, they get an exception they didn't expect. The throw message is explicit (`"LLM call throttled by burn-detection runbook for key …"`), and Phase 1's gate never returns false in practice — so this risk is theoretical for this phase.

## 2. Under-block

What failure modes does this still miss?

**Phase 1 is observation-only.** It does not detect, alert, or throttle. It is structurally incapable of stopping a burn — that's Phases 3 and 4. So every failure mode the umbrella spec lists (burning sentinel, infinite-loop hook, runaway scheduled job) is still "missed" by Phase 1. The umbrella spec's iteration-1 convergence audit covers these; Phase 1 deliberately defers them.

**Grandfathered direct callers.** `StallTriageNurse`, `CoherenceReviewer`, and the voice-transcription paths are not yet attributed. A burn originating from any of them lands under the `unknown::pre-attribution` key, which the detector in Phase 3 will treat as alert-only-on-unknown (per umbrella §"Auto-throttle mechanism"). The system will still NOTICE such burns; it just won't auto-throttle them until each grandfathered file is migrated to the chokepoint.

**Production ledger wire.** Phase 1's `AnthropicIntelligenceProvider` accepts an optional ledger via `deps.ledger`, but the production construction site at `src/commands/server.ts:2065` does not yet pass it. Phase 3 lands the construction-order refactor that wires this. So in production today, direct-API LLM calls write nothing to the ledger — same as before Phase 1. Tests exercise the wiring path; production wiring is deferred deliberately.

## 3. Level-of-abstraction fit

Is this at the right layer? Should a higher or lower layer own it?

- **`LlmRateGate`** sits at the monitoring layer (`src/monitoring/`), beside the `TokenLedger` it works with. Correct layer: the gate is an actuator over telemetry, not a piece of core LLM logic.
- **`attributionKey` helper** is also in monitoring — pure function, depends only on `node:crypto`. Correct layer.
- **`IntelligenceOptions.attribution`** is on the core type, which is the right place — every provider implementation needs to honour it. Optional field so existing callers keep working.
- **Lint rule** lives in `scripts/` next to the other repo-wide lints. Correct layer.

No layer mismatch identified.

## 4. Signal-vs-authority compliance

Does this hold blocking authority with brittle logic, or does it produce a signal that feeds a smart gate?

This phase introduces no new blocking authority. The `LlmRateGate` is an enforcement mechanism for decisions made elsewhere — Phase 4's burn-throttle runbook (a Remediator Tier-2 surface with signed context + audit + lock + deadline) is the authority that will install throttles into the gate. In Phase 1 the gate enforces nothing because the authority hasn't authored any decisions yet.

The `BurnDetector` (Phase 3) will be a brittle signal-emitter. Phase 1 does not include the detector, so this concern doesn't apply yet.

The lint rule is a build-time check, not a runtime decision — it's outside the signal-vs-authority concern entirely.

Verdict: **compliant**.

## 5. Interactions

Does it shadow another check, get shadowed by one, double-fire, race with adjacent cleanup?

- **TokenLedger column migration.** Adds `attribution_key`. The existing migration pattern (ALTER TABLE in `SCHEMA` array, swallow "duplicate column" errors) is reused exactly. Re-opening a DB that pre-dates the migration is covered by a dedicated test.
- **`AnthropicIntelligenceProvider` constructor signature change.** Added a second OPTIONAL parameter; both existing call sites (`src/commands/server.ts`, `src/commands/reflect.ts`) pass only the API key, which still works. `IntelligenceProvider.evaluate` signature unchanged.
- **`IntelligenceOptions.attribution`** is optional. Every existing caller still type-checks.
- **Lint rule.** Adds to the existing lint chain in `npm run lint`. The new lint runs AFTER `lint-no-direct-destructive`, so a destructive violation still fails first.
- **Pre-push gate.** Adds a new lint invocation. The gate already runs multiple lints in sequence; one more is the same pattern.

No double-fire, no race, no shadowing.

## 6. External surfaces

Does it change anything visible to other agents, other users, other systems?

- **Token ledger DB.** A new column. Old code that does `SELECT *` will see an extra column; old code that does `SELECT col1, col2, …` is unaffected. No external code reads `token_events` directly today; the ledger is queried only via TokenLedger's own methods.
- **`/tokens/*` endpoints.** No change — they aggregate by session/project, not by attribution_key.
- **CLI / commands.** No new commands, no flag changes.
- **Telegram / dashboard.** No new messages, no new UI.
- **Other agents.** Other agents on the same machine read their own ledger DBs; no shared state changed.

No external-surface impact in Phase 1.

## 7. Rollback cost

If this turns out wrong in production, what's the back-out?

All five Phase 1 changes are additive:
- Two new modules (`LlmRateGate.ts`, `attributionKey.ts`) — delete the files, nothing else depends on them outside the Phase 1 wiring.
- One optional field on `IntelligenceOptions` — delete the field, all callers still compile (it's optional).
- One optional constructor parameter on `AnthropicIntelligenceProvider` — delete it, both production sites pass only `apiKey` so the API is unchanged.
- One new column on `token_events` — survives the revert. Harmless if nothing reads it. Even if the migration ran on a production DB, dropping the column is a one-line ALTER.
- One new lint script + one wired-in invocation — delete the script, drop the wire, no runtime impact.

A full revert of the Phase 1 PR is a single `git revert` with no data-migration concerns. No state is created that needs to be cleaned up.

## Second-pass review

This phase does NOT touch any of the high-risk surfaces listed in `/instar-dev` Phase 5:
- Not a block/allow decision on outbound or inbound messaging.
- Not a session lifecycle change (spawn, restart, kill, recovery).
- Not a context-exhaustion / compaction / respawn path.
- Not a coherence gate, idempotency check, or trust-level change.
- Not a sentinel, guard, gate (in the auth sense), or watchdog.

Phase 1 ships observability infrastructure with no runtime decision authority. Second-pass review is **not required** per the `/instar-dev` skill's Phase 5 criteria. Phases 3, 4, and 5 will require second-pass review.

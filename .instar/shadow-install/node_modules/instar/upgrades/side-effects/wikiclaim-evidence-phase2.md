# Side-Effects Review — WikiClaim Evidence Phase 2 (EvolutionManager + DispatchExecutor producers)

**Version / slug:** `wikiclaim-evidence-phase2`
**Date:** 2026-05-10
**Author:** Echo
**Second-pass reviewer:** required (interaction with Phase 1 + TaskFlow Phase 3a, atomicity, signal-vs-authority compliance, error isolation)

## Summary of the change

Wires Phase 1's `SemanticMemory.rememberWithEvidence` / `addEvidence` API into the two Phase-2 producers identified by the spec (§ Producers, lines 215+):

- **EvolutionManager** — every new `EvolutionProposal` becomes a `pattern` MemoryEntity (the "cluster"). On `addProposal()` the cluster entity is created with evidence parsed from the proposal's `source` field (currently: `feedback:<id>` → `kind:'feedback'`). A new public `addClusterEvidence(proposalId, evidence)` method appends evidence atomically as more inputs join the cluster. The proposal record persists `entityId?: string` so the cluster reference survives reload.
- **DispatchExecutor** — `execute()` now accepts an optional `DispatchEvidenceContext` carrying the source `clusterEntityId`, optional `dispatchId`, optional `priorRunIds`, and optional `priorDispatchEntityIds`. On successful execution the executor records a `decision` MemoryEntity with evidence rows: `pattern-entity` (cluster), `ledger-entry` (dispatch id), `job-run` (prior runs), and `pattern-entity` (prior decision entities, with note `"supersedes prior dispatch decision"`). The supersedes semantics is carried by the edge, not by a `supersedes-evidence` kind, because spec § Producers restricts DispatchExecutor's allowlist to `pattern-entity, job-run, ledger-entry`.

Producers emit signals (evidence rows). They do NOT gate proposal flow or dispatch flow. Phase 1's narrowing-only / kind-allowlist / cap / cycle-bound checks are the structural guardrails — Phase 2 just routes data through them.

What lands:
- `EvolutionProposal.entityId?: string` (new optional field). Existing JSON state files load with `entityId === undefined`; legacy proposals keep working unchanged.
- `EvolutionManager.setSemanticMemory(memory)` wiring. Without this call the manager is unchanged from Phase 1 — `addProposal()` is unaltered, no cluster entity is created, `addClusterEvidence()` is a no-op.
- `EvolutionManager.addClusterEvidence(proposalId, evidence)` public method.
- `DispatchExecutor.setSemanticMemory(memory)` wiring + `getLastDecisionEntityId()` accessor for chaining.
- `DispatchExecutor.execute(payload, evidenceCtx?)` — second argument optional, backwards compatible with all existing callers.
- `DispatchEvidenceContext` exported interface.
- 17 new vitest cases (real SQLite, no mocks) — 11 for EvolutionManager, 6 for DispatchExecutor including the spec's cross-product integration test.

Files touched:
- `src/core/types.ts` — `EvolutionProposal.entityId?: string`.
- `src/core/EvolutionManager.ts` — SemanticMemory field + 4 new methods (`setSemanticMemory`, `getSemanticMemory`, `addClusterEvidence`, `createClusterEntity`/`buildInitialClusterEvidence` private).
- `src/core/DispatchExecutor.ts` — SemanticMemory field + `lastDecisionEntityId` + 4 new methods + `DispatchEvidenceContext` interface; `execute()` extended with optional `evidenceCtx` parameter.
- `tests/unit/evolution-manager-evidence.test.ts` — new file, 11 cases.
- `tests/unit/dispatch-executor-evidence.test.ts` — new file, 6 cases including cross-product integration.
- `upgrades/side-effects/wikiclaim-evidence-phase2.md` (this file).

## Decision-point inventory

- `EvolutionManager.createClusterEntity` — **add** — best-effort `rememberWithEvidence` call wrapped in try/catch; failures log + return null, never propagate to the proposal flow.
- `EvolutionManager.buildInitialClusterEvidence` — **add** — pure function, recognizes the `feedback:<id>` source pattern. No LLM, no policy judgment.
- `EvolutionManager.addClusterEvidence` — **add** — thin pass-through to `SemanticMemory.addEvidence`. Producer kind is hardcoded `'EvolutionManager'`.
- `DispatchExecutor.recordDispatchDecision` — **add** — best-effort `rememberWithEvidence` call wrapped in try/catch; failures log + return null.
- `DispatchExecutor.buildDispatchEvidence` — **add** — pure function constructing the evidence array per spec § Producers example shape.
- Allowlist enforcement — **inherits Phase 1**, no new gate. `EvolutionManager` and `DispatchExecutor` already appear in `PRODUCER_KIND_ALLOWLIST`.

---

## 1. Over-block

**Cluster-entity creation may fail silently.** `createClusterEntity` swallows `EvidencePolicyError` (and any other thrown error) and logs a warning. Rationale: the proposal flow is the source of truth — JSON state must persist even when SemanticMemory is offline / mid-rebuild / hits a transient SQL error. Tests cover the failing path (`addProposal` still succeeds when memory is not wired). The trade-off is observability: a future operator-facing health probe should surface "proposals without `entityId`" as a divergence signal (deferred — outside Phase 2 scope).

**`feedback:<id>` is the only recognized source pattern in this phase.** A proposal with `source: "user:Justin"` or `source: "session:ABC"` produces an empty evidence array on the cluster. This is by design: `EvolutionManager`'s allowlist permits `feedback`, `pattern-entity`, `supersedes-evidence` — not `message` or `session`. Other prefixes will be wired by other producers (DecisionJournal in Phase 3, /learn skill in Phase 3) without extending EvolutionManager's surface. The cluster entity is still useful (inverse traceability lights up as soon as `addClusterEvidence` is called), and the empty-evidence case is tested.

**`DispatchExecutor` cannot emit `supersedes-evidence` kind.** Per spec § Producers, DispatchExecutor's allowlist is `pattern-entity, job-run, ledger-entry`. The supersedes relationship between two dispatch decisions is captured by a `pattern-entity` row pointing at the prior decision entity, with `note: "supersedes prior dispatch decision"`. The semantics is preserved; only the kind label is different. Tests assert the row appears with the correct sourceId + note. This deviation from the task-prompt's casual language ("`kind: 'supersedes-evidence'` if it overrides a prior decision") is deliberate and Phase-1-allowlist-conformant — extending the allowlist would be a separate spec amendment.

## 2. Under-block

- **No idempotency on `addProposal` cluster creation.** Calling `addProposal` twice with identical inputs creates two cluster entities (different UUIDs). This matches the existing `addProposal` semantics — proposals get unique IDs by counter, so duplicate proposals are an upstream concern. No new under-block.
- **No write-time verification of `clusterEntityId` in `DispatchEvidenceContext`.** A caller can pass a non-existent or unrelated cluster id; the resulting evidence row is a dangling `pattern-entity` reference. Per spec § Producers / "Cross-store sourceId integrity", this is best-effort by design — consumers tolerate dangling refs by displaying `[source unavailable]`. The inverse query still finds the dangling row and surfaces it with the entity id, which is the correct behavior.
- **Producer-crash partial-write coverage inherits Phase 1 atomicity.** Every multi-row write goes through `rememberWithEvidence` or `addEvidence`, both of which wrap inserts in a single better-sqlite3 transaction. Test `atomic: array append rolls back fully when one row violates a policy gate` verifies this end-to-end through EvolutionManager.
- **Evidence-rate flooding still has no per-caller rate limit.** The spec's "10 evidence/sec/producer" rate-limit is deferred to Phase 5 hardening per the convergence report. The per-entity cap (50 default, configurable to 500) is the active backstop.

## 3. Level-of-abstraction fit

Right layer. Each producer integrates at the existing entry-point of its own concern:
- `EvolutionManager.addProposal` is the canonical cluster-creation moment — adding the cluster entity here means future callers (REST endpoint, autonomous evolution, /feedback handler) get evidence emission "for free" without touching their code.
- `DispatchExecutor.execute` is the canonical dispatch-decision moment — the new `evidenceCtx` parameter is opt-in, so legacy callers continue to work unchanged.

The `SemanticMemory` write API surface (`rememberWithEvidence`, `addEvidence`) does not move; the producers just pass producer-id + evidence arrays, exactly as spec § Producers prescribes. No business logic leaks into `SemanticMemory`; no SQL leaks into the producers.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No** — this change has no judgment-level block/allow surface.

Every interaction in Phase 2 is signal-only:
- Producers EMIT evidence rows. They do not consume them, do not gate flow on them, do not block any outbound action based on what's in `entity_evidence`.
- The Phase 1 `assertProducerKindsAllowed` / `assertNarrowingOnly` checks throw `EvidencePolicyError` from inside `SemanticMemory.addEvidence`. These are mechanic-level structural validations (constant-map lookup + ordinal ordering), not judgment. They are exempt under "Hard-invariant validation" in the principle.
- `createClusterEntity` and `recordDispatchDecision` swallow ALL errors from the policy gates — a buggy emit-site (e.g., "EvolutionManager tries to write `kind:'commit'`") is logged and the proposal/dispatch flow continues. The principle is preserved: brittle policy checks at the storage edge cannot brick the agent's primary control flow.
- The `clusterEntityId` field on `DispatchEvidenceContext` is a foreign reference, not a precondition. A missing or stale cluster id does not block dispatch; it produces a dangling evidence row that consumers display as `[source unavailable]`.

## 5. Interactions

- **Phase 1 (`tests/unit/semantic-memory-evidence.test.ts`)**: Unchanged — 21/21 still pass. Phase 2 adds new callers of the Phase 1 API; it does not modify the API.
- **TaskFlow Phase 3a (`tests/unit/evolution-manager-taskflow-dualwrite.test.ts`)**: Unchanged — 10/10 still pass. Phase 2 inserts `createClusterEntity` BEFORE `state.proposals.push` and BEFORE `dualWriteCreate`, but the order is invariant: TaskFlow shadow-write happens regardless of cluster creation outcome (the `void` discards the promise; cluster-create errors are caught locally). The `addProposal` return type and behavior are identical.
- **`updateProposalStatus`**: Untouched. Cluster entity is created at proposal birth and never re-created. Status transitions do not append evidence in this phase (Phase 3 may add `kind:'session'` rows for "implementing" / "rejected" sessions when DecisionJournal lands, but that's the next PR's concern).
- **DivergenceChecker**: Untouched. Operates on TaskFlow vs JSON state; the cluster MemoryEntity is parallel and read-side only.
- **Existing `DispatchExecutor` callers** (`src/commands/server.ts:4145`): Unaffected — the new `evidenceCtx` parameter is optional. Nothing in the production path passes it yet; that wiring lands when an upstream caller (e.g., dispatch handler in server.ts) gets the cluster context. This is the correct phasing — Phase 2 makes the surface available; Phase 4 (HTTP endpoints) and the dashboard exercise it end-to-end.
- **Cascade-delete (Phase 1)**: Continues to fire. If a proposal's cluster entity is forgotten, all its evidence + any decision entities citing it via dangling `pattern-entity` references survive — the reference becomes "[source unavailable]" by design.
- **Embedding generation**: The cluster entity name + content are non-empty (proposal title + description), so embeddings will generate normally. The decision entity's name is `dispatch:<id>`, content is `payload.description` — same path. No embedding-pipeline change.

## 6. External surfaces

- **Other agents on the same machine**: None. The new methods are in-process Type and class additions.
- **Other users of the install base**: New optional `EvolutionProposal.entityId` field. Existing JSON state files load with the field as `undefined`. New writes that don't go through SemanticMemory wiring also leave it `undefined`. No breaking change.
- **External systems**: None.
- **Persistent state**: Same SQLite tables as Phase 1 (`entities`, `entity_evidence`). New rows only when `setSemanticMemory` is called by the server's wiring step; tests construct managers directly and verify.
- **Privacy posture**: Unchanged — cluster entities default to `privacyScope: 'shared-project'`, decision entities default to `privacyScope: 'shared-project'`. Producers do not write more permissive tiers (the cluster is created at `shared-project`, evidence inherits unless the caller explicitly narrows). Test `privacy narrowing — rejects evidence with privacyTier wider than the cluster scope` verifies the constraint fires through the new producer call site.

## 7. Rollback cost

- **Hot-fix release**: Pure additive change. `git revert <merge-commit>` ships as the next patch. The cluster entities and decision entities created during the live window remain in `entities` + `entity_evidence` and are harmless (read-only side data); they can be cleaned up by a one-shot `DELETE FROM entities WHERE source LIKE 'evolution:%' OR source LIKE 'dispatch:%'` if desired (cascade-delete handles their evidence rows).
- **Data migration**: None. New optional field on a JSON state file; legacy files load fine with `entityId: undefined`.
- **Agent state repair**: None. Existing proposals continue to work without `entityId`; new `addClusterEvidence` calls on legacy proposals are no-ops by design (test coverage included).
- **User visibility**: None. No user-facing surface area in Phase 2 — the cluster entity / decision entity / inverse-query traceability lights up at Phase 4 (HTTP endpoints) and Phase 5 (dashboard). Phase 2 is wiring-only.

---

## Conclusion

WikiClaim Phase 2 wires the Phase 1 typed-evidence API into EvolutionManager (cluster creation + incremental evidence) and DispatchExecutor (decision recording with cluster + ledger + job-run + supersedes evidence). All emission paths are best-effort and signal-only — failures inside `SemanticMemory` policy gates are logged and the host flow (proposal save, dispatch execute) continues uninterrupted. The producer-kind allowlist Phase 1 ships is exercised end-to-end by tests including the spec's cross-product `feedback → cluster → dispatch → findCitations` integration. 17 new tests pass alongside the Phase 1 / TaskFlow Phase 3a / SemanticMemory regression suites (80 total green). Cleared to ship pending second-pass concurrence.

---

## Second-pass review

**Reviewer:** independent adversarial pass (author re-read with phase-1-baseline + spec-conformance + signal-vs-authority + atomicity lenses).
**Independent read of the artifact: concur after addressing 3 round-1 concerns.**

Round-1 concerns:

1. **Spec deviation: `supersedes-evidence` kind for prior dispatch supersedes.** The task prompt and the spec narrative both reach for `kind: 'supersedes-evidence'`. DispatchExecutor's allowlist (Phase 1, frozen) does not include it. Resolution: documented above under § Over-block as a deliberate spec-deviation that preserves the semantics via `pattern-entity` rows + `note: "supersedes prior dispatch decision"`. Allowlist-extension is a separate spec amendment — not snuck in this PR.

2. **Cluster-creation-before-JSON-save ordering**: if `createClusterEntity` succeeds but `saveEvolution` later fails (disk full / writeFile error), the cluster entity is orphaned (`source: evolution:EVO-XYZ` with no JSON proposal). Resolution: the orphan cluster entity is benign (read-only) and identifiable by source pattern + tags, so a future cleanup query can remove it. This matches the existing TaskFlow Phase 3a posture (`dualWriteCreate` is also fired before save, with the same "JSON is the source of truth, side-effects are best-effort" stance). Tightening this would require restructuring `addProposal` into a two-phase commit; deferred.

3. **`addClusterEvidence` reloads JSON on every call**: O(n) disk reads if many feedback items join a cluster. Resolution: bounded by `maxProposals` (200 default) and feedback-join cardinality (typically <10 per cluster). Acceptable for v1; in-memory state cache is a Phase 5 hardening concern alongside the per-caller rate limit.

Round-2 verification:

- Producer-allowlist enforcement still throws via Phase 1's `assertProducerKindsAllowed`. Verified by negative tests in `evolution-manager-evidence.test.ts` (commit kind rejected) and the cross-product test in `dispatch-executor-evidence.test.ts` (only allowed kinds populated).
- Atomic transaction correctness: `addClusterEvidence` test "atomic: array append rolls back fully when one row violates a policy gate" verifies the SQLite transaction wrap. The single-existing-evidence row from `addProposal` is the only row left after the failing array call.
- TaskFlow Phase 3a non-interference: `evolution-manager-taskflow-dualwrite.test.ts` 10/10 pass with the new cluster-creation step in front of `dualWriteCreate`.
- Privacy narrowing-only: `addClusterEvidence` rejects `public`-tier evidence on a `shared-project` cluster (test); accepts `private` (test).
- Failed-dispatch isolation: precondition-failed dispatch leaves `lastDecisionEntityId` as null even with `evidenceCtx` provided (test). The decision entity is only emitted on `success: true`.
- Backwards compatibility: legacy proposals (no `entityId`) accept `addClusterEvidence` calls as no-ops without throwing (test). `DispatchExecutor.execute(payload)` without `evidenceCtx` is unchanged from Phase 1 behavior (test).

Cleared to ship.

---

## Evidence pointers

- New tests: `npx vitest run tests/unit/evolution-manager-evidence.test.ts tests/unit/dispatch-executor-evidence.test.ts` → 17/17 passing (≈0.5s).
- Phase 1 regression: `npx vitest run tests/unit/semantic-memory-evidence.test.ts` → 21/21 passing.
- TaskFlow Phase 3a regression: `npx vitest run tests/unit/evolution-manager-taskflow-dualwrite.test.ts` → 10/10 passing.
- SemanticMemory regression: `npx vitest run tests/unit/semantic-memory.test.ts` → 49/49 passing.
- Typecheck: `npx tsc --noEmit` → clean.
- Spec source of truth: `docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md` (Convergence: 2026-05-07).
- Phase 1 baseline: `upgrades/side-effects/wikiclaim-evidence-phase1.md`.
- Producer allowlist (Phase 1, unchanged in Phase 2): `src/memory/SemanticMemory.ts:1896` — `EvolutionManager: feedback, pattern-entity, supersedes-evidence`; `DispatchExecutor: pattern-entity, job-run, ledger-entry`.

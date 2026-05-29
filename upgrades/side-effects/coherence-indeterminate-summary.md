# Side-Effects Review — Coherence Gate indeterminate summaries

**Version / slug:** `coherence-indeterminate-summary`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `self-audit; subagent not spawned by tool policy`

## Summary of the change

This change updates `ScopeVerifier` so unbound topic-project alignment is
represented as `passed: null`, the overall `passed` flag is true only when every
check truly passed, and the summary reports passed, warning, error, and
indeterminate counts. It adds unit, integration, and e2e tests for the
indeterminate path. The decision point touched is the Coherence Gate's
pre-action warn/block/proceed response.

## Decision-point inventory

- `ScopeVerifier.check()` — modified — recommendation policy remains the same,
  while summary and top-level pass reporting now distinguish indeterminate
  checks from passed checks.
- `checkTopicProjectAlignment()` — modified — missing topic binding is now an
  indeterminate warning instead of a boolean false warning.

---

## 1. Over-block

No new block condition is introduced. Unbound topics remain warning-level and do
not become blockers. A caller that incorrectly treated top-level `passed: true`
as permission despite `recommendation: "warn"` will now see `passed: false`, but
that is the intended correction: the check did not actually pass.

---

## 2. Under-block

This does not add new blocking coverage. A topic with no binding still warns
rather than blocks, so an agent can still proceed after verification. Wrong
project bindings remain error-severity failures and still block.

---

## 3. Level-of-abstraction fit

This is at the reporting layer of an existing deterministic gate. The gate
already owns the pre-action recommendation. The change does not add a parallel
authority; it makes the existing gate's human-readable and machine-readable
fields agree.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context
  (LLM-backed with recent history or equivalent).
- [ ] Yes, with brittle logic — STOP. Reshape the design.

The existing Coherence Gate remains the authority for warn/block/proceed. This
change clarifies a structured signal state (`null` means indeterminate) and the
summary text derived from those signals. It does not introduce an independent
blocker.

---

## 5. Interactions

- **Shadowing:** No route or hook order changes. The same `/coherence/check`
  route calls the same `ScopeVerifier.check()` path.
- **Double-fire:** No new event or side effect is emitted.
- **Races:** No persistent state or asynchronous coordination is added.
- **Feedback loops:** Agents may respond more cautiously because `passed` is now
  false for indeterminate checks, matching the existing warning recommendation.

---

## 6. External surfaces

The `/coherence/check` JSON shape changes for unbound topics: the
topic-project-alignment check returns `passed: null`, and the top-level `passed`
field is false when any check is indeterminate. The recommendation field remains
unchanged. No database, file format, credential, network, or third-party
surface changes are introduced.

---

## 7. Rollback cost

Rollback is a normal hot-fix revert. There is no migration and no persistent
state repair. During rollback propagation, agents would temporarily see the old
misleading summary for unbound topics again.

---

## Conclusion

The change is narrowly scoped to truthful reporting for an existing warning path.
It keeps the Coherence Gate policy intact while removing an internal
contradiction that made summaries less trustworthy. The three-tier tests cover
the core logic, route response, and full server lifecycle.

---

## Second-pass review (if required)

**Reviewer:** `self-audit; subagent not spawned by tool policy`
**Independent read of the artifact: concur**

The main risk is API compatibility for callers that assumed `ScopeCheck.passed`
was always boolean. The route already had contradictory `passed` and
`recommendation` signals, and the requested contract explicitly uses
`passed: null` for indeterminate, so the compatibility cost is acceptable and
tested.

---

## Evidence pointers

- Live verification before the source change reproduced the bug: an unbound
  topic check returned `recommendation: "warn"` while the summary still claimed
  all four checks passed.
- Focused verification after the source change:
  `npx vitest run tests/unit/ScopeVerifier.test.ts tests/integration/coherence-routes.test.ts tests/e2e/coherence-check-indeterminate-lifecycle.test.ts`

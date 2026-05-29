---
title: External Operation Gate — action vocabulary alignment
slug: external-operation-action-vocabulary
date: 2026-05-29
author: codey
second_pass_required: false
---

## Summary of the change

The External Operation Gate endpoint already used `proceed` as its canonical
allowed action, but generated documentation described the action as `allow`, and
the generated PreToolUse hook accepted `proceed` only through an implicit
fallthrough path. This change aligns the docs and hook with the core gate:
`proceed`, `show-plan`, `suggest-alternative`, and `block`. The hook explicitly
permits `proceed`, keeps legacy `allow` compatibility, and blocks unknown action
values instead of silently proceeding.

Files touched include the hook generator in `PostUpdateMigrator`, generated and
source documentation, capability text, and unit/integration/e2e tests.

## Decision-point inventory

- `ExternalOperationGate.evaluate()` — pass-through — remains the authority and
  source of truth for emitted action values.
- Generated `external-operation-gate.js` hook — modified — explicitly maps
  `proceed` and legacy `allow` to permit; unknown actions now block.
- Generated/documented External Operation Safety guidance — modified — names
  `proceed` instead of `allow`.

---

## 1. Over-block

The new over-block risk is a gate response with a valid future action value that
this hook version does not recognize. The hook would block it. That is
intentional for this trust boundary: new action values must be added to the hook
and tests deliberately, rather than inheriting permission through fallthrough.

Legacy `allow` is accepted to avoid over-blocking stale local test doubles or
older endpoints during mixed-version windows.

---

## 2. Under-block

The main previous under-block was unknown action fallthrough. That is removed.
The remaining under-block is the existing designed fail-open path when the local
server is unreachable or the hook cannot parse input. This change does not alter
that broader availability policy.

---

## 3. Level-of-abstraction fit

The endpoint remains the authority for operation risk. The hook is the local
enforcement adapter that translates action words into command behavior. Keeping
legacy compatibility at the hook boundary is the right layer because it protects
mixed-version local installs without changing the core gate's canonical type.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change does not add a brittle detector with blocking authority.

The hook is already an enforcement authority at an external-service trust
boundary. This change narrows that authority's accepted action vocabulary to the
canonical gate contract, plus one explicit legacy alias. It does not introduce a
new heuristic signal.

---

## 5. Interactions

- **Hook install/migration:** existing installations receive the updated hook
  when the post-update migrator refreshes built-in hook content.
- **Mixed versions:** a hook updated before an endpoint still accepts legacy
  `allow`; an endpoint updated before a hook already worked because old hooks
  fell through on `proceed`.
- **Identity grounding:** irreversible writes that receive `proceed` still pass
  through the existing identity-grounding injection path before allowing the
  operation.
- **Read fast path:** read MCP calls still exit locally before calling the gate.

---

## 6. External surfaces

External-service MCP calls are affected. The successful endpoint action is
documented as `proceed`; callers that asserted the old documentation should
update. The hook's runtime behavior is stricter for malformed gate responses:
unknown actions now block non-read external operations instead of silently
running them.

No persistent state schema changes, no database migrations, and no external API
credentials are affected.

---

## 7. Rollback cost

Pure code and docs rollback. Revert the hook generator and docs/tests; no data
cleanup is needed. During rollback, `proceed` would again be permitted only by
unknown fallthrough in the hook, which is the behavior this change removes.

---

## Conclusion

The mismatch is reconciled by treating the core gate as authoritative and
pinning `proceed` as the canonical allowed action. The compatibility alias keeps
mixed-version behavior stable, while the unknown-action block removes the
silent-fallthrough safety gap. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

---

## Evidence pointers

- `tests/unit/ExternalOperationGate.test.ts`
- `tests/unit/hook-installation.test.ts`
- `tests/integration/external-operation-safety-routes.test.ts`
- `tests/e2e/external-operation-action-vocabulary-lifecycle.test.ts`

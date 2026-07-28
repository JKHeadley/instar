# Side-Effects Review — Unknown external-operation verbs reach the gate

**Version / slug:** `external-operation-unknown-verbs`
**Date:** `2026-07-10`
**Author:** `instar-codey`
**Second-pass reviewer:** `framework_guard_review`

## Summary of the change

`PostUpdateMigrator.getExternalOperationGateHook()` now defaults unmatched MCP action verbs to `modify` and grants the zero-round-trip read fast path only to an explicit, narrow allowlist. The same generated source reaches fresh installs, always-overwrite migrations, and Codex hook installs. Runtime tests execute the generated hook against a real gate endpoint and lock both sides of the boundary.

## Decision-point inventory

- Hook mutability detector — modify — unknown verbs emit `modify`; explicit reads emit `read`; known destructive prefixes retain their categories.
- Read fast path — constrain — only the explicit read vocabulary exits before the API.
- External Operation Gate authority — pass-through — continues to decide allow, plan, alternative, or block for every non-read classification.

## 1. Over-block

A novel but genuinely read-only MCP action whose first verb is absent from the allowlist incurs one gate round-trip and may receive the gate's normal approval workflow. The hook itself does not block it. This conservative cost is intentional: adding an ambiguous verb to the read fast path would recreate the safety bypass.

## 2. Under-block

The hook still relies on action-name vocabulary; a deliberately misleading connector action could avoid every known mutation token. Connector naming is not a semantic proof system. Compound names that begin with a read verb but contain a known mutating token are explicitly routed to the gate. The gate-unreachable and malformed-input fail-open postures remain byte-unchanged per task scope; this change closes classification bypass while preserving availability policy.

## 3. Level-of-abstraction fit

The hook remains a low-context detector. It classifies obvious verbs and routes uncertainty toward `ExternalOperationGate`, the existing context-rich authority. It does not add a second blocking decision. The inline vocabulary is necessary because the deployed hook is standalone; a lockstep comment points future editors at the server-side `computeRiskLevel` twin.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] The hook produces a conservative mutability signal consumed by the existing External Operation Gate authority.

Unknown verbs are not hard-failed. They become `modify`, reach `/operations/evaluate`, and receive the gate's normal policy/LLM decision. The only local bypass is the enumerated unambiguous-read fast path.

## 5. Interactions

- **Shadowing:** explicit reads still exit before gate evaluation; all other actions reach the same existing gate.
- **Double-fire:** each hook invocation makes at most one evaluation request; no new retry or secondary authority exists.
- **Races:** classification is pure per invocation and introduces zero shared state.
- **Feedback loops:** the change adds zero scheduling, retries, or self-triggered actions.
- **Deployment:** `migrateHooks()` always overwrites the built-in hook and init consumes `getHookContent`; Codex registration points at that same deployed file. The repository's local `.instar/hooks` runtime copy remains machinery-owned and is not hand-synchronized.

## 6. External surfaces

Unrecognized external-service action names now become visible to the operation gate and its existing audit/approval surfaces. Explicit reads and gate response formats remain unchanged. The change adds zero routes, configuration keys, credentials, persistent schemas, or operator forms.

## 6b. Operator-surface quality

Operator surface unchanged; this criterion is not applicable.

## 7. Multi-machine posture

**Machine-local by design:** each machine evaluates its local session's external tool call against its local gate and trust state. Deployment is fleet-wide through the normal update path, but runtime decisions remain machine-local security events. The change emits zero direct user notices, holds zero new durable state, leaves topic transfer unchanged, and generates zero URLs.

## 8. Rollback cost

Pure generated-hook and test rollback: revert and ship a patch. The next migration re-stamps the prior hook. There is no data migration or state repair; rollback would restore the unknown-verb bypass until the subsequent fix deploys.

## Conclusion

The hook now fails toward the authority rather than pre-judging unfamiliar vocabulary as safe. Independent review caught and corrected two boundary defects before commit: `purge` remains an existing delete classification, and compound read-prefixed mutators are excluded from the fast path by full-token inspection. The gate-unreachable posture is untouched and all three deployment consumers remain single-sourced. Clear to ship after revised concurrence and CI.

## Second-pass review

**Reviewer:** framework_guard_review
**Independent read of the artifact:** concur

The first review raised two boundary concerns: preserve `purge` as delete, and prevent read-prefixed compound mutators from bypassing evaluation. Both were corrected. Revised review confirms explicit read-leading verbs bypass only when every tail token is non-mutating; unknown standalone and adversarial compound verbs reach the authority, deployment stays single-sourced, and the reviewer's focused suite passed 14/14.

## Evidence pointers

- `tests/unit/hook-installation.test.ts`
- `tests/unit/ExternalOperationGate.test.ts`
- `tests/unit/installCodexHooks.test.ts`
- `tests/unit/codex-hooks-wiring.test.ts`

## Class-Closure Declaration

- `defectClass`: `novel` — proposed registry id `unknown-classification-fail-open`.
- `closure`: `gap`.
- `gap`: `ACT-001` tracks operator confirmation/refinement and class-wide recurrence standardization.
- `novelClass`: nearest existing class is `prompt-parser-contract-drift`; that class covers rendered prompt/parser contract mismatch, while this class covers unmatched runtime classifier input inheriting privileged-safe authority.

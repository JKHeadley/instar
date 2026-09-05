# Side-Effects Review — MR1 model-registry review application

**Version / slug:** `mr1-model-registry-review`

**Date:** `2026-08-18`

**Author:** `Instar Agent (instar-codey)`

**Second-pass reviewer:** `testing_integrity_review (Hilbert), MR1-B concurred`

## Summary of the change

This change updates reviewed frontier metadata and three existing routing values, adds the two vendor-established Claude 5 ids to the runtime closed enumeration, corrects the three contradictory registry notes, and adds `tests/unit/model-registry-runtime-resolution.test.ts`. The new CI ratchet extracts every manifest pin and invokes its owning resolver, closing the gap where freshness and drift were green while runtime resolution returned nothing. The freshness gate's script and configuration remain unchanged.

## Build-location and plan record

- Fresh worktree: branch `phaseb/mr1-model-registry-review` from `upstream/main` at `248ed7177f5bf416aa7bdad9763741478195e1fc`.
- Upstream remote: `https://github.com/JKHeadley/instar.git`.
- Package version: `1.3.1180`.
- Problem: the review date moved while stale frontier labels and source pins remained accepted.
- Fix: apply the reviewed manifest/source values, reconcile the closed Claude ids, and bind every manifest pin to a non-empty real-resolver result in CI.
- Acceptance: freshness passes; non-frontier drift mutation fails; removing the reviewed Claude id makes the runtime-resolution ratchet fail; targeted tests, type-check, and full lint pass.
- Rollback: revert this commit; there is no data migration.

## Decision-point inventory

- `anthropic-headless` capable-tier mapping — **modify** — deterministic choice of the concrete model for a capable request.
- `openai-codex` capable-tier mapping — **modify** — deterministic choice of the concrete model for a capable request.
- Claude tier-escalation default — **modify** — deterministic default model selected by the tier policy.
- Model-registry freshness input — **modify** — reviewed data consumed by the existing strict invariant check; gate logic is unchanged.
- Claude runtime closed enumeration — **modify** — accepts only the two additional ids established by the local vendor selector.
- Manifest-pin runtime-resolution ratchet — **add** — CI invokes every registered pin's owning resolver and rejects missing coverage, empty results, or mismatches.

---

## 1. Over-block

No issue identified after MR1-B. `claude-opus-5` and `claude-sonnet-5` are the only new closed-enum entries, both established by the local Claude Code v2.1.234 selector. Malformed and unreviewed ids remain rejected.

---

## 2. Under-block

The runtime-resolution ratchet proves source-level resolution and closed-enum acceptance; it does not live-invoke vendor CLIs or prove account entitlement. That remains correctly separate from deterministic CI. The test refuses any newly registered manifest pin without an explicit real-resolver mapping, so the checked population cannot silently grow beyond its coverage.

---

## 3. Level-of-abstraction fit

The three routing maps are the existing low-level owners of deterministic tier-to-model selection. The registry remains the reviewed source for frontier status. Runtime acceptability is checked at the test layer by calling the same resolver functions production uses, rather than duplicating their allowlist logic in the freshness lint.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no judgment-based block/allow surface.

The freshness lint has deterministic blocking authority over a narrow, enumerable invariant: a named source pin must belong to its reviewed doorway frontier set. MR1 changes the reviewed data and pin values, not the authority logic. The runtime closed enumeration is also a hard input-validation invariant, not a contextual judgment gate. No brittle interpretation of user intent is added.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point. Tier-to-model mappings and closed model enumerations are deterministic configuration invariants.

---

## 5. Interactions

- **Shadowing:** freshness/drift and runtime resolution remain separate properties, but CI now requires both to pass.
- **Double-fire:** no action is emitted by either check, so there is no double actuation.
- **Races:** the change is static source and manifest data; no concurrent mutable state is introduced.
- **Feedback loops:** none. Model selections do not write back into the registry.
- **Migration defaults:** `PostUpdateMigrator` reads `DEFAULT_TIER_ESCALATION_CONFIG`; its value-pinned test now asserts the reviewed new default.
- **Reviewer pin:** the clean-door reviewer remains `claude-fable-5` and its non-vacuity tests pass.
- **Manifest prose:** all three previously contradictory notes now describe the reviewed routing state and the documentation-only Gemini evidence honestly.

---

## 6. External surfaces

If deployed, capable anthropic-headless calls route to `claude-opus-5`, capable Codex calls through the changed adapter route to `gpt-5.6-sol`, and new/default tier-escalation configuration resolves `claude-opus-5` through the closed enum. This is an operator-visible routing change, not a documentation bump. Pricing values and persistent data formats are unchanged. No operator action, message format, URL, or external API contract is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated** — the manifest and source defaults ship in the same software release to every machine. There is no per-machine state, pooled read, or machine-local override added by MR1. The change emits no user-facing notices, holds no durable runtime state that could strand on topic transfer, and generates no URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert the value-only commit and ship the next patch.
- **Data migration:** none.
- **Agent state repair:** existing user configuration is not rewritten; generated defaults may retain the new reviewed id and should be inspected during rollback.
- **User visibility:** capable calls choose different reviewed models during any interval in which this code is deployed.

---

## Conclusion

MR1-B resolves both findings without changing the freshness gate: the vendor-established Claude 5 ids are accepted by the closed enum, the three notes match the reviewed behavior, and every manifest pin is now bound to a non-empty owning-resolver result in CI. The negative control fails behaviorally when `claude-opus-5` is removed, and all 129 targeted tests pass after restoration. The PR remains draft and unmerged for operator approval of the routing change.

---

## Second-pass review (required because the change modifies data consumed by a gate)

**Reviewer:** testing_integrity_review (Hilbert)

**Independent read of the artifact:** Concur with MR1-B review. The ratchet calls each registered pin's production resolver, enforces exhaustive pin coverage plus exact non-empty results, catches the prior Claude runtime-empty defect, and accurately distinguishes the three live routing changes from Gemini's documentation-only verification.

---

## Evidence pointers

- `scratchpad/phaseB/REPORT-MR1.md`
- `npm run lint:model-freshness` — pass after the reviewed edits.
- Required control: temporary Codex pin `gpt-5.5` — strict drift failure naming `codex-capable-tier`.
- MR1-B negative control — removing `claude-opus-5` makes `model-registry-runtime-resolution.test.ts` execute 6 tests and fail the Claude tier pin with `<empty>`; restoration passes 6/6.
- Expanded targeted Vitest run — 129 passed, 0 failed across 9 files.
- `npx tsc --noEmit` and `npm run lint` — pass.

---

## Class-Closure Declaration (display-only mirror)

`defectClass: instrument-semantic-darkness`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/model-registry-runtime-resolution.test.ts, howCaught: the test extracts every registered source pin and invokes its owning runtime resolver, so a fresh-and-drift-green Claude pin whose id is absent from the closed runtime enumeration returns empty and fails CI by pin name }`.

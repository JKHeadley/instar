# Side-Effects Review — observed standards enforcement proof execution

**Version / slug:** `w35-observed-enforcement-proof`
**Date:** `2026-08-18`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `Mencius (independent W3.5 second pass) — concurred`

## Summary of the change

This change replaces self-declared standards-enforcement run outcomes with independently observed execution. `scripts/lib/standards-enforcement-execution-verifier.mjs` materializes protected files, lands an exact protected mutation, runs the pinned observer clean, mutated, and clean again, and authenticates all three completed child exits with the H1 receipt core. The final pristine confirmation proves that discrimination resets instead of arising from host-global state. Child execution is bounded even when a descendant retains inherited output pipes. `scripts/lib/standards-enforcement-measurement.mjs` promotes strength only from a live authenticated artifact; `scripts/standards-coverage.mjs` awaits that boundary. Tests cover three hollow controls, inherited-pipe timeout, and one genuinely discriminating observer.

## Decision-point inventory

- `validProofRecord` — modify — accepts only a protected execution plan, relevance binding, and mechanical mutation; candidate-authored outcome fields invalidate the record.
- `verifyProtectedExecutionProof` — add — deterministically classifies three bounded observed executions as PROVEN, NOT-PROVEN, or UNKNOWN.
- `measureAnchoredEnforcement` — modify — promotes a reference only from a live H1-authenticated execution artifact.
- `standards-coverage` check — pass-through — consumes the stricter measurement result; its existing floor remains the blocking authority.

---

## 1. Over-block

Legitimate protected proofs using Vitest, npm scripts, multi-command pipelines, shell guards, or workspace inputs not enumerated in `workspaceRefs` do not receive credit under schema v3. The first supported runner is intentionally narrow: `node --test <observerRef>`. Each observer is bounded to 15 seconds and runs three times, which may reject a legitimate long-running proof as UNKNOWN and increases measurement cost. Existing live coverage does not regress because protected main contains no qualifying ledger records and already reports 0/88. Adding another runner requires its own trusted parser and controls rather than accepting arbitrary commands.

---

## 2. Under-block

The mechanism does not prove semantic relevance beyond the protected author's chosen subject and mutation; an independent judge must still decide whether those are the real property. A protected observer could deliberately inspect the mutated subject bytes and fail without representing the intended rule. The candidate cannot author that plan, every declared helper is continuity-bound, and clean/mutated runs cannot communicate through a shared workspace, but protected semantic review remains necessary. H1 authentication soundness is also a dependency under J7 re-certification; this change does not claim to repair that core.

---

## 3. Level-of-abstraction fit

Execution observation belongs inside the measurement boundary, below the coverage-floor authority. The new verifier reuses the H1 receipt primitive rather than implementing a second authentication scheme. The ledger supplies declarative protected inputs; the verifier supplies observed facts; the existing coverage calculation remains the only consumer that awards strength.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] Yes, as a hard-invariant validator over an enumerable domain, which the principle explicitly permits.

The boundary does not judge message meaning or intent. It enforces mechanics that can be enumerated: exact schema, exact protected bytes, exact command, exact landed replacement, actual child exits, equal test populations, and an assertion failure. Ambiguity fails to UNKNOWN/NOT-PROVEN and cannot raise authority. Semantic adequacy remains with the independent judge.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic resolves competing live signals. This is an invariant boundary: a proof either contains a permitted plan and produces authenticated discriminating executions or it does not. The assertion-output classifier is used only after a nonzero child exit and positive executed-test count; uncertainty refuses promotion.

---

## 5. Interactions

- **Shadowing:** schema v3 deliberately supersedes W3.4's schema-v2 narrative outcomes. No schema-v2 record is silently promoted.
- **Repeated execution:** candidate and protected-baseline measurements may replay the same protected plan separately. Within each measurement, clean, mutated, and confirmation observers use independent pristine workspaces under one in-memory authority; no workspace state or declared outcome is reused between directions. The third run detects host-global state that survives workspace isolation.
- **Races:** the observer is awaited to child exit or killed at the configured bound before receipt issue, mutation, or cleanup. Timeout kills the isolated process group, destroys the captured pipe readers, and emits no receipt or artifact. Cleanup goes through `SafeFsExecutor`; no direct destructive filesystem call remains.
- **Feedback loops:** execution artifacts are in-memory outputs, not inputs written back into the protected ledger. A measurement cannot certify itself for the next run.
- **Adjacent W4 work:** no shared verifier entry-comparison or authentication logic is edited. The exact certified H1 core is imported unchanged.

---

## 6. External surfaces

The standards coverage JSON gains per-reference observed execution summaries only when a schema-v3 protected plan exists. There is no user, Telegram, GitHub, Cloudflare, database, or operator-control action. The protected ledger schema changes from 2 to 3; no live schema-v2 file exists, so there is no migration of persisted records. Runtime duration increases only for future protected proofs that must execute three times, each with a bounded child lifetime.

The existing executable mode of `scripts/standards-coverage.mjs` is preserved, so direct callers retain the same launch surface.

No operator-facing actions are added or touched.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** the execution receipt, temporary workspace, and measurement artifact describe child processes on the machine performing that particular coverage run. No durable authority or cross-machine state is created. Every machine independently replays protected content and should reach the same classification, while receipt nonces and artifact hashes may differ per run. The change emits no user-facing notice, holds no durable state that can strand on topic transfer, and generates no URLs.

---

## 8. Rollback cost

Hot-fix rollback is a code revert. No data migration or agent-state repair is needed because schema-v3 plans are read-only protected inputs and execution artifacts are ephemeral. Rolling back would restore the known self-declaration defect and must not be represented as preserving machine verification.

---

## Conclusion

The review identified three intentional costs: the first runner supports only direct Node tests, each protected proof materializes three workspaces and runs three times per measurement, and each run is bounded. These are preferable to accepting arbitrary, stateful, hanging, or declared outcomes. The independent passes found and caused repairs for workspace-state leakage, host-global state leakage, auxiliary-input continuity, UNKNOWN vocabulary, cleanup lifecycle, and inherited-pipe hangs. The implementation now preserves the protected-side authority boundary, reuses H1 authentication, keeps UNKNOWN distinct from NOT-PROVEN, and leaves the live 0/88 headline honestly empty. The independent second pass concurs; independent judge evaluation remains required.

---

## Second-pass review (if required)

**Reviewer:** Mencius (`w35_second_pass`)
**Independent read of the artifact:** CONCUR. The reviewer found no remaining merge-blocking concern after two repair rounds. It specifically confirmed the three-run authenticated boundary, pristine reset, continuity binding, UNKNOWN/NOT-PROVEN vocabulary, exception-safe cleanup, descendant-pipe timeout, C3D coverage, honest three-run cost, semantic-review boundary, and provisional H1/J7 dependency.

---

## Evidence pointers

- `scratchpad/phaseB/REPORT-W35.md`
- `tests/unit/standards-enforcement-measurement.test.ts`
- `tests/unit/standards-coverage-ratchet.test.ts`

---

## Class-Closure Declaration (display-only mirror)

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/standards-enforcement-measurement.test.ts, howCaught: C3A, C3B, and host-external-state C3C execute real protected mutations plus a pristine confirmation; hollow claims remain NOT-PROVEN while only genuine assertion discrimination that resets cleanly promotes strength, and C3D proves inherited output pipes cannot defeat the UNKNOWN timeout }`.

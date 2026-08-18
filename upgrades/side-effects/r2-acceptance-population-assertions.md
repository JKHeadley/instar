# Side-Effects Review — R2 acceptance population assertions

**Version / slug:** `r2-acceptance-population-assertions`

**Date:** `2026-08-18`

**Author:** `Instar Agent (instar-codey)`

**Second-pass reviewer:** `r2_side_effects_review`

## Summary of the change

This change replaces ambiguous parity-result substring assertions in `scripts/check-phase-complete.cjs` and the Phase 4 acceptance manifest with a versioned, exact JSON population contract. `src/providers/parity/runner.ts` derives total/pass/fail/skip counts from the existing typed result array, and `_codex_paritytest.ts --json` emits that single summary. The gate still checks process exit independently. The manifest also replaces undeclared `npx tsx` execution with the lockfile-pinned `vite-node` entry and disables Vitest's mutable results cache.

## Decision-point inventory

- `scripts/check-phase-complete.cjs` phase gate — **modify** — a gate passes only when both exit semantics and any declared output contract hold.
- `scripts/lib/phase-acceptance-output.cjs` structured-output validator — **add** — parses one JSON document and returns a reasoned schema/declared-field match or mismatch to the existing phase gate.
- `specs/provider-portability/acceptance/phase-4.json` parity contracts — **modify** — require exact, typed populations for structural and real-API parity.

---

## 1. Over-block

Machine-readable mode rejects stdout containing a valid summary plus any additional text, and it rejects numerically equivalent strings such as `"7"` where the manifest requires number `7`. This is intentional for an exact machine contract: incidental progress logging on stdout would make evidence ambiguous. Human-readable mode remains available without `--json`, and stderr remains available for diagnostics. A future parity adapter that begins logging directly to stdout during `--json` would make the acceptance gate red until that output-contract regression is fixed; it cannot produce a false green.

---

## 2. Under-block

The summary establishes the number and status distribution of returned results; it does not cryptographically authenticate the parity runner and does not prove the seven scenario names are unique or equal a separately protected identity list. `expectJson` also permits undeclared additional properties for forward-compatible enrichment within a schema version; it applies exact typed equality only to manifest-declared fields. That is outside this acceptance gate's trust model: it executes the checked-out repository code as the release candidate. Within the stated R2 fault, malformed text, failure counts hidden by substring overlap, wrong schemas, wrong typed declared values, and empty populations all fail.

---

## 3. Level-of-abstraction fit

The typed result array is the lowest layer that already knows the complete scenario population. The CLI summarizes it once; the acceptance checker owns comparison against the manifest's release contract. Parsing is not duplicated in each manifest and the checker no longer tries to infer structured facts from presentation text. This is the correct producer/consumer boundary.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

Here, “equivalent” is the principle's explicitly allowed deterministic policy evaluator: this gate has blocking authority, but it does not judge natural-language meaning or competing contextual signals. The manifest declares exact primitive values and a schema; the validator performs typed equality over a fully enumerable boundary. This is the hard-invariant validation exception described by the principle, not a brittle semantic detector promoted to authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is applied at a competing-signals judgment point. The only decision is whether a machine document exactly satisfies a closed release contract. There are no liveness, ownership, urgency, or conversational signals to arbitrate.

---

## 5. Interactions

- **Shadowing:** exit-code comparison still runs first. The JSON assertion independently rejects a structured failure when the fixture deliberately exits zero, proving it is not shadowed in the direction it exists to guard.
- **Double-fire:** a command with both `expectJson` and `expectStdoutContains` would have to satisfy both; Phase 4 declares one output form per gate.
- **Races:** the checker remains synchronous per command and holds no shared state. The manifest now passes `--no-cache` to both Vitest gates. The first pre-flag proof exposed one scheduling-cache write; it was preserved and measured rather than erased. Final proof boundaries compare it unchanged.
- **Feedback loops:** none. A failed acceptance check reports and exits; it does not retry or mutate release status.

---

## 6. External surfaces

The parity CLI gains a developer-facing `--json` output mode, and Phase 4 acceptance diagnostics now name JSON/schema/field mismatches. There is no user messaging, network protocol, persistent data schema, external API call, or operator action. The real-API parity command is not executed during structural verification and no credentials are read by R2's controls.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design:** acceptance execution observes the checked-out code and dependencies on the machine performing the release check. The contract itself is committed and therefore replicated through Git; run output is ephemeral evidence for that machine. This change emits no user-facing notices, holds no durable agent state, and generates no URLs, so one-voice gating, topic-transfer repair, and cross-machine URL survival do not apply.

---

## 8. Rollback cost

Pure code/config rollback: revert the checker helper, JSON reporter, and manifest fields and ship the next patch. No database, ledger, agent state, credential, or migration is created. During rollback the old acceptance assertion would again be latent and exit-code-masked; no cleanup is needed.

---

## Conclusion

The review found two material adjacent inputs and changed the build accordingly: the manifest's unpinned `npx tsx` hop was replaced by pinned `vite-node`, and an observed shared Vitest scheduling-cache write led to explicit `--no-cache` wiring. The resulting gate enforces a closed, enumerable policy over schema identity and declared fields at the correct layer, while allowing undeclared enrichment fields, and independently rejects failed and empty populations even when exit code is zero. The independent review's initial concern about describing the entire JSON shape as closed was resolved by making that forward-compatibility boundary explicit.

---

## Second-pass review (required)

**Reviewer:** `r2_side_effects_review`

**Independent read of the artifact:** concur after one correction.

The first read raised that “closed JSON shape” was inaccurate because undeclared enrichment properties are allowed. After the artifact and report were corrected to state exactness over schema identity and manifest-declared fields, the reviewer concluded: “Concur with the review — declared-field exactness, conjunctive exit semantics, shared-cache handling, and deterministic hard-invariant authority are now accurately characterized.”

---

## Evidence pointers

- `tests/unit/phase-acceptance-population.test.ts`
- `scratchpad/phaseB/REPORT-R2.md`

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `claim-vs-evidence`
- **`closure`** — `guard`
- **`guardEvidence`** — `{ enforcementType: gate, citation: tests/unit/phase-acceptance-population.test.ts, howCaught: marker-backed exit-zero fixtures prove that a bare text claim of "10 fail" and a structured zero-result claim are rejected, while the exact seven-result document passes }`
- **`component`** — `phase-acceptance-population`

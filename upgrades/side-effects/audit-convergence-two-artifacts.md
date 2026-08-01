# Side-Effects Review — Audit Convergence Two Artifacts

**Version / slug:** `audit-convergence-two-artifacts`
**Date:** `2026-07-31`
**Author:** `Instar-codey`
**Second-pass reviewer:** `Socrates (independent adversarial review) — concurred after four review passes`

## Summary of the change

Adds the sixth audit-convergence condition: a converged report must preserve both the concrete fix/prevention path and a digest-bound causal meta-insight, and must identify a stable Standards Registry article response as `created`, `amended`, or `no-change`. The shared validator, staged precommit gate, and CI ratchet corroborate the response against change-local repository snapshots. A shared constrained Markdown parser keeps runtime, build-time coverage, and audit evidence on one grammar. The sole stamped report is backfilled, the iterative-audit skill is upgraded for new and exact-stock existing installs, and customized skill copies remain untouched.

## Decision-point inventory

- `validateAuditReport` convergence stamp — **modify** — adds enumerable schema, digest, path, article-identity, and change-evidence invariants.
- `instar-dev-precommit` staged audit check — **modify** — supplies HEAD/index evidence for a newly added or changed response identity.
- `audit-convergence-reports` CI ratchet — **modify** — supplies merge-base/head or push-range evidence and emits the merged response inventory.
- `standard-response-kind` choice — **add** — exposes a reviewer judgment among a closed three-value action space; structural gates corroborate the chosen claim but do not decide semantic adequacy.
- iterative-audit skill migration — **modify** — upgrades only an exact previously shipped stock digest; customized copies are preserved.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The new condition intentionally rejects a previously valid convergence stamp when the report lacks the new causal fields/section, names a standards file outside the repository jail, points at a non-regular/untracked snapshot, or claims created/amended without a same-change article-block delta. The sole existing stamped report is backfilled in the same change, so the repository-wide ratchet does not strand historical state. A legitimate report whose author only improves causal prose keeps the same response digest and does not require gratuitous Standards Registry churn. A legitimate “the standard was already adequate” conclusion uses the first-class `no-change` path.

The migration can under-upgrade a locally edited old skill copy, but that is deliberate preservation rather than over-block: only the exact stock V1 digest is rewritten automatically.

---

## 2. Under-block

**What failure modes does this still miss?**

The validator cannot prove that causal prose is insightful or that the reviewer chose the semantically best response kind. It proves bounded structure, exact article identity, current uniqueness, and change-local evidence. Semantic adequacy remains visible reviewer judgment. Stable Article IDs are checked for uniqueness in the candidate snapshot, not against a historical allocation ledger; a malicious delete-and-reuse in one change can therefore be structurally possible but remains exposed in the ordinary diff. Direct pushes get structural validation and a before/after range where available, but no mechanical claim of human semantic review.

The `no-change` repetition threshold is advisory only. It emits a warning at the earliest repetition and never pretends a count can amend constitutional meaning.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The shared Markdown core is the lowest-level grammar primitive. Runtime and build-time consumers derive their distinct models from it. The validator is the structural authority over the narrow `converged:` claim because its domain is enumerable: field presence/bounds, digests, jailed tracked snapshots, stable article identity, and exact base/candidate block deltas. The PR reviewer remains the context-rich authority over causal quality and whether created/amended/no-change is substantively correct. No keyword detector decides the semantic question.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — the blocking portion enforces closed structural invariants; the semantically brittle signals are surfaced to the existing PR-review authority.

The validator may refuse a convergence stamp, but it does not refuse the audit report or the underlying fix. Its error explicitly preserves the honest incomplete state. The created/amended/no-change choice and repeated-no-change warning feed review; neither is mechanically inferred or auto-amended.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

The structural checks are invariants, not competing-signal heuristics. The semantic choice is explicitly modeled as a judgment point with a floor: the action space is closed to three values, unverifiable evidence defaults to incomplete, and the audit PR reviewer is the named arbiter. The inventory threshold only raises a reviewer question and has no block or amendment authority.

---

## 5. Interactions

- **Shadowing:** secret scanning still runs independently; a failed meta-artifact validation cannot hide a credential finding in the CLI. The precommit gate reads staged bytes, while stamp mode reads worktree bytes, so neither snapshot can counterfeit the other.
- **Double-fire:** precommit and CI deliberately repeat the same shared validation at different trust boundaries. They do not mutate reports; only explicit stamp mode writes, using an atomic replacement and final-byte structural revalidation.
- **Races:** stamp mode derives and writes in one foreground process. It cannot provide a cross-process lock, but atomic rename prevents a torn report. Precommit and CI consume immutable Git snapshots.
- **Feedback loops:** inventory output is observational. It neither rewrites standards nor changes future validator thresholds.
- **Parser parity:** the new dependency-free article core is packaged into isolated fixtures and consumed by the runtime parser and coverage generator, preventing three independent heading grammars from drifting.

---

## 6. External surfaces

- **Existing agents:** exact stock iterative-audit skill copies upgrade on the next migration; customized copies are preserved and reported as skipped.
- **Fresh agents:** the shared built-in skill constant carries the new contract.
- **Users/reviewers:** check/stamp output prints the response kind, with a distinct `NO-CHANGE` banner; CI logs class/kind inventory and stale-reference or repetition warnings.
- **Persistent state:** audit Markdown, Standards Registry metadata, and installed skill files are the only durable changes. No database or network state is added.
- **External systems:** GitHub CI receives explicit event/base/head SHA inputs; no third-party service or new credential surface is introduced.
- **Operator surface:** no operator-facing action or dashboard surface is added.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** The behavior ships in versioned repository code, documents, and skill content, so each machine receives the same validator and stock-skill migration through the ordinary update path. The feature emits no autonomous user-facing notice, holds no machine-local durable runtime state, and generates no URLs. Git snapshots are the coherence source for precommit/CI evidence; per-machine worktree state is intentionally relevant only to explicit local stamp mode.

---

## 8. Rollback cost

A hot-fix can revert the validator, parser, hook/CI wiring, registry metadata, and skill migration. Reports that already gained the additional fields remain readable Markdown; the older validator ignores the extra keys. Existing agents whose exact stock skill was upgraded retain the newer instructions after a code-only rollback unless a reverse migration is intentionally shipped, but no customized copy is overwritten and no data repair is required. During propagation, newer agents may demand the sixth condition while older agents do not; CI remains the merged-state authority.

---

## Conclusion

The change is structurally bounded and honest about the remaining semantic judgment. It turns a convergence stamp from “the listed findings closed” into evidence that the audit also captured why the class escaped and what happened to the governing standard, without forcing ceremonial constitutional churn. Independent review caused five concrete hardenings: the CLI now reads the validated top-level response kind; CI derives file type from exact Git tree modes and has synthetic advanced-base, multi-commit push, stale response-only PR, and manual-run lifecycle coverage; fenced-content parsing binds closing delimiter kind and minimum length; legacy bootstrap rejects ID replacement plus duplicate-title ambiguity; and manual workflow dispatch supplies an honestly empty change context. The first CI run then exposed four isolated precommit fixture families whose copied dependency set omitted the new shared parser; those fixtures now copy the complete validator dependency and their 49 exact tests pass. Compile, lint, and the 112 focused implementation tests are green. The required independent second pass concurs that the change is ready to commit.

---

## Second-pass review (if required)

**Reviewer:** Socrates
**Independent read of the artifact:** concur

Concur with the review. The workflow/manual-context handling is correct; the real synthetic Git lifecycle validates multi-commit push evidence and rejects stale-delta borrowing in a later response-only PR; the lexical/realpath containment split is sound; and the focused ratchet suite passes.

---

## Evidence pointers

- Spec: `docs/specs/audit-convergence-two-artifacts.md`
- Convergence report: `docs/specs/reports/audit-convergence-two-artifacts-convergence.md`
- Validator tests: `tests/unit/write-audit-convergence.test.ts`
- Snapshot/CI ratchet: `tests/unit/audit-convergence-reports.test.ts`
- Migration tests: `tests/unit/PostUpdateMigrator-auditMetaArtifact.test.ts`
- Shared-parser packaging: `tests/unit/standards-registry-asset.test.ts`

---

## Class-Closure Declaration (display-only mirror)

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: gate, citation: scripts/write-audit-convergence.mjs#validateAuditReport, howCaught: a report cannot retain or earn converged when its claimed causal learning and Standards Registry response lack digest-bound structure and the required change-local corroboration; the precommit and CI consumers invoke this same guard against staged and merged snapshots }`.

# Side-Effects Review — Class-Closure Gate (increment 1: registry + report-only lint)

**Version / slug:** `class-closure-gate`
**Date:** `2026-07-03`
**Author:** `echo`
**Second-pass reviewer:** `CONCUR — no material concern (independent reviewer subagent, 2026-07-03)`

> **Second-pass verdict (independent reviewer):** CONCUR — no material concern. Report-only
> guarantee holds on every policy path (`class-closure-lint.mjs:271-272`: exit is nonzero only
> when `enabled && !dryRun && hardViolations>0`; shipped defaults → exit 0 unconditionally,
> confirmed on all four paths + a malformed-registry probe). Signal-only: no `docs/proposals`
> writer, no attention-item producer, no `STANDARDS-REGISTRY.md` write in increment 1 (the sole
> registry reference is a read-scope predicate). Scope honest: `escalatorDrafting` is plumbed
> but never read (inert reserved key, not a half-built feature); the new TS has zero runtime
> callers; the declare mutator is in no CI workflow. Drift guarded: both grader/registry parity
> suites exist and pass. Interactions clean (complementary to `decision-audit-gate`, not
> shadowing). Two minor non-blocking notes: (1) the CLI entrypoint lacks a top-level try/catch,
> but all fs reads are individually try/caught so no throw on the real paths — inherent CI-script
> fragility, not a policy path; (2) the config-default backfill claim is moot because an absent
> key resolves to the report-only default. Neither requires a change before commit.

## Summary of the change

Increment 1 of the Class-Closure Gate (`docs/specs/class-closure-gate.md`, converged + approved). Ships **CI tooling only — no runtime gates**: a class registry (`docs/defect-classes.json`), a pure count/threshold library (`src/core/DefectClassRegistry.ts`), a self-contained guard grader (`scripts/lib/class-closure-grader.mjs`, mirroring `StandardsEnforcementAuditor`'s classification with a pinned parity test), a **report-only** PR-gate lint (`scripts/class-closure-lint.mjs`) that validates the class-declaration field-set on instar-dev decision-audit entries for fixes touching agent-authored artifacts, derives per-class recurrence counts (deduped by PR#), and LOGS any deterministic escalation-threshold crossing. A CI workflow (`.github/workflows/class-closure-gate.yml`) runs the lint report-only. Config-gated (`prGate.classClosure = {enabled, dryRun, escalatorDrafting}`, defaulting off/dry-run) and repo-gated (no-op on installs without `docs/defect-classes.json`). The escalator's LLM drafting arm, the `docs/proposals/*` writer, the attention-item producer, the runtime read route, and the consolidated axis-requirements ratchet are the spec's OWN dark **increment 3** — explicitly out of scope here, not orphan deferrals.

## Decision-point inventory

- `scripts/class-closure-lint.mjs` (CI PR-gate lint) — **add** — a build-time SIGNAL (report-only → later enforcing) that a fix to an agent-authored artifact carries a valid class declaration; feeds the operator, never a runtime allow/deny.
- Deterministic recurrence trigger (inside the lint, via `computeEscalation`) — **add** — LOGS a threshold crossing; the acting-on-it (draft proposal + attention item) is increment 3.
- `guardEvidence` grading (`evaluateGuardClosure`) — **add** — downgrades a `closure:guard` declaration to `gap` when the cited guard does not resolve to a live enforcing guard (ratchet/gate/lint). Report-only in increment 1.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Increment 1 is **report-only** (`dryRun:true` default) — the lint ALWAYS exits 0 for declaration-content findings; it cannot reject any PR. The only nonzero exit is reserved for a hard structural violation (malformed registry JSON, a `novel` class with no semantics) AND only when `enabled && !dryRun` — which is a later increment's flip. So: **no over-block surface in increment 1.** (When the enforcing flip lands later, a legitimate fix whose guard citation doesn't resolve is not "blocked" — it downgrades to `closure:gap`, a valid tracked terminal state, per spec.)

---

## 2. Under-block

**What failure modes does this still miss?**

- A fix that bypasses the instar-dev gate entirely (no decision-audit entry) carries no `classClosure` block to validate. That bypass is caught separately by the existing `decision-audit-presence-check` at the PR boundary; this lint does not duplicate that.
- **Classification accuracy** — an author who mislabels a defect's class (or picks a self-serving hyper-narrow class) is not caught here; the spec routes that to the escalator's periodic spot-check audit (increment 3) and to operator confirmation of `novel` classes. Increment 1 measures population/accuracy honestly during dryRun rather than enforcing.
- Recurrence inside a single component below K=5 at normal severity does not escalate (by design — distinguishes a systemic pattern from one noisy component).

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes — a **CI PR-gate lint** in the same family as `decision-audit-gate`, `eli16-pr-gate`, `release-fragment-gate`. It is a SIGNAL producer at the build boundary, not a runtime authority, and it **reuses** the existing `StandardsEnforcementAuditor` grading logic (via a self-contained `.mjs` mirror pinned equivalent by a parity test, because PR-gate lints run on a fresh checkout with no build step) rather than re-implementing guard classification. The count/threshold math lives in a pure, unit-tested library (`DefectClassRegistry.ts`). No higher gate already does class-level closure; no lower primitive is being duplicated.

---

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or produce a signal that feeds a smart gate?** (`docs/signal-vs-authority.md`)

**COMPLIANT — signal only.** The report-only lint emits a green/annotation signal; it holds no blocking authority in increment 1. The deterministic trigger only LOGS crossings. The downstream escalator (increment 3) drafts a *proposal* and raises an *attention item* — it has **no write path to `STANDARDS-REGISTRY.md`**; adoption is the operator's (Agent Proposes, Operator Approves). No brittle check is given blocking authority; the one place enforcement is later added (the flip) is a deterministic structural validation (registry well-formedness, declaration presence/shape), not a semantic judgment.

---

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, race with adjacent cleanup?**

- Rides the PR-gate workflow family alongside `decision-audit-gate.yml`/`eli16-pr-gate.yml`/`release-fragment-gate.yml`. It reads the SAME decision-audit entries as `decision-audit-presence-check` but a DIFFERENT field (`classClosure`) — no shadowing, no double-fire (presence-check asserts an entry EXISTS; class-closure validates the entry's declaration content).
- The self-contained grader mirror could DRIFT from `StandardsEnforcementAuditor.gradeGuardCitation`/`classifyFileGuard` — mitigated by a pinned parity test that fails if they diverge (Structure > Willpower).
- Counts derive from decision-audit entries **only** (deduped by PR#); the side-effects mirror is display-only and never summed — prevents the round-3 double-counting finding.

---

## 6. External surfaces

**Does it change anything visible to other agents, other users, other systems?**

- Adds one new CI check named `class-closure` to PRs against `main` (green + optional annotations). Report-only, so it can never block a merge in increment 1.
- Adds a config key `prGate.classClosure` (off/dry-run default).
- Adds an author helper `scripts/class-closure-declare.mjs` (stamps a `classClosure` block onto a decision entry).
- No agent-to-agent, Telegram, or dashboard surface in increment 1 (the attention-item producer is increment 3). No dependence on runtime/conversation state — the lint is a pure function of the repo checkout + the PR diff.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated / proxied-on-read / machine-local-by-design?**

**Replicated — via git (the repo IS the replication medium).** The class registry, the `classClosure` declarations (in committed decision-audit entries), and (later) proposal files are all committed to the canonical repo and therefore identical on every machine. Dedup is **repo-state**, never machine-local JSONL, so two machines cannot double-file or double-count. Increment 1 runs entirely in GitHub Actions (not per-machine), so it holds no machine-local runtime state. No user-facing notice (no one-voice concern), no durable per-machine state to strand on topic transfer, no generated URL. The spec declares this posture explicitly ("Multi-machine posture (declared)").

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivial and safe. The lint is **report-only + config-gated (`prGate.classClosure` defaults off/dry-run) + repo-gated** — a buggy lint cannot block a merge (it exits 0 in dryRun) and is a no-op on any non-maintainer install. Back-out options, cheapest first: (a) leave defaults (already inert); (b) revert `.github/workflows/class-closure-gate.yml`; (c) revert the whole PR — no data migration, no agent-state repair, no runtime behavior to unwind (no runtime routes added in increment 1). The added `src/core` code is pure libraries with no callers in the runtime path yet.

## Follow-up note — no-silent-fallbacks ratchet

`DefectClassRegistry.ts` (`readDecisionDeclarations` absent-dir catch) and
`StandardsEnforcementAuditor.gradeGuardCitation` (unresolvable-path catch) are pure
libraries over a repo checkout with **no runtime / DegradationReporter surface** — their
fail-closed catches return the correct answer (empty list / `resolved:false`, which the
caller surfaces as a `gap` downgrade), not a degraded result. Both are tagged
`@silent-fallback-ok` so the `no-silent-fallbacks` ratchet holds at baseline 491 rather than
demanding a runtime degradation-report the library layer cannot emit.

# Side-Effects Review — Apprenticeship Step 1: Program Scaffold

**Version / slug:** `APPRENTICESHIP-STEP1-PROGRAM-SCAFFOLD-SPEC`
**Date:** `2026-06-01`
**Author:** `echo`
**Second-pass reviewer:** `not required` (converged: 5 internal reviewers + codex gpt-5.5, 3 rounds)

## Summary of the change

Builds Step 1 of the Apprenticeship Program (Tier-3 umbrella #675). Adds the minimal program
scaffold: an instance-as-project registry + two lifecycle gates (the **retro-gate** = a new
instance can't transition `pending→active` until the prior instance's retro-harvest validates;
the **doc-gate** = an instance can't transition `active→complete` until its required artifacts are
verified present from live state) + the role model. Relocates the Step-0 validator's pure logic to
`src/core/retroHarvestValidator.ts` (so it's an in-process typed import — the `src`→`scripts/.mjs`
import the convergence caught couldn't compile).

## Decision-point inventory

Two structural gates (`evaluateStartGate`, `evaluateCompletionGate`) + the status transition table.
Per Signal vs Authority / The Body and the Mind (spec §3.6), these are **structural preconditions on
OBJECTIVE artifacts** (does a validated harvest exist? is there an instance-scoped ledger entry?) —
NOT quality judgments. The *quality* call (did the mentor internalize the lessons / was the audit
real) stays with the overseer. Every gate verdict is appended to `logs/apprenticeship-decisions.jsonl`.

## 1. Over-block

**What legitimate inputs does this reject?** A `pending→active` transition with no valid prior/bootstrap
harvest; an `active→complete` with a missing required artifact; an illegal status transition; a
duplicate or bad-charset instance id; a `partial-accepted` harvest with no acceptance metadata. All
are genuine preconditions. The gates are scoped to the program's own instance lifecycle — they never
block a global action.

## 2. Under-block

**What does this still miss?** The retro-gate enforces *structural* validity only — it trusts the
harvest's recorded `fidelityReview` stamp (Step 0's independent review was the authority); a forged
stamp is not re-caught here (stated, §3.3). The doc-gate verifies artifact *presence* from live state,
not artifact *quality*. `requiredArtifacts` is the checklist definition; truth is always re-derived
from injected deps, never a stored boolean.

## 3. Level-of-abstraction fit

**Right layer?** Yes. `ApprenticeshipProgram` is a `src/core` module over a file-based JSON store
(the `CommitmentTracker` atomic-write + CAS pattern), gates are pure + unit-tested, routes are a
nullable `RouteContext` field with the standard 503-guard, wired in `AgentServer`. The validator
relocation matches the `BackfillCore` precedent (pure logic in `src/`, the `.mjs` re-exports for CLI).

## 4. Testing

- **Unit** (`tests/unit/apprenticeship-program.test.ts`, 29): both gates both sides; the status table
  (legal/illegal/`complete`-terminal); charset clamp + dup-reject; path-confinement (a traversal
  `harvestRef` is ignored, canonical path used); wiring-integrity (injected deps real, not no-ops);
  `partial-accepted` with/without acceptance. Plus the validator's 33 cases (repointed to the TS source).
- **Integration** (`tests/integration/apprenticeship-routes.test.ts`, 10): the routes incl.
  auth-negative (no/wrong token → 401/403), create→transition gating, the decision-audit line.
- **E2E** (`tests/e2e/apprenticeship-lifecycle.test.ts`, 3): Phase-1 "feature is alive" —
  `/apprenticeship/instances` returns 200 through the production `AgentServer` init path.
- Verified independently: `tsc --noEmit` clean; 62 unit + 15 integration + 3 e2e green; `pnpm build` ok.

## 5. Migration Parity + Agent-Awareness

- **Agent-Awareness:** added to **both** `generateClaudeMd()` (new agents) AND a `migrateClaudeMd()`
  content-sniff entry in `PostUpdateMigrator` (existing agents) — idempotent, shares the
  `**Apprenticeship Program**` marker so freshly-init agents aren't double-patched.
- **Migration Parity:** `.instar/apprenticeship/instances.json` is runtime state (no migration). No
  config flag (the scaffold is additive + passive + actively needed this run — decided, not conditional).
- **Bootstrap harvest:** `acceptedBy: justin` + `acceptedAt` added to `echo-to-codey-mentorship.md`
  (Justin approved Step 0 which contained it) so the retro-gate's `partial-accepted` rule passes; still
  validates.
- **Publish:** touches `src/core` + `src/server` + `src/scaffold` → a `NEXT.md` publish fragment is
  added (`upgrades/next/apprenticeship-step1-program-scaffold.md`, minor bump).

## 6. Rollback
Revert the commit; `.instar/apprenticeship/instances.json` is runtime state with no migration to undo;
the validator relocation is behavior-preserving (Step-0 tests pass against the relocated logic).

## 7. Follow-up (CI fix)
The `capabilities-discoverability` lint requires every new route prefix to be classified. The
`/apprenticeship` prefix is **agent-facing**, so it is added to `CAPABILITY_INDEX` in
`src/server/CapabilityIndex.ts` (surfaces in `/capabilities`) rather than `INTERNAL_PREFIXES`. No
new behavior — classification metadata + the endpoint list for discovery.

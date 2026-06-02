# Side-Effects Review — Apprenticeship Step 0: Retro-Harvest

**Version / slug:** `APPRENTICESHIP-STEP0-RETRO-HARVEST-SPEC`
**Date:** `2026-06-01`
**Author:** `echo`
**Second-pass reviewer:** `not required` (converged via /spec-converge: 5 internal reviewers + codex gpt-5.5, 3 rounds)

## Summary of the change

Builds Step 0 of the Apprenticeship Program (Tier-3 umbrella #675). Ships:
- `scripts/validate-retro-harvest.mjs` — the pure, offline schema validator (the structural
  SIGNAL) for `apprenticeship-retro-harvest/v1` artifacts, plus an optional injected-fetch
  live-ledger cross-check.
- `tests/unit/validate-retro-harvest.test.ts` (34 cases, both sides of every boundary) +
  `tests/integration/retro-harvest-artifact.test.ts` (the real artifact as a fixture-of-record).
- `docs/apprenticeship/RETRO-HARVEST-PROCEDURE.md` — the repeatable how-to.
- `docs/apprenticeship/retro-harvests/echo-to-codey-mentorship.md` — the first real harvest,
  grounded in the live ledger (28 issues), reviewed by an independent fidelity reviewer.
- `docs/apprenticeship/retro-harvests/INDEX.json` — the latest-harvest pointer.

No `src/` is touched. The validator is a standalone `scripts/` tool not imported by `src/`.

## Decision-point inventory

One: the validator's pass/fail boundary (`validateRetroHarvest`). It is a **signal**, not an
authority (spec §9) — it asserts artifact SHAPE (schema, required fields, count/programNeeds
reconciliation, coverage-extent, scope/completeness rules, evidence-pointer well-formedness,
a limited secret-pattern backstop, path confinement, an approved+succeeded scrub, and a
non-`rejected` fidelity verdict). It does NOT judge harvest fidelity — that is the independent
LLM fidelity review, recorded in the artifact frontmatter.

## 1. Over-block

**What legitimate inputs does this reject?** A structurally malformed artifact (missing fields,
counts that disagree with the body, an incremental first harvest, a `complete` artifact with a
truncated source, an unapproved/failed scrub, a `rejected` fidelity verdict, a secret-shaped
string, a malformed pointer). All are genuine defects the gate is meant to refuse. Trailing
sentence punctuation after a pointer is tolerated (stripped before validation) so a clause-
boundary pointer is not falsely rejected.

## 2. Under-block

**What does this still miss?** By design, the validator does NOT judge whether the harvest is
*truthful or complete* — a well-shaped but hollow harvest passes the validator; the LLM fidelity
review is the authority that catches that (Signal vs Authority). The secret-pattern scan is an
explicit *limited backstop*, not a scrub guarantee (it misses API keys, hostnames, sig-less
URLs, names, phone numbers, contextual PII); the authoritative defense is the approved scrubber.
Live-ledger resolution of seeded ids runs only under `--check-live` / the integration path, not
the pure unit path.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The validator is a pure function with a thin CLI guard, in `scripts/`
beside the other repo-invariant validators, unit-testable with no git/fs/network mocking. The
harvest artifact + procedure + index are plain repo docs under `docs/apprenticeship/`. The gate
that will *require* a valid harvest before an instance starts is deliberately deferred to Step 1
(spec §12–13) — this step ships the artifact + the validator the gate will call.

## 4. Testing

- **Unit** (`tests/unit/validate-retro-harvest.test.ts`): 34 cases — valid baseline + a targeted
  failing mutation per decision boundary + `checkLiveLedger` with an injected fetch.
- **Integration** (`tests/integration/retro-harvest-artifact.test.ts`): the REAL
  `echo-to-codey-mentorship.md` validates against the REAL validator; it is a full first harvest
  with an independent (non-Echo) fidelity reviewer; seeds nothing (#50-independent); is INDEX-
  registered.
- **E2E:** genuinely n/a — pure CLI validator, no HTTP route, no DI (spec §9, §11).

## 5. Migration / rollback / Agent-Awareness

- **Migration Parity:** N/A. No agent-installed files (`.claude/`, `.instar/config.json`, hooks,
  skills, CLAUDE.md template), no config defaults, no `src/`. Pure repo docs + one `scripts/`
  helper + tests.
- **Rollback:** revert the commit; nothing is deployed to agents, no state is written.
- **Agent-Awareness:** explicitly deferred to Step 1 (spec §12) — the awareness surface ("a valid
  harvest is required before an instance starts") belongs with the gate Step 1 wires, not before
  it exists.
- **NEXT.md / publish:** no `src/` change → no fleet-release/publish concern.

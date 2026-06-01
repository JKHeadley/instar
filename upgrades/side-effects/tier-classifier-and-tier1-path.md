# Side-Effects Review — Tier classifier + Tier-1 PR path (Step A)

**Slug:** `tier-classifier-and-tier1-path`
**Date:** 2026-06-01
**Author:** echo
**Spec:** `docs/specs/tier-classifier-and-tier1-path-spec.md` (approved by Justin + abbreviated convergence)
**Project:** Step A of the Tiered Development Process (`docs/projects/tiered-dev-process/PROJECT.md`)

## Summary of the change

Teaches the instar-dev commit gate to (1) compute + print a **tier signal** (size + risk),
(2) let the agent **declare** the tier in its trace, (3) enforce the **chosen** tier's
requirement set — adding a **Tier-1 path** (ELI16 + side-effects, no pre-approved
converged spec) — and (4) **audit** every decision. First executable instance of the
constitution's *The Body and the Mind*: the gate informs, the agent decides, the decision
is recorded. Strictly additive: a commit with no declared tier behaves exactly as before.

**Files changed (in-scope):**
- `scripts/lib/classify-tier.mjs` (NEW) — pure `classifyTier({inScopeFiles, addedLines,
  deletedLines, addedDiffText})` → `{suggestedTier, sizeTier, riskFloor, reasons}` +
  `decideRequirementSet(declaredTier)`. Size tier (≤40 LOC / ≤3 files = 1). Risk floor
  raised by safety-invariant proximity, irreversibility, migration/fleet-rollout, and
  (diff-text-gated) new-capability. `suggestedTier = max(size, risk)`, never 3.
- `scripts/instar-dev-precommit.js` — Step 3.5 computes + prints the signal (via
  `git diff --cached --numstat`); Step 4.5 reads `trace.tier`/`trace.tierReasoning`,
  routes via `decideRequirementSet`, writes one audit line to
  `.instar/instar-dev-decisions.jsonl` (incl. `riskFloor` + `belowFloor`), and runs the
  Tier-1 path (`enforceTier1`: staged ELI16 + side-effects, sha-matched) when `tier===1`.
  **Tier-2/3/no-tier fall through to the existing Steps 5–8 unchanged.**
- `skills/instar-dev/scripts/write-trace.mjs` — new flags `--tier`, `--tier-reasoning`,
  `--eli16-path`, `--side-effects-path`; `--spec` optional when `--tier 1`. Undeclared
  traces round-trip byte-identically to the legacy shape.

**Files changed (tests, not in-scope):**
- `tests/unit/classify-tier.test.ts` (NEW, 47) — size boundaries, every risk signal incl.
  fleet-rollout, `max(size,risk)`, never-3, config-hint-gated new-capability.
- `tests/unit/write-trace-tier.test.ts` (NEW, 5) — Tier-1/Tier-2/no-tier trace round-trips,
  side-effects-path default, missing-ELI16 rejection.
- `tests/unit/instar-dev-precommit-deferrals.test.ts` — named back-compat regression
  (no-tier trace + approved spec passes the full Tier-2 path) + audit-line shape (incl.
  `riskFloor`). `-sha-error.test.ts` — sandbox updated for the new static import.

## Blast radius

Additive and back-compatible. The classifier is pure (no I/O). The gate gains two new
steps (3.5 signal print, 4.5 tier routing + audit) **before** the existing Steps 5–8,
which are unchanged for Tier-2/no-tier. The default (no `tier` in trace) selects the exact
current requirement set — verified by the named back-compat regression test. The only new
relaxation is the Tier-1 path, still requiring ELI16 + side-effects. The risk floor is a
loud, audited signal (`belowFloor`), never a silent downgrade; the audit is a learning
signal, not a security boundary (PR review + the auto-merge spot-check are the human
gates). New runtime cost: one `git diff --cached --numstat` + one classify call + one
appended JSONL line per in-scope commit.

## Risks considered

- **Tier-1 as a loophole?** The agent declares its own tier; a risk change that evades the
  heuristic globs isn't flagged `belowFloor`. Mitigation (documented in the spec §4): the
  PR is the review surface for every Tier-1, the auto-merge operator spot-check is the
  human gate, and `belowFloor` rates are reviewed on a cadence (Close the Loop) so blind
  spots surface and the risk list grows.
- **Breaking existing commits?** No — `no-tier → Tier-2` is byte-identical to today; named
  regression test guards it.
- **Leaking sensitive data?** No — the audit records tiers, reasons, file counts, LOC; no
  content.

## Migration parity

`instar-dev-precommit.js` + `write-trace.mjs` ship in the instar repo for agents
*developing* instar; they are not installed into arbitrary agent homes by `init`. No
`PostUpdateMigrator` change for end agents. The instar-dev skill awareness update is a
later project step (Step C).

## Tests / lint

`npx tsc --noEmit` exit 0; Step-A unit tests green (`classify-tier` 47, `write-trace-tier`
5, gate `-deferrals`/`-sha-error` 13/1). Note: the worktree's full unit suite shows 28
**pre-existing** failures (TunnelManager, watchdog-bind-probe, serendipity-capture,
esm-compliance, no-silent-fallbacks) that fail **identically with and without** this change
(verified by stash-test) — local-environment/harness/lint artifacts (real config + tunnel
reachability + node v25.6.1), independent of Step A and green in clean CI.

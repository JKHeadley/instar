# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The instar-dev commit gate now computes a **tier signal** (size + risk) for each staged
change and prints it, the developing agent **declares** the tier in its trace, and the
gate enforces the **chosen** tier's requirement set — adding a lighter **Tier-1 path**
(ELI16 + side-effects, no pre-approved converged spec) for small, low-risk changes. Every
decision is recorded to `.instar/instar-dev-decisions.jsonl`. This is Step A of the
tiered-development project and the first executable instance of the constitution's
**The Body and the Mind**: the gate *informs*, the agent *decides*, the decision is
*audited*.

## What to Tell Your User

Nothing to do — this only affects how the agent commits changes to instar itself. Small
changes now move through a lighter lane (overview + side-effects note), bigger changes
still get the full spec. The agent's tier choice and the gate's suggestion are logged.

## Summary of New Capabilities

- `scripts/lib/classify-tier.mjs` — pure tier classifier (size + risk → suggested tier).
- `instar-dev-precommit.js` — prints the tier signal, routes by the declared tier, audits
  the decision; Tier-1 path requires ELI16 + side-effects (no converged spec). No declared
  tier → the existing Tier-2 requirement set, byte-for-byte (back-compat).
- `write-trace.mjs` — `--tier`, `--tier-reasoning`, `--eli16-path`, `--side-effects-path`
  flags; `--spec` optional when `--tier 1`.

## Evidence

- `npx tsc --noEmit` exit 0; Step-A unit tests green (classify-tier 47, write-trace-tier 5,
  gate -deferrals/-sha-error 13/1), including a named no-tier back-compat regression and
  the audit-line shape (with `riskFloor`).
- This very commit dogfoods the change: it is declared **Tier 2** in its own trace.

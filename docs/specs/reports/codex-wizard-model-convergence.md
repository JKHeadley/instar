# Convergence Report — Wizard codex spawn model pin

## ELI10 Overview

Yesterday's v1.2.1 added a "Which AI runtime?" prompt when you type
`npx instar`. First end-to-end test of the Codex side failed
immediately because instar wasn't telling Codex which model to use,
so Codex picked its default — and that default was retired from
ChatGPT subscription accounts back in April. The wizard never
rendered.

The fix pins the model to one that works on ChatGPT subscription
accounts (`gpt-5.3-codex`). The codebase already has an empirically-
probed availability table; the wizard just wasn't using it. A canary
test in the unit suite refuses any future PR that removes the
`-m` flag from a Codex spawn in setup.ts.

The fix is small (one constant, two argv slots, one test), strictly
additive (no behavior change for API-key users or Claude users), and
scoped to the wizard launch + secret-setup spawn — every Codex spawn
in setup.ts.

## Original vs Converged

The fix went straight to the right shape. Two design alternatives
were considered and rejected during single-iteration self-review:

1. **Import TIER_TO_MODEL from the adapter** instead of duplicating
   the model name as a constant in setup.ts. Rejected because
   setup.ts has no other dependency on the openai-codex adapter,
   and adding the import couples two modules for one string.
   Drift risk is small (canary catches missing flag) and the
   deployed-user error rate already trains us to keep both sources
   updated.

2. **Probe the user's auth before launching the wizard** (run
   `codex exec -m gpt-5.3-codex "echo ok"` and refuse to launch if
   it fails). Useful as a follow-up but out of scope for this
   hotfix. The canary catches the "wizard spawn missing flag"
   class of bug; an auth-probe catches the "model retired in this
   region/account" class, which is a different failure mode.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self                  | 0 (fix matches root cause) | none |

## Full Findings Catalog

**Finding 1 — Codex CLI default model rejected on ChatGPT subscription.**

- Severity: high (broken-from-the-jump for primary audience).
- Resolution: pin `-m gpt-5.3-codex` on every codex spawn in
  setup.ts.
- Source: `src/providers/adapters/openai-codex/models.ts` already
  records `gpt-5.2-codex` (Codex CLI's default) as API-only since
  2026-04-14. The wizard just didn't apply that knowledge.

**Finding 2 — Two spawns affected, not just the wizard.**

- The setup-wizard launch AND the secret-setup micro-session both
  call `codex exec` without `-m`. Both need the flag.
- Resolution: argv update in both code paths in setup.ts.

**Finding 3 — Canary test needed to prevent regression.**

- The reason the bug shipped was that the wizard spawn was never
  exercised in CI against a ChatGPT-subscription auth posture.
- Resolution: `tests/unit/setup-codex-model-canary.test.ts`
  AST-greps every `framework === 'codex-cli'` exec block in
  setup.ts and asserts each contains `-m WIZARD_CODEX_MODEL`. If a
  future PR adds a third codex spawn or removes the flag from
  either existing one, the test fails in CI.

## Convergence verdict

Converged at iteration 1. Single-constant fix; structural canary
test; existing primitives only. Spec is ready.

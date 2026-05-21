# Convergence Report — Setup wizard always runs on Claude

## ELI10 Overview

A few releases back I added a "Which AI runtime?" prompt to `npx
instar`. Yesterday's first real Codex install path test hit a model-
selection bug, fixed in v1.2.11. The next test confirmed Codex spawned
with the right model — but ignored the wizard skill's "be
conversational, wait for the user" rules entirely. Codex treated the
skill as a task description and ran the whole setup non-interactively,
leaving the user with a generic agent identity they never got to
shape.

This PR routes the setup wizard through Claude unconditionally,
regardless of which runtime the user picks for their agent. The
agent's runtime is unchanged (a Codex agent stays a Codex agent); only
the conversational onboarding tool is forced to the one that reliably
honors conversational instructions.

The fix is small: two argv ternaries collapse to constants, one
binary-selection ternary collapses to a const with a refusal upstream,
the canary test from PR #299 inverts (no codex spawns instead of
codex-spawns-with-model-flag). Trivial rollback.

## Original vs Converged

The fix went straight to the right shape. Two alternatives were
considered and rejected during single-iteration self-review:

1. **Patch the wizard SKILL.md with more aggressive PAUSE-HERE
   markers** — rejected because Codex routinely ignores those too.
   The training pull toward execution can't be reliably overridden
   with prompt text.

2. **Build a Codex-only wizard as a separate state-machine driver**
   — rejected as scope. Today's failure mode is "Codex doesn't honor
   the wizard skill", and Claude is already required at install time
   (`ensurePrerequisites` checks it unconditionally). Using Claude
   for the wizard is the smallest possible fix. A Codex-only wizard
   becomes worth building if/when a user reports needing instar on a
   host without Claude installed.

3. **Keep `WIZARD_CODEX_MODEL` constant exported** — accepted. The
   constant was just shipped in v1.2.10 as public API. Removing it
   in the next patch release would be SemVer-affecting for no
   incremental win. Future PR can drop it on a minor bump.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self                  | 0 (fix matches root cause) | none |

## Full Findings Catalog

**Finding 1 — Codex doesn't follow the wizard's conversational
contract.**

- Severity: high (broken UX for the primary Codex-runtime audience).
- Resolution: route wizard to Claude unconditionally.
- Source: end-to-end log from the v1.2.11 install on instar-codey
  (`/Users/justin/Documents/Projects/instar-codey/setup-logs.md`).
  Codex executed `npx instar init`, `npx instar user add`, `npx
  instar server start`, `npx instar autostart install`, `npx instar
  status` without asking the user any of the wizard's identity
  questions.

**Finding 2 — Same bug applies to the secret-setup micro-session.**

- Both setup.ts spawns were ternary on `framework`. Same root cause,
  same fix needed.
- Resolution: collapse both ternaries to the unconditional Claude
  form.

**Finding 3 — PR #299's canary needs to invert.**

- The previous canary asserted every codex exec block in setup.ts
  passes `-m WIZARD_CODEX_MODEL`. With no codex exec blocks
  remaining, that assertion becomes vacuous.
- Resolution: invert the canary to assert NO codex exec blocks in
  setup.ts (the wizard always uses Claude). The
  `WIZARD_CODEX_MODEL`-validity test remains as a public-API
  contract.

## Convergence verdict

Converged at iteration 1. Two-line binary-selection change in
setup.ts; canary inverted; no new abstraction or authority.
Spec is ready.

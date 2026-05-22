# Upgrade Guide — v1.2.16 (welcome banner is framework-aware)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: welcome banner shows the correct runtime name + sandbox flag.**

Before: after picking "Codex CLI" at the bareword runtime prompt,
the wizard's welcome banner still said "Instar runs Claude Code
with --dangerously-skip-permissions." The banner was hardcoded and
ignored the framework choice.

After: the banner branches on the resolved `framework` value and
shows the matching runtime + sandbox flag. Codex installs see
"Instar runs Codex CLI with --dangerously-bypass-approvals-and-
sandbox." Claude installs see the line they always saw.

Cosmetic but trust-eroding — first sentence of the wizard
disagreed with the user's just-made selection.

Spec: `specs/dev-infrastructure/banner-framework-aware.md`.
ELI16: `specs/dev-infrastructure/banner-framework-aware.eli16.md`.
Side-effects: `upgrades/side-effects/fix-banner-framework-aware.md`.

## What to Tell Your User

The first warning line of the setup wizard now matches the runtime
you actually picked.

## Summary of New Capabilities

No new capabilities. Cosmetic correctness fix.

## Evidence

Reproduction prior: v1.2.15 install on instar-codey, picked Codex,
banner read "Instar runs Claude Code…" — visible in Justin's
17:38 PDT log excerpt.

After fix: 4 unit canary tests cover both branches and the
template-interpolation shape.

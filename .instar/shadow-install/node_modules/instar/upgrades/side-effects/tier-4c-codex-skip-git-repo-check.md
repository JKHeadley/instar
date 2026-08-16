# Side-effects review — Tier 4.C Codex non-git directory fix (release blocker)

**Version / slug:** `tier-4c-codex-skip-git-repo-check`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (single-flag addition; surfaced and verified by end-to-end smoke test that previously failed silently)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`

## Summary of the change

End-to-end smoke testing of `instar route` with `INSTAR_FRAMEWORK=codex-cli` produced silent classification failures (`taskPattern: "unclassified"`, `source: "auto-defaulted-unclassified"`) every time the state directory wasn't a git checkout. Investigation traced it to Codex CLI's pre-flight check:

```
Not inside a trusted directory and --skip-git-repo-check was not specified.
```

Codex refuses to run with `--cd <dir>` when `<dir>` isn't inside a git repo. Every `.instar/` state directory in a non-git project, every `/tmp/` smoke test, every CI test fixture would hit this. The provider silently returned the error to the caller, who fell back to UNCLASSIFIED — masking the failure as "low-confidence routing" rather than "Codex is broken on this machine."

Fix: add `--skip-git-repo-check` to the `codex exec` arg list in `CodexCliIntelligenceProvider`. These calls are short deterministic reviewer / sentinel / canary prompts that don't depend on the cwd content; the git-trust check Codex does is for interactive coding sessions, not headless evaluation.

This is a release blocker for morning testing — without it, every Codex-based agent on every non-git directory was silently degraded.

Files touched:
- `src/core/CodexCliIntelligenceProvider.ts` — added `'--skip-git-repo-check'` to the args array, with a comment explaining why.
- `tests/unit/CodexCliIntelligenceProvider.test.ts` — new, 5 tests; uses a tiny fake-codex shell script (echoes its argv) so the test asserts the exact spawn args without needing real codex installed.

## Decision-point inventory

- **Pass `--skip-git-repo-check` always vs conditionally** — `add`
  (always). Reviewers/sentinels/canaries never depend on cwd-as-git.
  Making the flag conditional ("only when the dir isn't a repo") adds
  a stat() call and a branch for no benefit — Codex still does its own
  check, and our calls genuinely don't care. Symmetry with how the
  ClaudeCli provider doesn't gate on git status either.
- **Surface the failure via tests vs runtime degradation** — `add`
  (tests). The previous behavior — silent UNCLASSIFIED — masked the
  failure. The new fake-codex-script test asserts the exact arg list
  so a future regression (someone drops the flag accidentally) is
  caught at commit time.

## Signal vs authority

This is a control-primitive correctness fix, not a signal/authority
question. The provider's `evaluate()` is the authority for "did the
LLM produce output?" — passing the flag is the correct invocation
shape Codex requires for that authority to function in non-git dirs.

## Over-block / under-block analysis

**Over-block:** None. The flag is purely a permission grant; Codex's
sandbox setting (`--sandbox read-only` by default) still restricts
what the spawned process can do. The flag just disables a pre-flight
refusal that doesn't apply to our usage pattern.

**Under-block:** None. The flag's purpose is to permit running in
non-git dirs. The sandbox mode is unchanged.

## Level-of-abstraction fit

- Stays inside `CodexCliIntelligenceProvider` — single-flag change in
  the spawn arg list. No new abstraction needed.
- Comment in the provider documents WHY the flag is on (specifically
  references the failure mode it fixes), so a future reader doesn't
  drop the flag thinking "this seems risky."

## Interactions

- **Every IntelligenceProvider consumer on Codex** (reviewer,
  sentinel, canary, classifier, override detector, route CLI) —
  now actually returns Codex output instead of silent errors.
  Behavior change: positive. No interface change.
- **`ClaudeCliIntelligenceProvider`** — not modified. Claude Code
  doesn't have an equivalent git-trust gate.

## External surfaces

- No new endpoints.
- No new environment variables.
- No new config keys.
- Behavior change on the wire: every `codex exec` invocation now
  includes one additional flag. Visible only to anyone trace-
  capturing the spawn args.

## Rollback cost

Trivial. `git revert` restores the prior arg list. State-shape and
public interfaces are unchanged.

## Tests / verification

- `npx tsc --noEmit` clean.
- New unit tests: `tests/unit/CodexCliIntelligenceProvider.test.ts` —
  5 tests covering:
  - `--skip-git-repo-check` is always present.
  - Full arg ordering: `exec`, `--model`, `--sandbox`, `--cd`, `--skip-git-repo-check`, then positional prompt.
  - Custom sandbox mode honored.
  - Stdout trim contract.
  - Non-zero exit produces a wrapped `Codex CLI error: …`.
- End-to-end smoke verification (`INSTAR_FRAMEWORK=codex-cli node
  dist/cli.js route "refactor python helper" --dir /tmp/codex-smoke-2 --json`):
  - Before: `taskPattern: "unclassified"`, `source: "auto-defaulted-unclassified"`, 0.8s wall-clock (failed in 0ms internal time).
  - After: `taskPattern: "code-refactor-python"`, `source: "auto-defaulted-no-topic"`, ~4-5s wall-clock (real Codex call).
- This reproduces the bug-fix evidence bar: failure mode reproduced
  in dev BEFORE the fix; same invocation produces the corrected
  outcome AFTER.

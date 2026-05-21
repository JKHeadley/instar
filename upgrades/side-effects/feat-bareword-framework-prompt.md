# Side-effects review — Bareword framework prompt

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER — bareword `npx instar` had no path to Codex-only setup
even with the underlying machinery in place. After: no over-block.
Subcommand explicit-flag path unchanged; non-TTY default unchanged. Only
the bareword on an interactive terminal gains the prompt.

## 2. Level-of-abstraction fit

Pure decision in `resolveFrameworkPromptBehavior` (exported, testable);
side-effectful readline interaction in `promptForFramework` (private to
setup.ts, only called when the decision says "prompt"). The wizard flow
itself is untouched; the resolved framework value flows into the same
existing `checkFrameworkPrerequisite` call.

## 3. Signal vs Authority compliance

The `--framework` flag (when present) and the prompt answer (when
prompted) are SIGNALS of operator intent. The existing
`checkFrameworkPrerequisite` is the single AUTHORITY for "is the chosen
runtime's binary present." The prompt's auto-skip-when-only-one-installed
behavior uses detection results from `detectClaudePath` /
`detectCodexPath`, which are the existing single source of truth.

## 4. Interactions with adjacent systems

- **Explicit `--framework` flag on subcommands** (PRs 3+4 + #276) —
  unchanged. When the flag is set, the prompt is skipped entirely (the
  decision is `opts.framework ?? prompt`).
- **Non-interactive `runNonInteractiveSetup`** — unchanged. That entry
  point doesn't go through `runSetup` and never triggers the prompt.
- **`checkFrameworkPrerequisite`** — unchanged. Consumes the resolved
  framework string regardless of whether it came from a flag or the
  prompt.
- **CI runs (no TTY)** — unchanged. `process.stdin.isTTY` is false in
  CI, so the prompt is bypassed and the default Claude Code behavior
  preserved.

## 5. Rollback cost

Trivial. One readline-using function added, one decision helper added,
one conditional in `runSetup`'s opening lines. `git revert` restores
the pre-prompt bareword behavior; subcommand and CI flows unaffected.

## 6. Backwards compatibility / drift surface

Fully backward-compatible. Default behavior on non-TTY paths is
unchanged. Subcommand behavior is unchanged. Only interactive bareword
gets the new UX. Drift surface: none — the decision is centralized in
one pure exported function.

## 7. Authorization / Trust posture

No new authority. The prompt reads stdin and returns a string;
`checkFrameworkPrerequisite` and the rest of the existing wizard chain
handle everything downstream as they did before.

## Outcome

Ship. Closes the install/wizard portability arc's last UX gap. Pure
decision logic unit-tested; readline I/O verified by Justin's manual
end-to-end after merge.

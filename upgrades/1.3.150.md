---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; live-found driving Codey)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — the scope-check Stop hook no longer confuses Codex

When an agent finishes a turn, a "scope-coherence checkpoint" Stop hook runs and, on
the normal allow path, used to print a tiny `{decision:approve}` message. Claude
treats that as allow, but Codex's Stop-hook contract is stricter: print
`{decision:block,...}` to interrupt, print **nothing** to allow — an explicit
approve message is rejected as "invalid stop hook JSON output". So on every Codex
session completion that hook reported an error (the reply was already sent, so
nothing actually broke, but the error was noisy and wrong). Found live while
test-driving the Codex agent.

The fix changes every allow path to emit nothing (empty stdout = allow), which is
byte-equivalent for Claude and removes the error for Codex. The interrupt (block)
path is unchanged. The hook is regenerated from source on every update, so all
agents get the fix automatically.

## Summary of New Capabilities

- `scope-coherence-checkpoint` Stop hook is now Codex-stdout-safe: allow paths emit
  empty stdout (instead of `{decision:approve}`); the block/checkpoint path is
  unchanged. Sibling of the earlier autonomous-stop-hook Codex fix.

## What to Tell Your User

If you run a Codex-based agent, it will stop logging a spurious "invalid stop hook"
error every time it finishes a turn. Nothing actually broke before (replies still
went out), and Claude agents are unaffected — this just makes the scope-check hook
speak Codex's dialect correctly. It applies automatically on the next update.

## Evidence

- Live: driving the Codex agent over Telegram, it completed a task + sent its reply,
  then its session reported "Stop hook (failed) — invalid stop hook JSON output".
- Audited the 5-hook Stop chain: only scope-coherence-checkpoint writes on the allow
  path; the others write only on block (codex-safe), and the autonomous hook was
  fixed earlier.
- Unit: `tests/unit/scope-coherence-reentry.test.ts` — allow paths now exit 0 with
  empty stdout; the generated hook contains no `{decision:approve}` and keeps
  `{decision:block}`.
- Regression: PostUpdateMigrator-buildStopHook + migration-parity-hooks +
  installCodexHooks — 28 tests pass.
- `tsc --noEmit` + `npm run lint` clean.
- Spec: `docs/specs/codex-scope-coherence-stdout-safe.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/codex-scope-coherence-stdout-safe.md`.
